import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { parseModuleManifest, type ModuleId, type ModuleManifest, type ModulePlatform, type ModuleSha256, type ModuleVersion } from '@simulator/module-contract'
import { LoopbackHttpHealthAdapter, ModuleDaemonManager, RealClock, RealProcessAdapter, type ModuleDaemonSnapshot } from '@simulator/module-daemon'
import { ModuleDownloader, NodeFilesystemModuleDownloaderCache } from '@simulator/module-downloader'
import { ManualClock, memoryResponse } from '@simulator/module-downloader/testing'
import { ModuleInstaller } from '@simulator/module-installer'
import { ModuleRegistry } from '@simulator/module-registry'
import { FilesystemModuleRegistryPersistence } from '@simulator/module-registry/filesystem'
import { encodeCanonicalCatalog, type TrustedReleaseKey } from '@simulator/module-release-trust'
import { ModuleCoordinator } from './coordinator.ts'
import { LoopbackFrontendModuleViewPort } from './loopback-view.ts'
import { NodeFilesystemModuleCoordinatorStore } from './node-store.ts'
import type { ModuleCoordinatorOperationResult } from './types.ts'
import { ModuleRuntimeUseGate } from './usage-gate.ts'

const NOW = Date.parse('2026-07-13T12:00:00.000Z')
const CATALOG_URL = 'https://modules.example.test/packaged/catalog.json'
const PACKAGED_RUNTIME_MAX_BYTES = 128 * 1024 * 1024
const PROCESS_EXIT_TIMEOUT_MS = 2_000
const SUPERVISOR_CRASH_TIMEOUT_MS = 2_000
const REPLACEMENT_READY_TIMEOUT_MS = 6_000
const VIEW_REATTACH_TIMEOUT_MS = 3_000
const PACKAGED_FIXTURE_BUILD_TIMEOUT_MS = 60_000
const PACKAGED_LIFECYCLE_TIMEOUT_MS = process.platform === 'win32' ? 60_000 : 30_000
const systems: PackagedSystem[] = []
let compiledFixture: Promise<{ bytes: Buffer; entrypoint: string }> | undefined
let compiledFixtureRoot: string | undefined

function currentPlatform(): ModulePlatform {
  return `${process.platform}-${process.arch}` as ModulePlatform
}

function sha256(value: Uint8Array | string): ModuleSha256 {
  return createHash('sha256').update(value).digest('hex') as ModuleSha256
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  buffer.write(value.toString(8).padStart(length - 1, '0'), offset, length - 1, 'ascii')
  buffer[offset + length - 1] = 0
}

function tarEntry(path: string, type: '0' | '5', mode: number, content: Uint8Array = Buffer.alloc(0)): Buffer {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content)
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
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.byteLength % 512)) % 512)])
}

async function packagedArchive(): Promise<{ archive: Buffer; treeHash: ModuleSha256 }> {
  const fixture = join(import.meta.dir, '..', 'fixtures', 'packaged-fake-module')
  compiledFixture ??= (async () => {
    compiledFixtureRoot = await mkdtemp(join(tmpdir(), 'simulator-module-fixture-build-'))
    const entrypoint = process.platform === 'win32' ? 'bin/module.exe' : 'bin/module'
    const output = join(compiledFixtureRoot, process.platform === 'win32' ? 'module.exe' : 'module')
    const build = Bun.spawn([
      process.execPath,
      'build',
      '--compile',
      '--minify',
      join(fixture, 'bin', 'module.ts'),
      '--outfile',
      output,
    ], { stdout: 'pipe', stderr: 'pipe' })
    const [exitCode, stdout, stderr] = await Promise.all([
      build.exited,
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
    ])
    if (exitCode !== 0) throw new Error(`Could not compile packaged fixture (${exitCode}): ${stdout}\n${stderr}`)
    if (process.platform !== 'win32') await chmod(output, 0o700)
    return { bytes: await readFile(output), entrypoint }
  })()
  const executableFixture = await compiledFixture
  const executable = executableFixture.bytes
  const frontend = await readFile(join(fixture, 'frontend', 'index.html'))
  const data = Buffer.from((await readFile(join(fixture, 'data.txt'), 'utf8')).replaceAll('\r\n', '\n'), 'utf8')
  const archive = gzipSync(Buffer.concat([
    tarEntry('module/', '5', 0o755),
    tarEntry('module/bin/', '5', 0o755),
    tarEntry(`module/${executableFixture.entrypoint}`, '0', 0o755, executable),
    tarEntry('module/data.txt', '0', 0o644, data),
    tarEntry('module/frontend/', '5', 0o755),
    tarEntry('module/frontend/index.html', '0', 0o644, frontend),
    Buffer.alloc(1024),
  ]))
  const records = [
    { path: 'bin', value: `D\t${JSON.stringify('bin')}` },
    { path: executableFixture.entrypoint, value: `F\t${JSON.stringify(executableFixture.entrypoint)}\t${executable.byteLength}\t1\t${sha256(executable)}` },
    { path: 'data.txt', value: `F\t${JSON.stringify('data.txt')}\t${data.byteLength}\t0\t${sha256(data)}` },
    { path: 'frontend', value: `D\t${JSON.stringify('frontend')}` },
    { path: 'frontend/index.html', value: `F\t${JSON.stringify('frontend/index.html')}\t${frontend.byteLength}\t0\t${sha256(frontend)}` },
  ].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)))
  return { archive, treeHash: sha256(`${records.map((item) => item.value).join('\n')}\n`) }
}

interface ReleaseSpec {
  readonly id: string
  readonly version: string
  readonly archive: Buffer
  readonly treeHash: ModuleSha256
  readonly servedBytes?: Buffer
}

interface BundleRelease {
  readonly manifest: ModuleManifest
  readonly treeHash: ModuleSha256
}

interface PackagedBundle {
  readonly releases: readonly BundleRelease[]
  readonly wireBytes: Uint8Array
  readonly key: TrustedReleaseKey
  readonly artifacts: ReadonlyMap<string, Buffer>
}

function bundle(specs: readonly ReleaseSpec[]): PackagedBundle {
  const artifacts = new Map<string, Buffer>()
  const releases = specs.map((spec) => {
    const url = `https://modules.example.test/packaged/${spec.id}/${spec.version}.tar.gz`
    const parsed = parseModuleManifest({
      schemaVersion: 1,
      id: spec.id,
      version: spec.version,
      artifacts: [{
        platform: currentPlatform(),
        entrypoint: process.platform === 'win32' ? 'bin/module.exe' : 'bin/module',
        url,
        sha256: sha256(spec.archive),
      }],
      capabilities: ['workspace.read'],
    })
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
    artifacts.set(url, spec.servedBytes ?? spec.archive)
    return { manifest: parsed.value, treeHash: spec.treeHash }
  })
  const pair = generateKeyPairSync('ed25519')
  const publicDer = pair.publicKey.export({ format: 'der', type: 'spki' })
  const key: TrustedReleaseKey = {
    keyId: 'packaged-production-smoke',
    publicKey: Uint8Array.from(publicDer.subarray(publicDer.byteLength - 32)),
    activeFrom: '2026-07-13T00:00:00.000Z',
  }
  const catalogBytes = encodeCanonicalCatalog({
    schemaVersion: 1,
    sequence: 1,
    issuedAt: '2026-07-13T11:00:00.000Z',
    expiresAt: '2026-07-14T11:00:00.000Z',
    releases: releases.map((release) => ({
      manifest: release.manifest,
      artifactSizes: [{ platform: currentPlatform(), size: artifacts.get(release.manifest.artifacts[0]!.url)!.byteLength }],
    })),
  })
  const wireBytes = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    keyId: key.keyId,
    catalogBytes: Buffer.from(catalogBytes).toString('base64'),
    signature: Buffer.from(sign(null, catalogBytes, pair.privateKey)).toString('base64'),
  }))
  return { releases, wireBytes, key, artifacts }
}

class PackagedFetch {
  constructor(readonly fixture: PackagedBundle) {}

  async fetch(request: { readonly url: string; readonly headers: Readonly<Record<string, string>> }) {
    if (request.url === CATALOG_URL) {
      if (request.headers['if-none-match'] === '"packaged-smoke"') return memoryResponse({ status: 304, url: CATALOG_URL })
      return memoryResponse({
        url: CATALOG_URL,
        headers: { 'content-length': String(this.fixture.wireBytes.byteLength), etag: '"packaged-smoke"' },
        chunks: [this.fixture.wireBytes],
      })
    }
    const bytes = this.fixture.artifacts.get(request.url)
    if (!bytes) throw new Error(`Unexpected packaged fixture request: ${request.url}`)
    return memoryResponse({
      url: request.url,
      headers: { 'content-length': String(bytes.byteLength), etag: '"packaged-artifact"' },
      chunks: [bytes],
    })
  }
}

interface PackagedSystem {
  readonly root: string
  readonly coordinator: ModuleCoordinator
  readonly daemon: ModuleDaemonManager
  readonly view: LoopbackFrontendModuleViewPort
  readonly registry: ModuleRegistry
  readonly usage: ModuleRuntimeUseGate
  request(id: string, version?: string): Parameters<ModuleCoordinator['install']>[0]
}

interface PackagedRuntimeOptions {
  readonly mode?: 'healthy' | 'readiness-failure'
  readonly restartLimit?: number
  readonly startupDelayMs?: number
}

function packagedRuntimeEnvironment(
  mode: NonNullable<PackagedRuntimeOptions['mode']>,
  startupDelayMs: number,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
    SIMULATOR_PACKAGED_FAKE_MODE: mode,
    SIMULATOR_PACKAGED_FAKE_STARTUP_DELAY_MS: String(startupDelayMs),
  }
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot
    if (!systemRoot) throw new Error('Windows packaged runtime requires SystemRoot')
    environment.PATH = [dirname(process.execPath), join(systemRoot, 'System32')].join(delimiter)
    environment.SystemRoot = systemRoot
  }
  return environment
}

async function createSystem(fixture: PackagedBundle, options: PackagedRuntimeOptions = {}): Promise<PackagedSystem> {
  const { mode = 'healthy', restartLimit = 2, startupDelayMs = 0 } = options
  const root = await mkdtemp(join(tmpdir(), 'simulator-module-coordinator-packaged-'))
  const cacheRoot = join(root, 'cache')
  const moduleRoot = join(root, 'installed')
  const usage = new ModuleRuntimeUseGate()
  const downloader = new ModuleDownloader({
    fetch: new PackagedFetch(fixture),
    cache: new NodeFilesystemModuleDownloaderCache(cacheRoot),
    clock: new ManualClock(NOW),
    trustedKeys: [fixture.key],
    retry: { maxAttempts: 1 },
  })
  const installer = new ModuleInstaller(moduleRoot, {
    usageGuard: usage,
    limits: { maxFileBytes: PACKAGED_RUNTIME_MAX_BYTES },
  })
  const registry = new ModuleRegistry(
    { version: '0.11.1', platform: currentPlatform() },
    new FilesystemModuleRegistryPersistence(join(root, 'registry')),
  )
  const daemon = new ModuleDaemonManager({
    process: new RealProcessAdapter(),
    clock: new RealClock(),
    health: new LoopbackHttpHealthAdapter(),
    startupTimeoutMs: 3_000,
    healthTimeoutMs: 500,
    healthIntervalMs: 20,
    unhealthyThreshold: 2,
    restartLimit,
    restartBackoffMs: [10, 20],
    idleTimeoutMs: 60_000,
    stopGraceMs: 1_000,
    baseEnvironment: packagedRuntimeEnvironment(mode, startupDelayMs),
  })
  const view = new LoopbackFrontendModuleViewPort({ timeoutMs: 1_000 })
  const coordinator = new ModuleCoordinator({
    downloader,
    installer,
    registry,
    daemon,
    platform: currentPlatform(),
    store: new NodeFilesystemModuleCoordinatorStore(join(root, 'coordinator')),
    archiveLocator: { locate: async (hash) => join(cacheRoot, 'artifacts', hash, 'artifact.bin') },
    activationLocator: {
      locate: async (id, version) => join(moduleRoot, 'modules', id, 'versions', version),
      isInstalled: async (id, version) => Bun.file(join(moduleRoot, 'modules', id, 'versions', version)).exists(),
    },
    view,
    usage,
  })
  const request = (id: string, version = '1.0.0') => {
    const release = fixture.releases.find((item) => item.manifest.id === id && item.manifest.version === version)
    if (!release) throw new Error(`Missing release ${id}@${version}`)
    return {
      catalogUrl: CATALOG_URL,
      descriptor: {
        verified: true as const,
        manifest: release.manifest,
        artifact: release.manifest.artifacts[0]!,
        extractedManifestSha256: release.treeHash,
        format: 'tar.gz' as const,
      },
      hostVersionRange: '*',
    }
  }
  const system = { root, coordinator, daemon, view, registry, usage, request }
  systems.push(system)
  return system
}

interface DaemonTrace {
  readonly history: ModuleDaemonSnapshot[]
  readonly unsubscribe: () => void
}

function traceDaemon(daemon: ModuleDaemonManager, moduleId: ModuleId): DaemonTrace {
  const history: ModuleDaemonSnapshot[] = []
  const initial = daemon.get(moduleId)
  if (initial) history.push(initial)
  const unsubscribe = daemon.subscribe((snapshot) => {
    if (snapshot.id !== moduleId) return
    history.push(snapshot)
    if (history.length > 32) history.shift()
  })
  return { history, unsubscribe }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true
    throw error
  }
}

async function runtimeDiagnostics(
  system: PackagedSystem,
  moduleId: ModuleId,
  history: readonly ModuleDaemonSnapshot[],
  previousPid?: number,
): Promise<unknown> {
  return {
    daemon: system.daemon.get(moduleId),
    daemonHistory: history,
    previousPid,
    previousPidAlive: previousPid === undefined ? undefined : processExists(previousPid),
    view: await system.view.query(moduleId),
    document: system.view.document(moduleId),
  }
}

async function waitForPhase<T>(
  phase: string,
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  diagnostics: () => unknown | Promise<unknown>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await Bun.sleep(10)
  }
  let detail: unknown
  try {
    detail = await diagnostics()
  } catch (error) {
    detail = { diagnosticsError: error instanceof Error ? error.message : String(error) }
  }
  throw new Error(`Timed out waiting for ${phase} after ${timeoutMs}ms; diagnostics=${JSON.stringify(detail)}`)
}

async function crashAndAwaitHealthyRestart(
  system: PackagedSystem,
  moduleId: ModuleId,
  initial: ModuleDaemonSnapshot,
): Promise<ModuleDaemonSnapshot> {
  if (initial.pid === undefined || !initial.endpoint) throw new Error('Expected a healthy daemon with PID and endpoint before crash')
  const previousPid = initial.pid
  const trace = traceDaemon(system.daemon, moduleId)
  const diagnostics = () => runtimeDiagnostics(system, moduleId, trace.history, previousPid)
  try {
    const response = await fetch(`http://${initial.endpoint.host}:${initial.endpoint.port}/crash`)
    if (!response.ok) throw new Error(`Packaged fixture crash endpoint returned HTTP ${response.status}`)
    await waitForPhase(
      'old packaged daemon process to exit',
      () => processExists(previousPid) ? undefined : true,
      PROCESS_EXIT_TIMEOUT_MS,
      diagnostics,
    )
    await waitForPhase(
      'daemon supervisor to publish PROCESS_EXITED',
      () => trace.history.some((snapshot) => snapshot.state === 'crashed' && snapshot.diagnostic?.code === 'PROCESS_EXITED') ? true : undefined,
      SUPERVISOR_CRASH_TIMEOUT_MS,
      diagnostics,
    )
    const restarted = await waitForPhase(
      'replacement packaged daemon to become healthy',
      () => {
        const snapshot = system.daemon.get(moduleId)
        return snapshot?.state === 'healthy' && snapshot.pid !== previousPid ? snapshot : undefined
      },
      REPLACEMENT_READY_TIMEOUT_MS,
      diagnostics,
    )
    await waitForPhase(
      'frontend to reattach to replacement daemon',
      () => system.view.document(moduleId)?.url.includes(`:${restarted.endpoint!.port}/`) ? true : undefined,
      VIEW_REATTACH_TIMEOUT_MS,
      diagnostics,
    )
    return restarted
  } finally {
    trace.unsubscribe()
  }
}

function expectOperationOk(result: ModuleCoordinatorOperationResult): void {
  if (!result.ok) throw new Error(`${result.kind} ${result.operationId} failed: ${result.error ?? 'unknown error'}`)
}

beforeAll(async () => {
  await packagedArchive()
}, PACKAGED_FIXTURE_BUILD_TIMEOUT_MS)

afterEach(async () => {
  for (const system of systems.splice(0)) {
    await system.daemon.drain().catch(() => undefined)
    await system.coordinator.dispose()
    await rm(system.root, { recursive: true, force: true })
  }
})

afterAll(async () => {
  if (compiledFixtureRoot) await rm(compiledFixtureRoot, { recursive: true, force: true })
})

describe('packaged fake module with production runtime adapters', () => {
  it('serves frontend and installed resources, reattaches after daemon and renderer crashes, and leaves built-in Agent state independent', async () => {
    const packaged = await packagedArchive()
    const id = 'org.simulator.packaged-production'
    const system = await createSystem(bundle([{ id, version: '1.0.0', ...packaged }]))
    const builtInAgent = structuredClone({ id: 'builtin-agent', running: true, revision: 7 })
    const expectedAgent = structuredClone(builtInAgent)

    expectOperationOk(await system.coordinator.install({ ...system.request(id), operationId: 'production-install' }))
    expectOperationOk(await system.coordinator.start({ operationId: 'production-start', moduleId: id as ModuleId }))
    expect(system.view.document(id as ModuleId)?.html).toContain('Packaged Fake Module Frontend')
    const first = system.daemon.get(id as ModuleId)!
    const resource = await fetch(`http://${first.endpoint!.host}:${first.endpoint!.port}/resource/data.txt`)
    expect(await resource.text()).toBe('installed packaged fake resource\n')

    await crashAndAwaitHealthyRestart(system, id as ModuleId, first)
    expect(system.view.markCrashed(id as ModuleId)).toMatchObject({ state: 'crashed' })
    expectOperationOk(await system.coordinator.restart({ operationId: 'production-renderer-restart', moduleId: id as ModuleId }))
    expect(await system.view.query(id as ModuleId)).toMatchObject({ state: 'attached' })
    expect(builtInAgent).toEqual(expectedAgent)
    await system.coordinator.stop({ operationId: 'production-stop', moduleId: id as ModuleId })
  }, PACKAGED_LIFECYCLE_TIMEOUT_MS)

  it('restarts and reattaches after a bounded slow daemon startup', async () => {
    const packaged = await packagedArchive()
    const id = 'org.simulator.packaged-slow-start'
    const system = await createSystem(
      bundle([{ id, version: '1.0.0', ...packaged }]),
      { startupDelayMs: 750 },
    )

    expectOperationOk(await system.coordinator.install({ ...system.request(id), operationId: 'slow-start-install' }))
    expectOperationOk(await system.coordinator.start({ operationId: 'slow-start-start', moduleId: id as ModuleId }))
    const initial = system.daemon.get(id as ModuleId)!
    const restarted = await crashAndAwaitHealthyRestart(system, id as ModuleId, initial)

    expect(restarted).toMatchObject({ state: 'healthy', restartCount: 1 })
    expect(await system.view.query(id as ModuleId)).toMatchObject({ state: 'attached' })
    expectOperationOk(await system.coordinator.stop({ operationId: 'slow-start-stop', moduleId: id as ModuleId }))
  }, PACKAGED_LIFECYCLE_TIMEOUT_MS)

  it('fails closed on readiness failure without attaching a frontend or leaking a runtime lease', async () => {
    const packaged = await packagedArchive()
    const id = 'org.simulator.packaged-readiness'
    const system = await createSystem(bundle([{ id, version: '1.0.0', ...packaged }]), { mode: 'readiness-failure', restartLimit: 0 })
    await system.coordinator.install({ ...system.request(id), operationId: 'readiness-install' })
    expect((await system.coordinator.start({ operationId: 'readiness-start', moduleId: id as ModuleId })).ok).toBe(false)
    expect(await system.view.query(id as ModuleId)).toBeUndefined()
    expect(await system.usage.runExclusive(id as ModuleId, async (lease) => lease.isVersionInUse('1.0.0' as ModuleVersion))).toBe(false)
  }, PACKAGED_LIFECYCLE_TIMEOUT_MS)

  it('records restart budget exhaustion and detaches the frontend', async () => {
    const packaged = await packagedArchive()
    const id = 'org.simulator.packaged-restart-budget'
    const system = await createSystem(bundle([{ id, version: '1.0.0', ...packaged }]), { restartLimit: 1 })
    await system.coordinator.install({ ...system.request(id), operationId: 'budget-install' })
    expectOperationOk(await system.coordinator.start({ operationId: 'budget-start', moduleId: id as ModuleId }))
    const initial = system.daemon.get(id as ModuleId)!
    const restarted = await crashAndAwaitHealthyRestart(system, id as ModuleId, initial)
    const trace = traceDaemon(system.daemon, id as ModuleId)
    const diagnostics = () => runtimeDiagnostics(system, id as ModuleId, trace.history, restarted.pid)
    try {
      const response = await fetch(`http://${restarted.endpoint!.host}:${restarted.endpoint!.port}/crash`)
      if (!response.ok) throw new Error(`Packaged fixture crash endpoint returned HTTP ${response.status}`)
      await waitForPhase(
        'daemon restart budget exhaustion',
        () => system.daemon.get(id as ModuleId)?.diagnostic?.code === 'RESTART_BUDGET_EXHAUSTED' ? true : undefined,
        REPLACEMENT_READY_TIMEOUT_MS,
        diagnostics,
      )
      await waitForPhase(
        'frontend detach after restart budget exhaustion',
        async () => (await system.view.query(id as ModuleId))?.state === 'detached' ? true : undefined,
        VIEW_REATTACH_TIMEOUT_MS,
        diagnostics,
      )
    } finally {
      trace.unsubscribe()
    }
    expect(system.daemon.get(id as ModuleId)).toMatchObject({ state: 'crashed', diagnostic: { code: 'RESTART_BUDGET_EXHAUSTED' } })
    await system.coordinator.stop({ operationId: 'budget-stop', moduleId: id as ModuleId })
  }, PACKAGED_LIFECYCLE_TIMEOUT_MS)

  it('isolates two running modules when one daemon crashes and restarts', async () => {
    const packaged = await packagedArchive()
    const left = 'org.simulator.packaged-left'
    const right = 'org.simulator.packaged-right'
    const system = await createSystem(bundle([
      { id: left, version: '1.0.0', ...packaged },
      { id: right, version: '1.0.0', ...packaged },
    ]))
    for (const id of [left, right]) {
      expectOperationOk(await system.coordinator.install({ ...system.request(id), operationId: `isolation-install-${id}` }))
    }
    await Promise.all([left, right].map(async (id) => {
      expectOperationOk(await system.coordinator.start({ operationId: `isolation-start-${id}`, moduleId: id as ModuleId }))
    }))
    const leftBefore = system.daemon.get(left as ModuleId)!
    const rightBefore = system.daemon.get(right as ModuleId)!
    await crashAndAwaitHealthyRestart(system, left as ModuleId, leftBefore)
    expect(system.daemon.get(right as ModuleId)).toMatchObject({ state: 'healthy', pid: rightBefore.pid })
    expect(await system.view.query(right as ModuleId)).toMatchObject({ state: 'attached' })
    await Promise.all([left, right].map(async (id) => {
      expectOperationOk(await system.coordinator.stop({ operationId: `isolation-stop-${id}`, moduleId: id as ModuleId }))
    }))
  }, PACKAGED_LIFECYCLE_TIMEOUT_MS)
})

describe('packaged fake module download and extraction failures', () => {
  it('compensates a corrupt artifact download without registry or installed side effects', async () => {
    const packaged = await packagedArchive()
    const id = 'org.simulator.packaged-corrupt-download'
    const system = await createSystem(bundle([{
      id,
      version: '1.0.0',
      ...packaged,
      servedBytes: Buffer.from('corrupt'),
    }]))
    expect((await system.coordinator.install({ ...system.request(id), operationId: 'corrupt-download' })).ok).toBe(false)
    expect(system.registry.snapshot().modules).toHaveLength(0)
  }, 15_000)

  it('compensates extraction failure after a hash-valid invalid archive', async () => {
    const invalid = Buffer.from('hash-valid but not a tar.gz archive')
    const id = 'org.simulator.packaged-extraction-failure'
    const system = await createSystem(bundle([{
      id,
      version: '1.0.0',
      archive: invalid,
      treeHash: 'f'.repeat(64) as ModuleSha256,
    }]))
    expect((await system.coordinator.install({ ...system.request(id), operationId: 'extraction-failure' })).ok).toBe(false)
    expect(system.registry.snapshot().modules).toHaveLength(0)
  }, 15_000)
})
