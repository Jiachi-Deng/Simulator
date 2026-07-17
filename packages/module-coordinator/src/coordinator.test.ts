import { afterEach, describe, expect, it } from 'bun:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { parseModuleManifest, type ModuleId, type ModuleManifest, type ModuleSha256, type ModuleVersion } from '@simulator/module-contract'
import { ModuleDaemonManager } from '@simulator/module-daemon'
import { FakeClock, FakeHealthAdapter, FakeProcessAdapter } from '@simulator/module-daemon/testing'
import { ModuleDownloader, NodeFilesystemModuleDownloaderCache } from '@simulator/module-downloader'
import { memoryResponse, ManualClock } from '@simulator/module-downloader/testing'
import { ModuleInstaller } from '@simulator/module-installer'
import { ModuleRegistry } from '@simulator/module-registry'
import { FilesystemModuleRegistryPersistence } from '@simulator/module-registry/filesystem'
import { encodeCanonicalCatalog, type TrustedReleaseKey } from '@simulator/module-release-trust'
import { ModuleCoordinator } from './coordinator.ts'
import { NodeFilesystemModuleCoordinatorStore } from './node-store.ts'
import { SimulatedCoordinatorCrash, type ModuleCoordinatorCheckpoint, type ModuleCoordinatorDependencies, type ModuleCoordinatorFaultPoint, type ModuleCoordinatorState, type ModuleCoordinatorStore, type ModuleViewSnapshot } from './types.ts'
import { ModuleRuntimeUseGate } from './usage-gate.ts'
import { InMemoryModuleCoordinatorStore } from './testing/memory-store.ts'

// These are outer test watchdogs, not product deadlines. Windows CI performs
// substantially slower real filesystem identity/link operations; keep the
// operation assertions identical while allowing their cleanup to finish before
// Bun starts afterEach and removes the trusted root.
const CRASH_MATRIX_TEST_TIMEOUT_MS = process.platform === 'win32' ? 30_000 : 15_000

const NOW = Date.parse('2026-07-12T18:00:00.000Z')
const MODULE_ID = 'org.simulator.packaged-fake'
const CATALOG_URL = 'https://modules.example.test/catalog.json'
const ARTIFACT_URL = 'https://modules.example.test/packaged-fake.tar.gz'
const roots: string[] = []
const systems: System[] = []

interface CatalogRevision {
  readonly sequence: number
  readonly issuedAt: string
  readonly expiresAt: string
  readonly artifactSizeDelta?: number
}

const INITIAL_CATALOG_REVISION: CatalogRevision = {
  sequence: 1,
  issuedAt: '2026-07-12T17:00:00.000Z',
  expiresAt: '2026-07-13T17:00:00.000Z',
}

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
  const helper = '#!/bin/sh\nexit 0\n'
  const data = 'packaged fake module\n'
  const archive = gzipSync(Buffer.concat([
    tarEntry('module/', '5', 0o755),
    tarEntry('module/bin/', '5', 0o755),
    tarEntry('module/bin/module', '0', 0o755, executable),
    tarEntry('module/bin/helper', '0', 0o755, helper),
    tarEntry('module/data.txt', '0', 0o644, data),
    Buffer.alloc(1024),
  ]))
  const records = [
    `D\t${JSON.stringify('bin')}`,
    `F\t${JSON.stringify('bin/helper')}\t${Buffer.byteLength(helper)}\t1\t${sha256(helper)}`,
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
      platform: 'darwin-arm64', entrypoint: 'bin/module', auxiliaryExecutables: ['bin/helper'], url: ARTIFACT_URL, sha256: archiveHash,
    }],
    capabilities: ['workspace.read'],
  })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
  return parsed.value
}

class FixtureFetch {
  catalogRequests = 0
  artifactRequests = 0

  constructor(readonly catalogResponses: readonly Uint8Array[], readonly archive: Uint8Array) {}

  async fetch(request: { readonly url: string }) {
    if (request.url === CATALOG_URL) {
      this.catalogRequests += 1
      const wireBytes = this.catalogResponses[this.catalogRequests - 1]
      if (wireBytes) {
        return memoryResponse({
          url: CATALOG_URL,
          headers: { 'content-length': String(wireBytes.byteLength), etag: `"packaged-fake-v${this.catalogRequests}"` },
          chunks: [wireBytes],
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
  readonly store: ModuleCoordinatorStore
  readonly process: FakeProcessAdapter
  readonly clock: FakeClock
  readonly registry: ModuleRegistry
  readonly view: TestViewPort
  readonly usage: ModuleRuntimeUseGate
  requestFor(version: string): Parameters<ModuleCoordinator['install']>[0]
}

interface PersistentFixture {
  readonly root: string
  readonly treeHash: ModuleSha256
  readonly releases: readonly {
    readonly manifest: ModuleManifest
    readonly artifactSizes: readonly { readonly platform: 'darwin-arm64'; readonly size: number }[]
    readonly hostVersionRange: string
    readonly artifactInstallMetadata: readonly {
      readonly platform: 'darwin-arm64'
      readonly extractedManifestSha256: ModuleSha256
    }[]
  }[]
  readonly key: TrustedReleaseKey
  readonly fetch: FixtureFetch
  readonly store: NodeFilesystemModuleCoordinatorStore
}

class TestViewPort {
  readonly snapshots = new Map<ModuleId, ModuleViewSnapshot>()
  readonly events: string[] = []

  async attach(request: { moduleId: ModuleId; version: ModuleVersion }): Promise<ModuleViewSnapshot> {
    const snapshot = Object.freeze({ moduleId: request.moduleId, version: request.version, state: 'attached' as const })
    this.snapshots.set(request.moduleId, snapshot)
    this.events.push(`attach:${request.version}`)
    return snapshot
  }

  async detach(moduleId: ModuleId): Promise<void> {
    const current = this.snapshots.get(moduleId)
    if (current) this.snapshots.set(moduleId, Object.freeze({ ...current, state: 'detached' }))
    this.events.push(`detach:${moduleId}`)
  }

  async query(moduleId: ModuleId): Promise<ModuleViewSnapshot | undefined> {
    return this.snapshots.get(moduleId)
  }
}

async function createFixture(
  revisions: readonly CatalogRevision[] = [INITIAL_CATALOG_REVISION],
): Promise<PersistentFixture> {
  const root = await mkdtemp(join(tmpdir(), 'simulator-module-coordinator-'))
  roots.push(root)
  const { archive, treeHash } = packagedFakeArchive()
  const archiveHash = sha256(archive)
  const versions = ['1.0.0', '2.0.0', '3.0.0']
  const releases = versions.map((version) => ({
    manifest: manifest(version, archiveHash),
    artifactSizes: [{ platform: 'darwin-arm64' as const, size: archive.byteLength }],
    hostVersionRange: '>=0.11.0 <0.12.0-0',
    artifactInstallMetadata: [{ platform: 'darwin-arm64' as const, extractedManifestSha256: treeHash }],
  }))
  const pair = generateKeyPairSync('ed25519')
  const publicDer = pair.publicKey.export({ format: 'der', type: 'spki' })
  const key: TrustedReleaseKey = {
    keyId: 'packaged-fake',
    publicKey: Uint8Array.from(publicDer.subarray(publicDer.byteLength - 32)),
    activeFrom: '2026-07-12T00:00:00.000Z',
  }
  const catalogResponses = revisions.map((revision) => {
    const catalogBytes = encodeCanonicalCatalog({
      schemaVersion: 2,
      sequence: revision.sequence,
      issuedAt: revision.issuedAt,
      expiresAt: revision.expiresAt,
      releases: releases.map((release) => ({
        ...release,
        artifactSizes: release.artifactSizes.map((artifactSize) => ({
          ...artifactSize,
          size: artifactSize.size + (revision.artifactSizeDelta ?? 0),
        })),
      })),
    })
    return new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1,
      keyId: key.keyId,
      catalogBytes: Buffer.from(catalogBytes).toString('base64'),
      signature: Buffer.from(sign(null, catalogBytes, pair.privateKey)).toString('base64'),
    }))
  })
  const fetch = new FixtureFetch(catalogResponses, archive)
  return {
    root,
    treeHash,
    releases,
    key,
    fetch,
    store: new NodeFilesystemModuleCoordinatorStore(join(root, 'coordinator-state')),
  }
}

async function createSystem(
  input?: PersistentFixture,
  inputStore?: ModuleCoordinatorStore,
  faultInjector?: (point: ModuleCoordinatorFaultPoint) => void | Promise<void>,
  downloaderOverride?: ModuleCoordinatorDependencies['downloader'],
): Promise<System> {
  const fixture = input ?? await createFixture()
  const store = inputStore ?? fixture.store
  const { root, treeHash, releases, key, fetch } = fixture
  const cacheRoot = join(root, 'cache')
  const downloader = downloaderOverride ?? new ModuleDownloader({
    fetch,
    cache: new NodeFilesystemModuleDownloaderCache(cacheRoot),
    clock: new ManualClock(NOW),
    trustedKeys: [key],
    retry: { maxAttempts: 1 },
  })
  const useGate = new ModuleRuntimeUseGate()
  const moduleRoot = join(root, 'installed')
  const installer = new ModuleInstaller(moduleRoot, { usageGuard: useGate })
  const registry = new ModuleRegistry(
    { version: '0.11.1', platform: 'darwin-arm64' },
    new FilesystemModuleRegistryPersistence(join(root, 'registry-state')),
  )
  const clock = new FakeClock()
  const process = new FakeProcessAdapter()
  const daemon = new ModuleDaemonManager({
    process,
    clock,
    health: new FakeHealthAdapter(),
    restartBackoffMs: [1],
    healthIntervalMs: 60_000,
  })
  const view = new TestViewPort()
  const coordinator = new ModuleCoordinator({
    downloader,
    installer,
    registry,
    daemon,
    platform: 'darwin-arm64',
    store,
    archiveLocator: { locate: async (hash) => join(cacheRoot, 'artifacts', hash, 'artifact.bin') },
    activationLocator: {
      locate: async (id, version) => join(moduleRoot, 'modules', id, 'versions', version),
      isInstalled: async (id, version) => lstat(join(moduleRoot, 'modules', id, 'versions', version)).then((info) => info.isDirectory(), () => false),
    },
    view,
    usage: useGate,
    now: () => NOW,
    faultInjector,
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
    hostVersionRange: '>=0.11.0 <0.12.0-0',
  })
  const system = { coordinator, store, process, clock, registry, view, usage: useGate, requestFor }
  systems.push(system)
  return system
}

afterEach(async () => {
  await Promise.all(systems.splice(0).map(async (system) => system.coordinator.dispose()))
  await Bun.sleep(10)
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('ModuleCoordinator packaged fake module E2E', () => {
  it('constructs an install request from the same verified v2 catalog used by the coordinator', async () => {
    const fixture = await createFixture()
    const system = await createSystem(fixture)
    const request = await system.coordinator.resolveInstallRequest({
      catalogUrl: CATALOG_URL,
      moduleId: MODULE_ID as ModuleId,
      version: '1.0.0' as ModuleVersion,
    })

    expect(request).toEqual({
      catalogUrl: CATALOG_URL,
      descriptor: {
        verified: true,
        manifest: fixture.releases[0]!.manifest,
        artifact: fixture.releases[0]!.manifest.artifacts[0]!,
        extractedManifestSha256: fixture.treeHash,
        format: 'tar.gz',
      },
      hostVersionRange: '>=0.11.0 <0.12.0-0',
      catalogEvidence: {
        schemaVersion: 1,
        sequence: 1,
        issuedAt: '2026-07-12T17:00:00.000Z',
        expiresAt: '2026-07-13T17:00:00.000Z',
        artifactSize: fixture.releases[0]!.artifactSizes[0]!.size,
      },
    })
    expect(Object.isFrozen(request)).toBe(true)
    expect(Object.isFrozen(request.catalogEvidence)).toBe(true)
    expect((await system.coordinator.install({ ...request, operationId: 'resolved-install' })).ok).toBe(true)
    // Resolver plus the coordinator's two durable verification checkpoints all
    // use the same downloader/cache; only the first request carries catalog bytes.
    expect(fixture.fetch.catalogRequests).toBe(3)
    expect(fixture.fetch.artifactRequests).toBe(1)
  })

  it('rejects an install request whose signed v2 tree hash or host range was changed after resolution', async () => {
    const fixture = await createFixture()
    const system = await createSystem(fixture)
    const request = await system.coordinator.resolveInstallRequest({
      catalogUrl: CATALOG_URL,
      moduleId: MODULE_ID as ModuleId,
      version: '1.0.0' as ModuleVersion,
    })
    const result = await system.coordinator.install({
      ...request,
      descriptor: { ...request.descriptor, extractedManifestSha256: 'f'.repeat(64) as ModuleSha256 },
      hostVersionRange: '*',
      operationId: 'tampered-v2-install',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('signed catalog release')
    expect(fixture.fetch.artifactRequests).toBe(0)
  })

  it('rejects validly-shaped Catalog evidence tampering before downloading the artifact', async () => {
    const fixture = await createFixture()
    const system = await createSystem(fixture)
    const request = await system.coordinator.resolveInstallRequest({
      catalogUrl: CATALOG_URL,
      moduleId: MODULE_ID as ModuleId,
      version: '1.0.0' as ModuleVersion,
    })
    const cases = [
      { name: 'artifact-size', evidence: { ...request.catalogEvidence, artifactSize: request.catalogEvidence.artifactSize + 1 } },
      { name: 'sequence-rollback', evidence: { ...request.catalogEvidence, sequence: request.catalogEvidence.sequence + 1 } },
      { name: 'issued-at-rollback', evidence: { ...request.catalogEvidence, issuedAt: '2026-07-12T17:30:00.000Z' } },
      { name: 'same-sequence-expiry', evidence: { ...request.catalogEvidence, expiresAt: '2026-07-13T16:59:59.000Z' } },
    ] as const

    for (const entry of cases) {
      const result = await system.coordinator.install({
        ...request,
        catalogEvidence: entry.evidence,
        operationId: `tampered-evidence-${entry.name}`,
      })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('Catalog evidence')
    }
    expect(fixture.fetch.artifactRequests).toBe(0)
  })

  it('accepts a valid higher-sequence Catalog refresh with identical release evidence', async () => {
    const fixture = await createFixture([
      INITIAL_CATALOG_REVISION,
      {
        sequence: 2,
        issuedAt: '2026-07-12T17:30:00.000Z',
        expiresAt: '2026-07-13T17:30:00.000Z',
      },
    ])
    const system = await createSystem(fixture)
    const request = await system.coordinator.resolveInstallRequest({
      catalogUrl: CATALOG_URL,
      moduleId: MODULE_ID as ModuleId,
      version: '1.0.0' as ModuleVersion,
    })

    expect((await system.coordinator.install({ ...request, operationId: 'refreshed-evidence-install' })).ok).toBe(true)
    expect(fixture.fetch.catalogRequests).toBe(3)
    expect(fixture.fetch.artifactRequests).toBe(1)
  })

  it('rejects a higher-sequence Catalog refresh whose issuance time did not advance', async () => {
    const fixture = await createFixture()
    let catalogRequests = 0
    let artifactRequests = 0
    const downloader: ModuleCoordinatorDependencies['downloader'] = {
      fetchCatalog: async () => ({
        catalog: {
          schemaVersion: 2,
          sequence: ++catalogRequests,
          issuedAt: INITIAL_CATALOG_REVISION.issuedAt,
          expiresAt: catalogRequests === 1
            ? INITIAL_CATALOG_REVISION.expiresAt
            : '2026-07-13T17:30:00.000Z',
          releases: fixture.releases,
        },
        source: 'network',
      }),
      downloadArtifact: async () => {
        artifactRequests += 1
        throw new Error('Catalog evidence must fail before artifact download')
      },
    }
    const system = await createSystem(fixture, undefined, undefined, downloader)
    const request = await system.coordinator.resolveInstallRequest({
      catalogUrl: CATALOG_URL,
      moduleId: MODULE_ID as ModuleId,
      version: '1.0.0' as ModuleVersion,
    })
    const result = await system.coordinator.install({ ...request, operationId: 'same-issued-at-refresh' })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Catalog evidence')
    expect(catalogRequests).toBe(2)
    expect(artifactRequests).toBe(0)
  })

  it('rejects a higher-sequence Catalog refresh that changes the bound artifact size', async () => {
    const fixture = await createFixture([
      INITIAL_CATALOG_REVISION,
      {
        sequence: 2,
        issuedAt: '2026-07-12T17:30:00.000Z',
        expiresAt: '2026-07-13T17:30:00.000Z',
        artifactSizeDelta: 1,
      },
    ])
    const system = await createSystem(fixture)
    const request = await system.coordinator.resolveInstallRequest({
      catalogUrl: CATALOG_URL,
      moduleId: MODULE_ID as ModuleId,
      version: '1.0.0' as ModuleVersion,
    })
    const result = await system.coordinator.install({ ...request, operationId: 'refreshed-size-mismatch' })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Catalog evidence')
    expect(fixture.fetch.artifactRequests).toBe(0)
  })

  it('runs install, update, crash restart, stop, rollback, and uninstall through existing module APIs', async () => {
    const system = await createSystem()
    await system.coordinator.install(system.requestFor('1.0.0'))
    await system.coordinator.start({ operationId: 'start-v1', moduleId: MODULE_ID as ModuleId })
    expect(system.process.processes).toHaveLength(1)

    system.process.processes[0]!.crash()
    for (let index = 0; index < 8 && system.process.processes.length < 2; index += 1) {
      await Promise.resolve()
      await system.clock.advance(1)
    }
    expect(system.process.processes).toHaveLength(2)
    await system.coordinator.stop({ operationId: 'stop-v1', moduleId: MODULE_ID as ModuleId })

    await system.coordinator.update(system.requestFor('2.0.0'))
    await system.coordinator.update(system.requestFor('3.0.0'))
    await system.coordinator.uninstall({ operationId: 'uninstall-v1', moduleId: MODULE_ID as ModuleId, version: '1.0.0' as ModuleVersion })
    await system.coordinator.rollback({ operationId: 'rollback-v3', moduleId: MODULE_ID as ModuleId })
    expect(system.registry.snapshot().modules[0]).toMatchObject({ activeVersion: '2.0.0', lastKnownGoodVersion: '3.0.0' })
    await system.coordinator.stop({ operationId: 'stop-v2', moduleId: MODULE_ID as ModuleId })

    const snapshot = await system.coordinator.snapshot()
    expect(snapshot.operations.map((operation) => operation.kind)).toEqual([
      'install', 'start', 'stop', 'update', 'update', 'uninstall', 'rollback', 'stop',
    ])
    expect(snapshot.operations.every((operation) => operation.status === 'completed')).toBe(true)
    expect(snapshot.events.some((event) => event.snapshot.state === 'crashed')).toBe(true)
  })

  it('deduplicates caller operationIds across concurrency and restart and rejects payload conflicts', async () => {
    const fixture = await createFixture()
    const first = await createSystem(fixture)
    const request = { ...first.requestFor('1.0.0'), operationId: 'caller-install-1' }
    const [left, right] = await Promise.all([
      first.coordinator.install(request),
      first.coordinator.install(structuredClone(request)),
    ])
    expect(right).toEqual(left)
    expect(fixture.fetch.artifactRequests).toBe(1)

    const restarted = await createSystem(fixture)
    expect(await restarted.coordinator.install(request)).toEqual(left)
    expect(fixture.fetch.artifactRequests).toBe(1)
    await expect(restarted.coordinator.install({
      ...restarted.requestFor('2.0.0'),
      operationId: 'caller-install-1',
    })).rejects.toMatchObject({ code: 'OPERATION_ID_CONFLICT' })
    expect(fixture.fetch.artifactRequests).toBe(1)

    const started = await restarted.coordinator.start({ operationId: 'caller-start-1', moduleId: MODULE_ID as ModuleId })
    expect(await restarted.coordinator.start({ operationId: 'caller-start-1', moduleId: MODULE_ID as ModuleId })).toEqual(started)
    expect(restarted.process.processes).toHaveLength(1)
  })

  it('holds the runtime usage lease from daemon start through view detach and daemon stop', async () => {
    const system = await createSystem()
    await system.coordinator.install({ ...system.requestFor('1.0.0'), operationId: 'lease-install' })
    await system.coordinator.start({ operationId: 'lease-start', moduleId: MODULE_ID as ModuleId })
    expect((await system.view.query(MODULE_ID as ModuleId))?.state).toBe('attached')
    expect(await system.usage.runExclusive(MODULE_ID as ModuleId, async (lease) => lease.isVersionInUse('1.0.0' as ModuleVersion))).toBe(true)
    await expect(system.coordinator.uninstall({
      operationId: 'lease-protected-uninstall',
      moduleId: MODULE_ID as ModuleId,
      version: '1.0.0' as ModuleVersion,
    })).rejects.toMatchObject({ code: 'PROTECTED_VERSION' })

    await system.coordinator.stop({ operationId: 'lease-stop', moduleId: MODULE_ID as ModuleId })
    expect((await system.view.query(MODULE_ID as ModuleId))?.state).toBe('detached')
    expect(await system.usage.runExclusive(MODULE_ID as ModuleId, async (lease) => lease.isVersionInUse('1.0.0' as ModuleVersion))).toBe(false)
  })
})

class CrashAfterCheckpointStore implements ModuleCoordinatorStore {
  fired = false
  #checkpoint?: ModuleCoordinatorCheckpoint
  #operationId?: string

  constructor(private readonly delegate: ModuleCoordinatorStore) {}

  arm(checkpoint: ModuleCoordinatorCheckpoint, operationId: string): void {
    this.fired = false
    this.#checkpoint = checkpoint
    this.#operationId = operationId
  }

  load(): Promise<ModuleCoordinatorState | undefined> {
    return this.delegate.load()
  }

  async save(state: ModuleCoordinatorState): Promise<void> {
    await this.delegate.save(state)
    if (!this.fired && state.operations.some((operation) => operation.id === this.#operationId && operation.checkpoint === this.#checkpoint)) {
      this.fired = true
      throw new SimulatedCoordinatorCrash(this.#checkpoint)
    }
  }
}

describe('ModuleCoordinator durable checkpoint recovery', () => {
  for (const checkpoint of [
    'intent-recorded', 'catalog-verified', 'artifact-downloaded', 'installed', 'registered', 'activation-restored', 'registry-restored', 'completed',
  ] as const) {
    it(`replays the packaged fake install after crash at ${checkpoint}`, async () => {
      const fixture = await createFixture()
      const store = new CrashAfterCheckpointStore(fixture.store)
      store.arm(checkpoint, 'crash-install')
      const first = await createSystem(fixture, store)
      await expect(first.coordinator.install({ ...first.requestFor('1.0.0'), operationId: 'crash-install' })).rejects.toBeInstanceOf(SimulatedCoordinatorCrash)
      await first.coordinator.dispose()
      const restarted = await createSystem(fixture, store)
      await restarted.coordinator.recover()
      const snapshot = await restarted.coordinator.snapshot()
      expect(snapshot.operations).toHaveLength(1)
      expect(snapshot.operations[0]).toMatchObject({ status: 'completed', checkpoint: 'completed' })
      expect(restarted.registry.snapshot().modules[0]).toMatchObject({ activeVersion: '1.0.0' })
    }, CRASH_MATRIX_TEST_TIMEOUT_MS)
  }
})

describe('ModuleCoordinator Catalog evidence durable compatibility', () => {
  it('recovers a legacy durable install request that predates Catalog evidence', async () => {
    const fixture = await createFixture()
    const store = new CrashAfterCheckpointStore(fixture.store)
    store.arm('intent-recorded', 'legacy-durable-install')
    const first = await createSystem(fixture, store)
    await expect(first.coordinator.install({
      ...first.requestFor('1.0.0'),
      operationId: 'legacy-durable-install',
    })).rejects.toBeInstanceOf(SimulatedCoordinatorCrash)
    await first.coordinator.dispose()

    const persisted = await fixture.store.load()
    expect(persisted).toBeDefined()
    expect(Object.hasOwn(persisted!.operations[0]!.request, 'catalogEvidence')).toBe(false)

    const restarted = await createSystem(fixture, store)
    await restarted.coordinator.recover()
    expect((await restarted.coordinator.snapshot()).operations[0]).toMatchObject({
      id: 'legacy-durable-install',
      checkpoint: 'completed',
      status: 'completed',
    })
  })

  it('strictly parses and fingerprints optional Catalog evidence in durable state', async () => {
    const fixture = await createFixture()
    const store = new CrashAfterCheckpointStore(fixture.store)
    const first = await createSystem(fixture, store)
    const request = await first.coordinator.resolveInstallRequest({
      catalogUrl: CATALOG_URL,
      moduleId: MODULE_ID as ModuleId,
      version: '1.0.0' as ModuleVersion,
    })
    store.arm('intent-recorded', 'evidence-durable-install')
    await expect(first.coordinator.install({
      ...request,
      operationId: 'evidence-durable-install',
    })).rejects.toBeInstanceOf(SimulatedCoordinatorCrash)
    await first.coordinator.dispose()

    const persisted = await fixture.store.load()
    expect(persisted?.operations[0]?.request).toMatchObject({ catalogEvidence: request.catalogEvidence })
    const mutations: readonly ((evidence: Record<string, unknown>) => void)[] = [
      (evidence) => { evidence.unexpected = true },
      (evidence) => { evidence.schemaVersion = 2 },
      (evidence) => { evidence.sequence = 0 },
      (evidence) => { evidence.issuedAt = '2026-07-12T17:00:00Z' },
      (evidence) => { evidence.expiresAt = evidence.issuedAt },
      (evidence) => { evidence.artifactSize = (evidence.artifactSize as number) + 1 },
    ]
    for (const mutate of mutations) {
      const tampered = structuredClone(persisted!)
      const evidence = (tampered.operations[0]!.request as unknown as {
        catalogEvidence: Record<string, unknown>
      }).catalogEvidence
      mutate(evidence)
      await expect(fixture.store.save(tampered)).rejects.toMatchObject({ code: 'STORE_CORRUPT' })
    }

    const restarted = await createSystem(fixture, store)
    await restarted.coordinator.recover()
    expect((await restarted.coordinator.snapshot()).operations[0]).toMatchObject({
      id: 'evidence-durable-install',
      checkpoint: 'completed',
      status: 'completed',
    })
  })
})

const FORWARD_CRASH_MATRIX = {
  install: ['intent-recorded', 'catalog-verified', 'artifact-downloaded', 'installed', 'registered', 'activation-restored', 'registry-restored', 'completed'],
  update: ['intent-recorded', 'runtime-detached', 'daemon-stopped', 'catalog-verified', 'artifact-downloaded', 'installed', 'registered', 'activation-restored', 'registry-restored', 'daemon-started', 'view-attached', 'completed'],
  rollback: ['intent-recorded', 'runtime-detached', 'daemon-stopped', 'activation-restored', 'registry-restored', 'daemon-started', 'view-attached', 'completed'],
  start: ['intent-recorded', 'daemon-started', 'view-attached', 'completed'],
  restart: ['intent-recorded', 'runtime-detached', 'daemon-stopped', 'daemon-started', 'view-attached', 'completed'],
  stop: ['intent-recorded', 'runtime-detached', 'daemon-stopped', 'completed'],
  uninstall: ['intent-recorded', 'version-uninstalled', 'registry-removed', 'completed'],
} as const satisfies Record<string, readonly ModuleCoordinatorCheckpoint[]>

type CrashOperationKind = keyof typeof FORWARD_CRASH_MATRIX

async function prepareCrashOperation(system: System, kind: CrashOperationKind): Promise<void> {
  if (kind === 'install') return
  await system.coordinator.install({ ...system.requestFor('1.0.0'), operationId: `prepare-install-${kind}` })
  if (kind === 'start') return
  await system.coordinator.start({ operationId: `prepare-start-${kind}`, moduleId: MODULE_ID as ModuleId })
  if (kind === 'update' || kind === 'restart' || kind === 'stop') return
  await system.coordinator.update({ ...system.requestFor('2.0.0'), operationId: `prepare-update-${kind}` })
  if (kind === 'uninstall') {
    await system.coordinator.update({ ...system.requestFor('3.0.0'), operationId: `prepare-update-3-${kind}` })
  }
}

function invokeCrashOperation(system: System, kind: CrashOperationKind, operationId: string) {
  switch (kind) {
    case 'install': return system.coordinator.install({ ...system.requestFor('1.0.0'), operationId })
    case 'update': return system.coordinator.update({ ...system.requestFor('2.0.0'), operationId })
    case 'rollback': return system.coordinator.rollback({ moduleId: MODULE_ID as ModuleId, operationId, restartAfterRollback: true })
    case 'start': return system.coordinator.start({ moduleId: MODULE_ID as ModuleId, operationId })
    case 'restart': return system.coordinator.restart({ moduleId: MODULE_ID as ModuleId, operationId })
    case 'stop': return system.coordinator.stop({ moduleId: MODULE_ID as ModuleId, operationId })
    case 'uninstall': return system.coordinator.uninstall({ moduleId: MODULE_ID as ModuleId, version: '1.0.0' as ModuleVersion, operationId })
  }
}

describe('ModuleCoordinator all-operation forward crash matrix', () => {
  for (const [kind, checkpoints] of Object.entries(FORWARD_CRASH_MATRIX) as [CrashOperationKind, readonly ModuleCoordinatorCheckpoint[]][]) {
    for (const checkpoint of checkpoints) {
      it(`${kind} recovers from durable checkpoint ${checkpoint}`, async () => {
        const fixture = await createFixture()
        const store = new CrashAfterCheckpointStore(fixture.store)
        const first = await createSystem(fixture, store)
        await prepareCrashOperation(first, kind)
        const operationId = `crash-${kind}-${checkpoint}`
        store.arm(checkpoint, operationId)
        await expect(invokeCrashOperation(first, kind, operationId)).rejects.toBeInstanceOf(SimulatedCoordinatorCrash)
        await first.coordinator.dispose()

        const restarted = await createSystem(fixture, store)
        await restarted.coordinator.recover()
        const operation = (await restarted.coordinator.snapshot()).operations.find((item) => item.id === operationId)
        expect(operation).toMatchObject({ kind, checkpoint: 'completed', status: 'completed' })
        if (kind === 'uninstall') {
          expect(restarted.registry.snapshot().modules[0]?.versions.map((item) => item.version)).not.toContain('1.0.0')
        }
      }, CRASH_MATRIX_TEST_TIMEOUT_MS)
    }
  }
})

const COMPENSATION_CHECKPOINTS = [
  'compensation-started',
  'compensation-runtime-detached',
  'compensation-daemon-stopped',
  'compensation-activation-restored',
  'compensation-registry-restored',
  'compensation-daemon-started',
  'compensation-view-attached',
  'compensated',
] as const satisfies readonly ModuleCoordinatorCheckpoint[]

const COMPENSATION_FAILURE_POINT = {
  install: 'before-checkpoint:registry-restored',
  update: 'before-checkpoint:registry-restored',
  rollback: 'before-checkpoint:registry-restored',
  start: 'before-checkpoint:view-attached',
  restart: 'before-checkpoint:view-attached',
  stop: 'before-checkpoint:daemon-stopped',
} as const satisfies Record<Exclude<CrashOperationKind, 'uninstall'>, ModuleCoordinatorFaultPoint>

describe('ModuleCoordinator all-operation compensation crash matrix', () => {
  for (const [kind, failurePoint] of Object.entries(COMPENSATION_FAILURE_POINT) as [Exclude<CrashOperationKind, 'uninstall'>, ModuleCoordinatorFaultPoint][]) {
    for (const checkpoint of COMPENSATION_CHECKPOINTS) {
      it(`${kind} restores its source after compensation crash at ${checkpoint}`, async () => {
        const fixture = await createFixture()
        const store = new CrashAfterCheckpointStore(fixture.store)
        let failed = false
        let faultArmed = false
        const first = await createSystem(fixture, store, (point) => {
          if (faultArmed && point === failurePoint && !failed) {
            failed = true
            throw new Error(`injected failure at ${point}`)
          }
        })
        await prepareCrashOperation(first, kind)
        faultArmed = true
        const operationId = `compensate-${kind}-${checkpoint}`
        store.arm(checkpoint, operationId)
        await expect(invokeCrashOperation(first, kind, operationId)).rejects.toBeInstanceOf(SimulatedCoordinatorCrash)
        await first.coordinator.dispose()

        const restarted = await createSystem(fixture, store)
        await restarted.coordinator.recover()
        const operation = (await restarted.coordinator.snapshot()).operations.find((item) => item.id === operationId)
        expect(operation).toMatchObject({
          kind,
          checkpoint: 'compensated',
          status: 'failed',
          result: { ok: false },
        })
        const module = restarted.registry.snapshot().modules.find((item) => item.id === MODULE_ID)
        expect(module?.activeVersion ?? null).toBe(operation?.source.activeVersion ?? null)
        expect((await restarted.view.query(MODULE_ID as ModuleId))?.state === 'attached').toBe(operation?.source.viewAttached ?? false)
      }, CRASH_MATRIX_TEST_TIMEOUT_MS)
    }
  }
})

const UPDATE_FAILURE_CHECKPOINTS = [
  'runtime-detached', 'daemon-stopped', 'catalog-verified', 'artifact-downloaded', 'installed',
  'registered', 'activation-restored', 'registry-restored', 'daemon-started', 'view-attached',
] as const satisfies readonly ModuleCoordinatorCheckpoint[]

describe('ModuleCoordinator update failure restoration matrix', () => {
  for (const checkpoint of UPDATE_FAILURE_CHECKPOINTS) {
    it(`restores old active/LKG daemon and view after failure at ${checkpoint}`, async () => {
      const fixture = await createFixture()
      let faultArmed = false
      const system = await createSystem(fixture, fixture.store, (point) => {
        if (faultArmed && point === `before-checkpoint:${checkpoint}`) throw new Error(`update failure at ${checkpoint}`)
      })
      await system.coordinator.install({ ...system.requestFor('1.0.0'), operationId: `failure-prepare-install-${checkpoint}` })
      await system.coordinator.start({ operationId: `failure-prepare-start-${checkpoint}`, moduleId: MODULE_ID as ModuleId })
      faultArmed = true

      const result = await system.coordinator.update({
        ...system.requestFor('2.0.0'),
        operationId: `failure-update-${checkpoint}`,
      })
      expect(result.ok).toBe(false)
      expect(system.registry.snapshot().modules[0]).toMatchObject({
        activeVersion: '1.0.0',
        lastKnownGoodVersion: null,
      })
      expect((await system.view.query(MODULE_ID as ModuleId))?.state).toBe('attached')
      expect(system.process.requests.at(-1)?.env.SIMULATOR_MODULE_ID).toBe(MODULE_ID)
    }, CRASH_MATRIX_TEST_TIMEOUT_MS)
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

  get(moduleId: ModuleId) {
    return { id: moduleId, version: '1.0.0' as ModuleVersion, state: 'stopping' as const, restartCount: 0 }
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
      installer: {
        recoverAll: async () => undefined,
        getState: async (moduleId: ModuleId) => ({ moduleId, activeVersion: null, lastKnownGoodVersion: null }),
      } as never,
      registry: new ModuleRegistry({ version: '0.11.1', platform: 'darwin-arm64' }),
      daemon: daemon as never,
      platform: 'darwin-arm64',
      store: new InMemoryModuleCoordinatorStore(),
      archiveLocator: { locate: async () => '' },
      activationLocator: { locate: async () => '', isInstalled: async () => false },
      view: { attach: async () => { throw new Error('unused') }, detach: async () => undefined, query: async () => undefined },
      usage: { acquireReference: async () => () => undefined },
    })
    const left = 'org.simulator.serial-left' as ModuleId
    const right = 'org.simulator.parallel-right' as ModuleId

    const first = coordinator.stop({ operationId: 'left-1', moduleId: left })
    await waitFor(() => daemon.calls.length === 1)
    const second = coordinator.stop({ operationId: 'left-2', moduleId: left })
    const independent = coordinator.stop({ operationId: 'right-1', moduleId: right })
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

  it('does not dispose the durable store while a module operation is still in flight', async () => {
    const daemon = new BlockingDaemon()
    const coordinator = new ModuleCoordinator({
      downloader: {} as never,
      installer: {
        recoverAll: async () => undefined,
        getState: async (moduleId: ModuleId) => ({ moduleId, activeVersion: null, lastKnownGoodVersion: null }),
      } as never,
      registry: new ModuleRegistry({ version: '0.11.1', platform: 'darwin-arm64' }),
      daemon: daemon as never,
      platform: 'darwin-arm64',
      store: new InMemoryModuleCoordinatorStore(),
      archiveLocator: { locate: async () => '' },
      activationLocator: { locate: async () => '', isInstalled: async () => false },
      view: { attach: async () => { throw new Error('unused') }, detach: async () => undefined, query: async () => undefined },
      usage: { acquireReference: async () => () => undefined },
    })
    const moduleId = 'org.simulator.dispose-in-flight' as ModuleId
    const operation = coordinator.stop({ operationId: 'dispose-in-flight', moduleId })
    await waitFor(() => daemon.calls.length === 1)
    let disposed = false
    const disposal = coordinator.dispose().then(() => { disposed = true })

    await Bun.sleep(5)
    expect(disposed).toBe(false)
    daemon.release(moduleId)
    await operation
    await disposal
    expect(disposed).toBe(true)
  })
})
