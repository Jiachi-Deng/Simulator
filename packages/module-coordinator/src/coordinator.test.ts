import { afterEach, describe, expect, it } from 'bun:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { parseModuleManifest, type ModuleId, type ModuleManifest, type ModuleSha256 } from '@simulator/module-contract'
import { ModuleDaemonManager } from '@simulator/module-daemon'
import { FakeClock, FakeHealthAdapter, FakeProcessAdapter } from '@simulator/module-daemon/testing'
import { ModuleDownloader, NodeFilesystemModuleDownloaderCache } from '@simulator/module-downloader'
import { memoryResponse, ManualClock } from '@simulator/module-downloader/testing'
import { ModuleInstaller } from '@simulator/module-installer'
import { ModuleRegistry } from '@simulator/module-registry'
import { encodeCanonicalCatalog, type TrustedReleaseKey } from '@simulator/module-release-trust'
import { ModuleCoordinator } from './coordinator.ts'
import { SimulatedCoordinatorCrash, type ModuleCoordinatorCheckpoint, type ModuleCoordinatorState } from './types.ts'
import { ModuleRuntimeUseGate } from './usage-gate.ts'
import { InMemoryModuleCoordinatorStore } from './testing/memory-store.ts'

const NOW = Date.parse('2026-07-12T18:00:00.000Z')
const MODULE_ID = 'org.simulator.packaged-fake'
const CATALOG_URL = 'https://modules.example.test/catalog.json'
const ARTIFACT_URL = 'https://modules.example.test/packaged-fake.tar.gz'
const roots: string[] = []

function sha256(value: Uint8Array | string): ModuleSha256 {
  return createHash('sha256').update(value).digest('hex') as ModuleSha256
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  buffer.write(value.toString(8).padStart(length - 1, '0'), offset, length - 1, 'ascii')
  buffer[offset + length - 1] = 0
}

function tarEntry(path: string, type: '0' | '5', mode: number, content = ''): Buffer {
  const body = Buffer.from(content)
  const header = Buffer.alloc(512)
  Buffer.from(path).copy(header)
  writeOctal(header, 100, 8, mode)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, body.byteLength)
  writeOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  header.write(type, 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0'), 148, 6, 'ascii')
  header[154] = 0
  header[155] = 0x20
  const padding = Buffer.alloc((512 - (body.byteLength % 512)) % 512)
  return Buffer.concat([header, body, padding])
}

function packagedFakeArchive(): { readonly archive: Buffer; readonly treeHash: ModuleSha256 } {
  const executable = '#!/bin/sh\nexit 0\n'
  const data = 'packaged fake module\n'
  const archive = gzipSync(Buffer.concat([
    tarEntry('module/', '5', 0o755),
    tarEntry('module/bin/', '5', 0o755),
    tarEntry('module/bin/module', '0', 0o755, executable),
    tarEntry('module/data.txt', '0', 0o644, data),
    Buffer.alloc(1024),
  ]))
  const records = [
    `D\t${JSON.stringify('bin')}`,
    `F\t${JSON.stringify('bin/module')}\t${Buffer.byteLength(executable)}\t1\t${sha256(executable)}`,
    `F\t${JSON.stringify('data.txt')}\t${Buffer.byteLength(data)}\t0\t${sha256(data)}`,
  ]
  return { archive, treeHash: sha256(`${records.join('\n')}\n`) }
}

function manifest(version: string, archiveHash: ModuleSha256): ModuleManifest {
  const parsed = parseModuleManifest({
    schemaVersion: 1,
    id: MODULE_ID,
    version,
    artifacts: [{
      platform: 'darwin-arm64', entrypoint: 'bin/module', url: ARTIFACT_URL, sha256: archiveHash,
    }],
    capabilities: ['workspace.read'],
  })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
  return parsed.value
}

class FixtureFetch {
  catalogRequests = 0
  artifactRequests = 0

  constructor(readonly wireBytes: Uint8Array, readonly archive: Uint8Array) {}

  async fetch(request: { readonly url: string }) {
    if (request.url === CATALOG_URL) {
      this.catalogRequests += 1
      if (this.catalogRequests === 1) {
        return memoryResponse({
          url: CATALOG_URL,
          headers: { 'content-length': String(this.wireBytes.byteLength), etag: '"packaged-fake-v1"' },
          chunks: [this.wireBytes],
        })
      }
      return memoryResponse({ status: 304, url: CATALOG_URL })
    }
    if (request.url === ARTIFACT_URL) {
      this.artifactRequests += 1
      return memoryResponse({
        url: ARTIFACT_URL,
        headers: { 'content-length': String(this.archive.byteLength), etag: '"artifact-v1"' },
        chunks: [this.archive],
      })
    }
    throw new Error(`Unexpected request: ${request.url}`)
  }
}

interface System {
  readonly coordinator: ModuleCoordinator
  readonly store: InMemoryModuleCoordinatorStore
  readonly process: FakeProcessAdapter
  readonly clock: FakeClock
  readonly registry: ModuleRegistry
  requestFor(version: string): Parameters<ModuleCoordinator['install']>[0]
}

async function createSystem(store = new InMemoryModuleCoordinatorStore()): Promise<System> {
  const root = await mkdtemp(join(tmpdir(), 'simulator-module-coordinator-'))
  roots.push(root)
  const { archive, treeHash } = packagedFakeArchive()
  const archiveHash = sha256(archive)
  const versions = ['1.0.0', '2.0.0', '3.0.0']
  const releases = versions.map((version) => ({
    manifest: manifest(version, archiveHash),
    artifactSizes: [{ platform: 'darwin-arm64' as const, size: archive.byteLength }],
  }))
  const pair = generateKeyPairSync('ed25519')
  const publicDer = pair.publicKey.export({ format: 'der', type: 'spki' })
  const key: TrustedReleaseKey = {
    keyId: 'packaged-fake',
    publicKey: Uint8Array.from(publicDer.subarray(publicDer.byteLength - 32)),
    activeFrom: '2026-07-12T00:00:00.000Z',
  }
  const catalogBytes = encodeCanonicalCatalog({
    schemaVersion: 1,
    sequence: 1,
    issuedAt: '2026-07-12T17:00:00.000Z',
    expiresAt: '2026-07-13T17:00:00.000Z',
    releases,
  })
  const wireBytes = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    keyId: key.keyId,
    catalogBytes: Buffer.from(catalogBytes).toString('base64'),
    signature: Buffer.from(sign(null, catalogBytes, pair.privateKey)).toString('base64'),
  }))
  const fetch = new FixtureFetch(wireBytes, archive)
  const cacheRoot = join(root, 'cache')
  const downloader = new ModuleDownloader({
    fetch,
    cache: new NodeFilesystemModuleDownloaderCache(cacheRoot),
    clock: new ManualClock(NOW),
    trustedKeys: [key],
    retry: { maxAttempts: 1 },
  })
  const useGate = new ModuleRuntimeUseGate()
  const moduleRoot = join(root, 'installed')
  const installer = new ModuleInstaller(moduleRoot, { usageGuard: useGate })
  const registry = new ModuleRegistry({ version: '0.11.1', platform: 'darwin-arm64' })
  const clock = new FakeClock()
  const process = new FakeProcessAdapter()
  const daemon = new ModuleDaemonManager({
    process,
    clock,
    health: new FakeHealthAdapter(),
    restartBackoffMs: [1],
    healthIntervalMs: 60_000,
  })
  const coordinator = new ModuleCoordinator({
    downloader,
    installer,
    registry,
    daemon,
    platform: 'darwin-arm64',
    store,
    archiveLocator: { locate: async (hash) => join(cacheRoot, 'artifacts', hash, 'artifact.bin') },
    activationLocator: { locate: async (id, version) => join(moduleRoot, 'modules', id, 'versions', version) },
    now: () => NOW,
  })
  const requestFor = (version: string) => ({
    catalogUrl: CATALOG_URL,
    descriptor: {
      verified: true as const,
      manifest: releases.find((release) => release.manifest.version === version)!.manifest,
      artifact: releases.find((release) => release.manifest.version === version)!.manifest.artifacts[0]!,
      extractedManifestSha256: treeHash,
      format: 'tar.gz' as const,
    },
    hostVersionRange: '*',
  })
  return { coordinator, store, process, clock, registry, requestFor }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('ModuleCoordinator packaged fake module E2E', () => {
  it('runs install, update, crash restart, stop, rollback, and uninstall through existing module APIs', async () => {
    const system = await createSystem()
    await system.coordinator.install(system.requestFor('1.0.0'))
    await system.coordinator.start(MODULE_ID as Parameters<ModuleCoordinator['start']>[0])
    expect(system.process.processes).toHaveLength(1)

    system.process.processes[0]!.crash()
    for (let index = 0; index < 8 && system.process.processes.length < 2; index += 1) {
      await Promise.resolve()
      await system.clock.advance(1)
    }
    expect(system.process.processes).toHaveLength(2)
    await system.coordinator.stop(MODULE_ID as Parameters<ModuleCoordinator['stop']>[0])

    await system.coordinator.update(system.requestFor('2.0.0'))
    await system.coordinator.update(system.requestFor('3.0.0'))
    await system.coordinator.uninstall({ moduleId: MODULE_ID as Parameters<ModuleCoordinator['start']>[0], version: '1.0.0' as never })
    await system.coordinator.rollback(MODULE_ID as Parameters<ModuleCoordinator['start']>[0])
    expect(system.registry.snapshot().modules[0]).toMatchObject({ activeVersion: '2.0.0', lastKnownGoodVersion: '3.0.0' })
    await system.coordinator.stop(MODULE_ID as Parameters<ModuleCoordinator['stop']>[0])

    const snapshot = await system.coordinator.snapshot()
    expect(snapshot.operations.map((operation) => operation.kind)).toEqual([
      'install', 'start', 'stop', 'update', 'update', 'uninstall', 'rollback', 'stop',
    ])
    expect(snapshot.operations.every((operation) => operation.status === 'completed')).toBe(true)
    expect(snapshot.events.some((event) => event.snapshot.state === 'crashed')).toBe(true)
  })
})

class CrashAfterCheckpointStore extends InMemoryModuleCoordinatorStore {
  fired = false

  constructor(private readonly checkpoint: ModuleCoordinatorCheckpoint) {
    super()
  }

  override async save(state: ModuleCoordinatorState): Promise<void> {
    await super.save(state)
    if (!this.fired && state.operations.some((operation) => operation.status === 'pending' && operation.checkpoint === this.checkpoint)) {
      this.fired = true
      throw new SimulatedCoordinatorCrash(this.checkpoint)
    }
  }
}

describe('ModuleCoordinator durable checkpoint recovery', () => {
  for (const checkpoint of [
    'intent-recorded', 'catalog-verified', 'artifact-downloaded', 'installed', 'registered', 'activated',
  ] as const) {
    it(`replays the packaged fake install after crash at ${checkpoint}`, async () => {
      const store = new CrashAfterCheckpointStore(checkpoint)
      const first = await createSystem(store)
      await expect(first.coordinator.install(first.requestFor('1.0.0'))).rejects.toBeInstanceOf(SimulatedCoordinatorCrash)
      const restarted = await createSystem(store)
      await restarted.coordinator.recover()
      const snapshot = await restarted.coordinator.snapshot()
      expect(snapshot.operations).toHaveLength(1)
      expect(snapshot.operations[0]).toMatchObject({ status: 'completed', checkpoint: 'completed' })
      expect(restarted.registry.snapshot().modules[0]).toMatchObject({ activeVersion: '1.0.0' })
    })
  }
})

class BlockingDaemon {
  readonly calls: ModuleId[] = []
  readonly #waiters = new Map<ModuleId, Array<() => void>>()

  async start(): Promise<never> {
    throw new Error('start is not used by scheduler coverage')
  }

  async stop(moduleId: ModuleId): Promise<undefined> {
    this.calls.push(moduleId)
    await new Promise<void>((resolve) => {
      const waiters = this.#waiters.get(moduleId) ?? []
      waiters.push(resolve)
      this.#waiters.set(moduleId, waiters)
    })
    return undefined
  }

  get(): undefined {
    return undefined
  }

  subscribe(): () => void {
    return () => undefined
  }

  release(moduleId: ModuleId): void {
    const waiter = this.#waiters.get(moduleId)?.shift()
    if (!waiter) throw new Error(`No blocked daemon stop for ${moduleId}`)
    waiter()
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await Bun.sleep(1)
  }
  throw new Error('Timed out waiting for coordinator scheduler')
}

describe('ModuleCoordinator scheduler', () => {
  it('serializes each module while allowing unrelated module operations to progress', async () => {
    const daemon = new BlockingDaemon()
    const coordinator = new ModuleCoordinator({
      downloader: {} as never,
      installer: { recoverAll: async () => undefined } as never,
      registry: new ModuleRegistry({ version: '0.11.1', platform: 'darwin-arm64' }),
      daemon: daemon as never,
      platform: 'darwin-arm64',
      store: new InMemoryModuleCoordinatorStore(),
      archiveLocator: { locate: async () => '' },
      activationLocator: { locate: async () => '' },
    })
    const left = 'org.simulator.serial-left' as ModuleId
    const right = 'org.simulator.parallel-right' as ModuleId

    const first = coordinator.stop(left)
    await waitFor(() => daemon.calls.length === 1)
    const second = coordinator.stop(left)
    const independent = coordinator.stop(right)
    await waitFor(() => daemon.calls.length === 2)
    expect(daemon.calls).toEqual([left, right])

    daemon.release(right)
    await independent
    expect(daemon.calls).toEqual([left, right])
    daemon.release(left)
    await first
    await waitFor(() => daemon.calls.length === 3)
    expect(daemon.calls).toEqual([left, right, left])
    daemon.release(left)
    await second
  })
})
