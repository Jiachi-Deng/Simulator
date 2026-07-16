import { afterEach, describe, expect, it, mock } from 'bun:test'
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IpcMain } from 'electron'
import type {
  ModuleCoordinatorOperationResult,
  ResolvedModuleCoordinatorInstallRequest,
} from '@simulator/module-coordinator'
import {
  OPEN_DESIGN_ACCEPTANCE_DESCRIPTOR_RELATIVE_PATH,
  OPEN_DESIGN_ACCEPTANCE_DESCRIPTOR_CANONICAL_JSON,
  OPEN_DESIGN_ACCEPTANCE_ENV,
  OPEN_DESIGN_ACCEPTANCE_IDENTITY,
  OpenDesignAcceptanceController,
  createOpenDesignAcceptanceRuntimeGate,
  loadOpenDesignAcceptance,
  registerOpenDesignAcceptanceIpc,
  type LoadOpenDesignAcceptanceOptions,
  type OpenDesignAcceptanceBootstrap,
  type OpenDesignAcceptanceRuntime,
} from '../open-design-acceptance'
import { OPEN_DESIGN_ACCEPTANCE_CHANNELS } from '../../shared/open-design-acceptance-ipc'
import { OPEN_DESIGN_MODULE_ID } from '../../shared/open-design-module-ipc'
import type { OpenDesignOfficialChannelBootstrap } from '../open-design-official-channel'

const roots: string[] = []
const PUBLIC_KEY = Uint8Array.from(Buffer.from('KvpR89GuQd670SZMZuuR+aK4FUIprxRlqE58K3twQZk=', 'base64'))
const TEST_NOW = Date.parse('2026-07-16T22:00:00.000Z')

function official(): OpenDesignOfficialChannelBootstrap {
  return {
    status: 'ready',
    channel: {
      githubReleaseRedirectPolicy: {
        owner: OPEN_DESIGN_ACCEPTANCE_IDENTITY.githubOwner,
        repository: OPEN_DESIGN_ACCEPTANCE_IDENTITY.githubRepository,
      },
      releaseRequest: {
        catalogUrl: OPEN_DESIGN_ACCEPTANCE_IDENTITY.stableCatalogUrl,
        moduleId: OPEN_DESIGN_MODULE_ID as any,
        version: OPEN_DESIGN_ACCEPTANCE_IDENTITY.stableVersion as any,
      },
      trustedKeys: [{
        keyId: OPEN_DESIGN_ACCEPTANCE_IDENTITY.trustedKeyId,
        publicKey: PUBLIC_KEY,
        activeFrom: OPEN_DESIGN_ACCEPTANCE_IDENTITY.trustedKeyActiveFrom,
        activeUntil: OPEN_DESIGN_ACCEPTANCE_IDENTITY.trustedKeyActiveUntil,
      }],
    },
  }
}

function descriptor(overrides: Record<string, unknown> = {}) {
  const identity = OPEN_DESIGN_ACCEPTANCE_IDENTITY
  return {
    schemaVersion: identity.schemaVersion,
    hostVersion: identity.hostVersion,
    moduleId: identity.moduleId,
    platform: identity.platform,
    stableVersion: identity.stableVersion,
    stableCatalogUrl: identity.stableCatalogUrl,
    rcVersion: identity.rcVersion,
    releaseTag: identity.releaseTag,
    catalogUrl: identity.catalogUrl,
    minimumCatalogSequence: identity.minimumCatalogSequence,
    initialCatalogIssuedAt: identity.initialCatalogIssuedAt,
    archiveUrl: identity.archiveUrl,
    archiveSha256: identity.archiveSha256,
    artifactSize: identity.artifactSize,
    extractedManifestSha256: identity.extractedManifestSha256,
    entrypoint: identity.entrypoint,
    auxiliaryExecutables: [...identity.auxiliaryExecutables],
    capabilities: [...identity.capabilities],
    hostVersionRange: identity.hostVersionRange,
    githubOwner: identity.githubOwner,
    githubRepository: identity.githubRepository,
    trustedKeyId: identity.trustedKeyId,
    trustedPublicKeySha256: identity.trustedPublicKeySha256,
    trustedKeyActiveFrom: identity.trustedKeyActiveFrom,
    trustedKeyActiveUntil: identity.trustedKeyActiveUntil,
    ...overrides,
  }
}

async function acceptanceRoot(value: unknown = OPEN_DESIGN_ACCEPTANCE_DESCRIPTOR_CANONICAL_JSON): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'simulator-open-design-acceptance-'))
  roots.push(root)
  const path = join(root, OPEN_DESIGN_ACCEPTANCE_DESCRIPTOR_RELATIVE_PATH)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await chmod(dirname(path), 0o700)
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), { encoding: 'utf8', mode: 0o600 })
  await chmod(path, 0o600)
  return root
}

function options(root: string, overrides: Partial<LoadOpenDesignAcceptanceOptions> = {}): LoadOpenDesignAcceptanceOptions {
  return {
    isPackaged: true,
    hostVersion: OPEN_DESIGN_ACCEPTANCE_IDENTITY.hostVersion,
    platform: OPEN_DESIGN_ACCEPTANCE_IDENTITY.platform,
    argv: ['/Applications/Simulator.app/Contents/MacOS/Simulator', '--debug'],
    env: { [OPEN_DESIGN_ACCEPTANCE_ENV]: '1' },
    userDataRoot: root,
    development: { status: 'disabled' },
    official: official(),
    ...overrides,
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('OpenDesign acceptance startup gate', () => {
  it('enables only the fixed public RC request after every gate passes', async () => {
    const root = await acceptanceRoot()
    const result = await loadOpenDesignAcceptance(options(root))
    expect(result).toEqual({
      status: 'ready',
      descriptorPath: join(root, OPEN_DESIGN_ACCEPTANCE_DESCRIPTOR_RELATIVE_PATH),
      releaseRequest: {
        catalogUrl: OPEN_DESIGN_ACCEPTANCE_IDENTITY.catalogUrl,
        moduleId: OPEN_DESIGN_MODULE_ID,
        version: OPEN_DESIGN_ACCEPTANCE_IDENTITY.rcVersion,
      },
    } as any)
    expect(JSON.stringify(result)).not.toContain('publicKey')
  })

  it('fails closed for every process, Host, platform, environment, and channel gate', async () => {
    const root = await acceptanceRoot()
    const invalid: Array<[Partial<LoadOpenDesignAcceptanceOptions>, string]> = [
      [{ isPackaged: false }, 'ACCEPTANCE_REQUIRES_PACKAGED_HOST'],
      [{ hostVersion: '0.12.1' }, 'ACCEPTANCE_HOST_VERSION_MISMATCH'],
      [{ platform: 'darwin-x64' }, 'ACCEPTANCE_PLATFORM_MISMATCH'],
      [{ argv: ['Simulator'] }, 'ACCEPTANCE_REQUIRES_EXPLICIT_DEBUG'],
      [{ env: {} }, 'ACCEPTANCE_ENV_DISABLED'],
      [{ env: { [OPEN_DESIGN_ACCEPTANCE_ENV]: 'true' } }, 'ACCEPTANCE_ENV_DISABLED'],
      [{ development: { status: 'ready', bundle: {} as any } }, 'ACCEPTANCE_DEVELOPMENT_CHANNEL_ACTIVE'],
      [{ development: { status: 'not-ready', errorCode: 'FAILED', errorMessage: 'failed' } }, 'ACCEPTANCE_DEVELOPMENT_CHANNEL_ACTIVE'],
      [{ official: { status: 'not-ready', errorCode: 'FAILED', errorMessage: 'failed' } }, 'ACCEPTANCE_OFFICIAL_TRUST_MISMATCH'],
    ]
    for (const [override, errorCode] of invalid) {
      expect(await loadOpenDesignAcceptance(options(root, override))).toEqual({ status: 'not-ready', errorCode })
    }
  })

  it('pins the code-signed stable trust root and exact GitHub release policy', async () => {
    const root = await acceptanceRoot()
    const mutations = [
      (value: any) => { value.channel.githubReleaseRedirectPolicy.owner = 'attacker' },
      (value: any) => { value.channel.githubReleaseRedirectPolicy.repository = 'Other' },
      (value: any) => { value.channel.releaseRequest.catalogUrl = OPEN_DESIGN_ACCEPTANCE_IDENTITY.catalogUrl },
      (value: any) => { value.channel.releaseRequest.version = '0.14.6-rc.1' },
      (value: any) => { value.channel.trustedKeys[0].keyId = 'other' },
      (value: any) => { value.channel.trustedKeys[0].publicKey = Uint8Array.from(PUBLIC_KEY, (byte) => byte ^ 1) },
      (value: any) => { value.channel.trustedKeys[0].activeFrom = '2026-07-15T00:00:00.001Z' },
      (value: any) => { value.channel.trustedKeys[0].activeUntil = undefined },
      (value: any) => { value.channel.trustedKeys[0].revokedAt = '2026-07-16T00:00:00.000Z' },
      (value: any) => { value.channel.trustedKeys.push(value.channel.trustedKeys[0]) },
    ]
    for (const mutate of mutations) {
      const value = structuredClone(official())
      mutate(value)
      expect(await loadOpenDesignAcceptance(options(root, { official: value }))).toEqual({
        status: 'not-ready',
        errorCode: 'ACCEPTANCE_OFFICIAL_TRUST_MISMATCH',
      })
    }
  })

  it('rejects missing, non-owner-only, linked, non-canonical, and changed-identity descriptors', async () => {
    const missing = await mkdtemp(join(await realpath(tmpdir()), 'simulator-open-design-acceptance-missing-'))
    roots.push(missing)
    expect(await loadOpenDesignAcceptance(options(missing))).toEqual({
      status: 'not-ready', errorCode: 'ACCEPTANCE_DESCRIPTOR_INVALID',
    })

    const looseDirectory = await acceptanceRoot()
    await chmod(join(looseDirectory, 'open-design-acceptance'), 0o755)
    expect(await loadOpenDesignAcceptance(options(looseDirectory))).toEqual({
      status: 'not-ready', errorCode: 'ACCEPTANCE_DESCRIPTOR_INVALID',
    })

    const looseFile = await acceptanceRoot()
    await chmod(join(looseFile, OPEN_DESIGN_ACCEPTANCE_DESCRIPTOR_RELATIVE_PATH), 0o644)
    expect(await loadOpenDesignAcceptance(options(looseFile))).toEqual({
      status: 'not-ready', errorCode: 'ACCEPTANCE_DESCRIPTOR_INVALID',
    })

    const hardLinked = await acceptanceRoot()
    const hardPath = join(hardLinked, OPEN_DESIGN_ACCEPTANCE_DESCRIPTOR_RELATIVE_PATH)
    await link(hardPath, join(hardLinked, 'second-link.json'))
    expect(await loadOpenDesignAcceptance(options(hardLinked))).toEqual({
      status: 'not-ready', errorCode: 'ACCEPTANCE_DESCRIPTOR_INVALID',
    })

    const symbolic = await acceptanceRoot()
    const symbolicPath = join(symbolic, OPEN_DESIGN_ACCEPTANCE_DESCRIPTOR_RELATIVE_PATH)
    const target = join(symbolic, 'target.json')
    await writeFile(target, OPEN_DESIGN_ACCEPTANCE_DESCRIPTOR_CANONICAL_JSON, { mode: 0o600 })
    await rm(symbolicPath)
    await symlink(target, symbolicPath)
    expect(await loadOpenDesignAcceptance(options(symbolic))).toEqual({
      status: 'not-ready', errorCode: 'ACCEPTANCE_DESCRIPTOR_INVALID',
    })

    const symbolicDirectoryRoot = await mkdtemp(join(await realpath(tmpdir()), 'simulator-open-design-acceptance-dir-link-'))
    roots.push(symbolicDirectoryRoot)
    const realDirectory = join(symbolicDirectoryRoot, 'real-acceptance-directory')
    await mkdir(realDirectory, { mode: 0o700 })
    await writeFile(join(realDirectory, 'rc-control-v1.json'), OPEN_DESIGN_ACCEPTANCE_DESCRIPTOR_CANONICAL_JSON, { mode: 0o600 })
    await symlink(realDirectory, join(symbolicDirectoryRoot, 'open-design-acceptance'))
    expect(await loadOpenDesignAcceptance(options(symbolicDirectoryRoot))).toEqual({
      status: 'not-ready', errorCode: 'ACCEPTANCE_DESCRIPTOR_INVALID',
    })

    const identityMismatches: unknown[] = [{ ...descriptor(), extra: true }]
    const baseline = descriptor()
    for (const [field, value] of Object.entries(baseline)) {
      const invalid = structuredClone(baseline) as Record<string, unknown>
      invalid[field] = Array.isArray(value)
        ? [...value, 'unexpected']
        : typeof value === 'number'
          ? value + 1
          : `${value}-unexpected`
      identityMismatches.push(invalid)
    }
    for (const invalid of identityMismatches) {
      const root = await acceptanceRoot(invalid)
      expect(await loadOpenDesignAcceptance(options(root))).toEqual({
        status: 'not-ready', errorCode: 'ACCEPTANCE_DESCRIPTOR_IDENTITY_MISMATCH',
      })
    }

    for (const nonCanonical of [
      ` ${OPEN_DESIGN_ACCEPTANCE_DESCRIPTOR_CANONICAL_JSON}`,
      OPEN_DESIGN_ACCEPTANCE_DESCRIPTOR_CANONICAL_JSON.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
      `${JSON.stringify(Object.fromEntries(Object.entries(descriptor()).reverse()))}\n`,
      OPEN_DESIGN_ACCEPTANCE_DESCRIPTOR_CANONICAL_JSON.trimEnd(),
    ]) {
      const root = await acceptanceRoot(nonCanonical)
      expect(await loadOpenDesignAcceptance(options(root))).toEqual({
        status: 'not-ready', errorCode: 'ACCEPTANCE_DESCRIPTOR_IDENTITY_MISMATCH',
      })
    }
  })
})

function readyBootstrap(): Extract<OpenDesignAcceptanceBootstrap, { status: 'ready' }> {
  return {
    status: 'ready',
    descriptorPath: '/owner-only/descriptor.json',
    releaseRequest: {
      catalogUrl: OPEN_DESIGN_ACCEPTANCE_IDENTITY.catalogUrl,
      moduleId: OPEN_DESIGN_MODULE_ID as any,
      version: OPEN_DESIGN_ACCEPTANCE_IDENTITY.rcVersion as any,
    },
  }
}

function resolvedRequest(overrides: Record<string, unknown> = {}): ResolvedModuleCoordinatorInstallRequest {
  const identity = OPEN_DESIGN_ACCEPTANCE_IDENTITY
  const request = {
    catalogUrl: identity.catalogUrl,
    hostVersionRange: identity.hostVersionRange,
    catalogEvidence: {
      schemaVersion: 1,
      sequence: identity.minimumCatalogSequence,
      issuedAt: identity.initialCatalogIssuedAt,
      expiresAt: '2026-07-17T17:35:33.862Z',
      artifactSize: identity.artifactSize,
    },
    descriptor: {
      verified: true,
      format: 'tar.gz',
      extractedManifestSha256: identity.extractedManifestSha256,
      artifact: {
        platform: identity.platform,
        entrypoint: identity.entrypoint,
        auxiliaryExecutables: [...identity.auxiliaryExecutables],
        url: identity.archiveUrl,
        sha256: identity.archiveSha256,
      },
      manifest: {
        schemaVersion: 1,
        id: identity.moduleId,
        version: identity.rcVersion,
        capabilities: [...identity.capabilities],
        artifacts: [{
          platform: identity.platform,
          entrypoint: identity.entrypoint,
          auxiliaryExecutables: [...identity.auxiliaryExecutables],
          url: identity.archiveUrl,
          sha256: identity.archiveSha256,
        }],
      },
    },
    ...overrides,
  }
  return request as unknown as ResolvedModuleCoordinatorInstallRequest
}

function result(
  kind: 'update' | 'rollback',
  operationId: string,
  ok = true,
  activeVersion: string = OPEN_DESIGN_ACCEPTANCE_IDENTITY.rcVersion,
  lastKnownGoodVersion: string = OPEN_DESIGN_ACCEPTANCE_IDENTITY.stableVersion,
): ModuleCoordinatorOperationResult {
  return {
    operationId,
    moduleId: OPEN_DESIGN_MODULE_ID as any,
    kind,
    ok,
    source: {
      activeVersion: OPEN_DESIGN_ACCEPTANCE_IDENTITY.stableVersion as any,
      lastKnownGoodVersion: null,
      running: false,
      viewAttached: false,
      registryPresent: true,
    },
    target: {
      activeVersion: activeVersion as any,
      lastKnownGoodVersion: lastKnownGoodVersion as any,
      running: true,
      viewAttached: true,
      registryPresent: true,
    },
    completedAt: 1,
  }
}

function controllerHarness(initialActive: string | null = '0.14.5', initialLkg: string | null = null) {
  let activeVersion = initialActive
  let lastKnownGoodVersion = initialLkg
  let daemonSnapshot: any = initialActive === null ? undefined : {
    id: OPEN_DESIGN_MODULE_ID,
    version: initialActive,
    state: 'healthy',
    restartCount: 0,
  }
  let viewSnapshot: any = initialActive === null ? undefined : {
    moduleId: OPEN_DESIGN_MODULE_ID,
    version: initialActive,
    state: 'attached',
  }
  let installedVersions: string[] = initialActive === OPEN_DESIGN_ACCEPTANCE_IDENTITY.rcVersion
    || initialLkg === OPEN_DESIGN_ACCEPTANCE_IDENTITY.rcVersion
    ? [OPEN_DESIGN_ACCEPTANCE_IDENTITY.stableVersion, OPEN_DESIGN_ACCEPTANCE_IDENTITY.rcVersion]
    : [OPEN_DESIGN_ACCEPTANCE_IDENTITY.stableVersion]
  const resolveInstallRequest = mock(async () => resolvedRequest())
  const update = mock(async (request: any) => {
    activeVersion = OPEN_DESIGN_ACCEPTANCE_IDENTITY.rcVersion
    lastKnownGoodVersion = OPEN_DESIGN_ACCEPTANCE_IDENTITY.stableVersion
    installedVersions = [OPEN_DESIGN_ACCEPTANCE_IDENTITY.stableVersion, OPEN_DESIGN_ACCEPTANCE_IDENTITY.rcVersion]
    daemonSnapshot = { ...daemonSnapshot, id: OPEN_DESIGN_MODULE_ID, version: activeVersion, state: 'healthy' }
    viewSnapshot = { moduleId: OPEN_DESIGN_MODULE_ID, version: activeVersion, state: 'attached' }
    return result('update', request.operationId)
  })
  const rollback = mock(async (request: any) => {
    const previous = activeVersion
    activeVersion = lastKnownGoodVersion
    lastKnownGoodVersion = previous
    daemonSnapshot = { ...daemonSnapshot, id: OPEN_DESIGN_MODULE_ID, version: activeVersion, state: 'healthy' }
    viewSnapshot = { moduleId: OPEN_DESIGN_MODULE_ID, version: activeVersion, state: 'attached' }
    return result('rollback', request.operationId, true, activeVersion!, lastKnownGoodVersion!)
  })
  const runtime: OpenDesignAcceptanceRuntime = {
    coordinator: { resolveInstallRequest, update, rollback },
    registry: {
      snapshot: () => ({
        host: { version: '0.12.0', platform: 'darwin-arm64' },
        diagnostics: [],
        modules: [{
          id: OPEN_DESIGN_MODULE_ID,
          disabled: false,
          activeVersion,
          lastKnownGoodVersion,
          versions: installedVersions.map((version) => ({ version })),
        }],
      } as any),
    },
    daemon: { get: mock(() => daemonSnapshot) },
    view: { query: mock(async () => viewSnapshot) },
  }
  const controller = new OpenDesignAcceptanceController({
    bootstrap: readyBootstrap(),
    getRuntime: () => runtime,
    host: { isAllowedSender: (sender) => sender === 'host' },
    operationId: (action) => `fixed-${action}`,
    now: () => TEST_NOW,
  })
  return {
    controller,
    runtime,
    resolveInstallRequest,
    update,
    rollback,
    setState(active: string | null, lkg: string | null) {
      activeVersion = active
      lastKnownGoodVersion = lkg
    },
    setInstalledVersions(versions: string[]) {
      installedVersions = [...versions]
    },
    setDaemon(state: string | undefined, version: string | null = activeVersion) {
      daemonSnapshot = state === undefined || version === null ? undefined : {
        id: OPEN_DESIGN_MODULE_ID,
        version,
        state,
        restartCount: 0,
      }
    },
    setView(state: string | undefined, version: string | null = activeVersion) {
      viewSnapshot = state === undefined || version === null ? undefined : {
        moduleId: OPEN_DESIGN_MODULE_ID,
        version,
        state,
      }
    },
  }
}

describe('OpenDesign acceptance controller', () => {
  it('keeps the runtime unavailable until recovery completes and resets fail-closed', async () => {
    const harness = controllerHarness()
    const gate = createOpenDesignAcceptanceRuntimeGate(() => harness.runtime)
    const controller = new OpenDesignAcceptanceController({
      bootstrap: readyBootstrap(),
      getRuntime: gate.getRuntime,
      host: { isAllowedSender: () => true },
    })
    expect(gate.getRuntime()).toBeUndefined()
    expect(await controller.getState()).toMatchObject({
      status: 'error', errorCode: 'ACCEPTANCE_RUNTIME_UNAVAILABLE',
    })
    const markRecovered = gate.beginRecovery()
    markRecovered()
    expect(gate.getRuntime()).toBe(harness.runtime)
    expect(await controller.getState()).toMatchObject({
      status: 'ready', running: true, viewAttached: true,
    })
    gate.reset()
    expect(gate.getRuntime()).toBeUndefined()
    expect(await controller.getState()).toMatchObject({
      status: 'error', errorCode: 'ACCEPTANCE_RUNTIME_UNAVAILABLE',
    })
    const staleCompletion = gate.beginRecovery()
    gate.reset()
    staleCompletion()
    expect(gate.getRuntime()).toBeUndefined()
    const completionAfterQuit = gate.beginRecovery()
    gate.close()
    completionAfterQuit()
    expect(gate.getRuntime()).toBeUndefined()
  })

  it('resolves the fixed signed public RC and binds exact evidence into the real update call', async () => {
    const harness = controllerHarness()
    const state = await harness.controller.updateToRc()
    expect(harness.resolveInstallRequest).toHaveBeenCalledWith(readyBootstrap().releaseRequest)
    expect(harness.update).toHaveBeenCalledTimes(1)
    expect(harness.update.mock.calls[0]?.[0]).toMatchObject({
      catalogUrl: OPEN_DESIGN_ACCEPTANCE_IDENTITY.catalogUrl,
      operationId: 'fixed-updateToRc',
      catalogEvidence: {
        schemaVersion: 1,
        sequence: 2,
        artifactSize: 61_478_074,
      },
    })
    expect(state).toMatchObject({
      status: 'ready',
      activeVersion: '0.14.6-rc.1',
      lastKnownGoodVersion: '0.14.5',
      installedVersions: ['0.14.5', '0.14.6-rc.1'],
      operation: { operationId: 'fixed-updateToRc', kind: 'update', ok: true },
    })
  })

  it('fails closed before update for any missing, stale, or mismatched resolved identity', async () => {
    const mutations: Array<(request: any) => void> = [
      (request) => { delete request.catalogEvidence },
      (request) => { request.catalogEvidence.schemaVersion = 2 },
      (request) => { request.catalogEvidence.sequence = 1 },
      (request) => { request.catalogEvidence.issuedAt = '2026-07-16T21:35:33.861Z' },
      (request) => { request.catalogEvidence.issuedAt = 'not-a-time' },
      (request) => { request.catalogEvidence.expiresAt = 'not-a-time' },
      (request) => { request.catalogEvidence.expiresAt = '2026-07-16T21:59:59.000Z' },
      (request) => { request.catalogEvidence.artifactSize += 1 },
      (request) => { request.hostVersionRange = '>=0.11.1' },
      (request) => { request.descriptor.extractedManifestSha256 = '0'.repeat(64) },
      (request) => { request.descriptor.manifest.capabilities.reverse() },
      (request) => { request.descriptor.manifest.artifacts[0].url = 'https://example.test/archive.tar.gz' },
      (request) => { request.descriptor.artifact.entrypoint = 'other' },
      (request) => { request.descriptor.artifact.auxiliaryExecutables.reverse() },
      (request) => { request.descriptor.artifact.sha256 = '0'.repeat(64) },
    ]
    for (const mutate of mutations) {
      const harness = controllerHarness()
      harness.resolveInstallRequest.mockImplementationOnce(async () => {
        const request = structuredClone(resolvedRequest()) as any
        mutate(request)
        return request
      })
      expect(await harness.controller.updateToRc()).toMatchObject({
        status: 'error',
        activeVersion: '0.14.5',
        lastKnownGoodVersion: null,
        errorCode: 'ACCEPTANCE_RESOLVED_RELEASE_IDENTITY_MISMATCH',
      })
      expect(harness.update).not.toHaveBeenCalled()
    }
  })

  it('only updates from the frozen baseline and only rolls back the exact RC/LKG pair', async () => {
    const wrongBaseline = controllerHarness('0.14.5', '0.14.6-rc.1')
    expect(await wrongBaseline.controller.updateToRc()).toMatchObject({
      status: 'error', errorCode: 'ACCEPTANCE_UPDATE_BASELINE_MISMATCH',
    })
    expect(wrongBaseline.resolveInstallRequest).not.toHaveBeenCalled()

    const extraBaselineVersion = controllerHarness()
    extraBaselineVersion.setInstalledVersions(['0.14.4', '0.14.5'])
    expect(await extraBaselineVersion.controller.updateToRc()).toMatchObject({
      status: 'error', errorCode: 'ACCEPTANCE_UPDATE_BASELINE_MISMATCH',
    })
    expect(extraBaselineVersion.resolveInstallRequest).not.toHaveBeenCalled()

    const wrongPair = controllerHarness('0.14.6-rc.1', null)
    expect(await wrongPair.controller.rollback()).toMatchObject({
      status: 'error', errorCode: 'ACCEPTANCE_ROLLBACK_PAIR_MISMATCH',
    })
    expect(wrongPair.rollback).not.toHaveBeenCalled()

    const extraRollbackVersion = controllerHarness('0.14.6-rc.1', '0.14.5')
    extraRollbackVersion.setInstalledVersions(['0.14.4', '0.14.5', '0.14.6-rc.1'])
    expect(await extraRollbackVersion.controller.rollback()).toMatchObject({
      status: 'error', errorCode: 'ACCEPTANCE_ROLLBACK_PAIR_MISMATCH',
    })
    expect(extraRollbackVersion.rollback).not.toHaveBeenCalled()

    const harness = controllerHarness('0.14.6-rc.1', '0.14.5')
    expect(await harness.controller.rollback()).toMatchObject({
      activeVersion: '0.14.5', lastKnownGoodVersion: '0.14.6-rc.1',
    })
    expect(harness.rollback).toHaveBeenLastCalledWith({
      moduleId: OPEN_DESIGN_MODULE_ID,
      restartAfterRollback: true,
      operationId: 'fixed-rollback',
    })
    expect(await harness.controller.rollback()).toMatchObject({
      activeVersion: '0.14.6-rc.1', lastKnownGoodVersion: '0.14.5',
    })
    expect(harness.rollback).toHaveBeenCalledTimes(2)
  })

  it('refuses rollback before mutation unless the source daemon and view are exactly ready', async () => {
    const cases: Array<[string, (harness: ReturnType<typeof controllerHarness>) => void]> = [
      ['stopped daemon', (harness) => harness.setDaemon('stopped')],
      ['degraded daemon', (harness) => harness.setDaemon('degraded')],
      ['wrong daemon version', (harness) => harness.setDaemon('healthy', '0.14.5')],
      ['missing daemon', (harness) => harness.setDaemon(undefined)],
      ['detached view', (harness) => harness.setView('detached')],
      ['wrong view version', (harness) => harness.setView('attached', '0.14.5')],
      ['missing view', (harness) => harness.setView(undefined)],
    ]
    for (const [, configure] of cases) {
      const harness = controllerHarness('0.14.6-rc.1', '0.14.5')
      configure(harness)
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(await harness.controller.rollback()).toMatchObject({
          status: 'error',
          activeVersion: '0.14.6-rc.1',
          lastKnownGoodVersion: '0.14.5',
          errorCode: 'ACCEPTANCE_ROLLBACK_SOURCE_NOT_READY',
        })
      }
      expect(harness.rollback).not.toHaveBeenCalled()
    }

    const queryFailure = controllerHarness('0.14.6-rc.1', '0.14.5')
    ;(queryFailure.runtime.view.query as any).mockImplementation(async () => {
      throw new Error('view query failed at /private/path')
    })
    expect(await queryFailure.controller.rollback()).toMatchObject({
      status: 'error', errorCode: 'ACCEPTANCE_STATE_UNAVAILABLE',
    })
    expect(queryFailure.rollback).not.toHaveBeenCalled()

    const daemonQueryFailure = controllerHarness('0.14.6-rc.1', '0.14.5')
    ;(daemonQueryFailure.runtime.daemon.get as any).mockImplementation(() => {
      throw new Error('daemon query failed at /private/path')
    })
    expect(await daemonQueryFailure.controller.rollback()).toMatchObject({
      status: 'error', errorCode: 'ACCEPTANCE_STATE_UNAVAILABLE',
    })
    expect(daemonQueryFailure.rollback).not.toHaveBeenCalled()
  })

  it('contains Coordinator failures, preserves safe state, and never exposes raw errors', async () => {
    const harness = controllerHarness()
    harness.update.mockImplementationOnce(async () => { throw new Error('secret-token=/private/path') })
    const state = await harness.controller.updateToRc()
    expect(state).toMatchObject({
      status: 'error',
      activeVersion: '0.14.5',
      lastKnownGoodVersion: null,
      errorCode: 'ACCEPTANCE_UPDATE_FAILED',
    })
    expect(JSON.stringify(state)).not.toContain('secret-token')
    expect(JSON.stringify(state)).not.toContain('/private/path')

    const resolutionFailure = controllerHarness()
    resolutionFailure.resolveInstallRequest.mockImplementationOnce(async () => {
      throw new Error('signed catalog unavailable at /private/catalog-cache')
    })
    expect(await resolutionFailure.controller.updateToRc()).toMatchObject({
      status: 'error',
      activeVersion: '0.14.5',
      errorCode: 'ACCEPTANCE_UPDATE_FAILED',
    })
    expect(resolutionFailure.update).not.toHaveBeenCalled()

    const negativeResult = controllerHarness()
    negativeResult.update.mockImplementationOnce(async (request: any) => result('update', request.operationId, false))
    expect(await negativeResult.controller.updateToRc()).toMatchObject({
      status: 'error',
      activeVersion: '0.14.5',
      errorCode: 'ACCEPTANCE_UPDATE_FAILED',
      operation: { kind: 'update', ok: false },
    })

    const unavailable = new OpenDesignAcceptanceController({
      bootstrap: readyBootstrap(),
      getRuntime: () => undefined,
      host: { isAllowedSender: () => true },
    })
    expect(await unavailable.getState()).toMatchObject({
      status: 'error', errorCode: 'ACCEPTANCE_RUNTIME_UNAVAILABLE',
    })

    const lookupFailure = new OpenDesignAcceptanceController({
      bootstrap: readyBootstrap(),
      getRuntime: () => { throw new Error('secret runtime lookup') },
      host: { isAllowedSender: () => true },
    })
    const lookupFailureState = await lookupFailure.getState()
    expect(lookupFailureState).toMatchObject({
      status: 'error', errorCode: 'ACCEPTANCE_RUNTIME_LOOKUP_FAILED',
    })
    expect(JSON.stringify(lookupFailureState)).not.toContain('secret runtime lookup')

    const stateFailure = controllerHarness()
    ;(stateFailure.runtime.registry as any).snapshot = () => { throw new Error('secret registry path') }
    const unavailableState = await stateFailure.controller.getState()
    expect(unavailableState).toMatchObject({ status: 'error', errorCode: 'ACCEPTANCE_STATE_UNAVAILABLE' })
    expect(JSON.stringify(unavailableState)).not.toContain('secret registry path')
  })

  it('latches the first control error and prevents every later mutation until controller restart', async () => {
    const identityFailure = controllerHarness()
    identityFailure.resolveInstallRequest.mockImplementationOnce(async () => resolvedRequest({
      catalogUrl: 'https://example.test/foreign-catalog.json',
    }))
    const identityState = await identityFailure.controller.updateToRc()
    expect(identityState.errorCode).toBe('ACCEPTANCE_RESOLVED_RELEASE_IDENTITY_MISMATCH')
    expect((await identityFailure.controller.updateToRc()).errorCode).toBe(identityState.errorCode)
    expect((await identityFailure.controller.rollback()).errorCode).toBe(identityState.errorCode)
    expect(identityFailure.resolveInstallRequest).toHaveBeenCalledTimes(1)
    expect(identityFailure.update).not.toHaveBeenCalled()
    expect(identityFailure.rollback).not.toHaveBeenCalled()

    const coordinatorFailure = controllerHarness()
    coordinatorFailure.update.mockImplementationOnce(async () => { throw new Error('coordinator failed') })
    const coordinatorState = await coordinatorFailure.controller.updateToRc()
    expect(coordinatorState.errorCode).toBe('ACCEPTANCE_UPDATE_FAILED')
    await coordinatorFailure.controller.updateToRc()
    await coordinatorFailure.controller.rollback()
    expect(coordinatorFailure.resolveInstallRequest).toHaveBeenCalledTimes(1)
    expect(coordinatorFailure.update).toHaveBeenCalledTimes(1)
    expect(coordinatorFailure.rollback).not.toHaveBeenCalled()

    const postconditionFailure = controllerHarness()
    postconditionFailure.update.mockImplementationOnce(async (request: any) => result('update', request.operationId))
    const postconditionState = await postconditionFailure.controller.updateToRc()
    expect(postconditionState.errorCode).toBe('ACCEPTANCE_POSTCONDITION_MISMATCH')
    await postconditionFailure.controller.updateToRc()
    expect(postconditionFailure.resolveInstallRequest).toHaveBeenCalledTimes(1)
    expect(postconditionFailure.update).toHaveBeenCalledTimes(1)

    const unavailableHarness = controllerHarness()
    let recovered = false
    const unavailableController = new OpenDesignAcceptanceController({
      bootstrap: readyBootstrap(),
      getRuntime: () => recovered ? unavailableHarness.runtime : undefined,
      host: { isAllowedSender: () => true },
    })
    expect((await unavailableController.updateToRc()).errorCode).toBe('ACCEPTANCE_OPERATION_RUNTIME_UNAVAILABLE')
    recovered = true
    expect((await unavailableController.updateToRc()).errorCode).toBe('ACCEPTANCE_OPERATION_RUNTIME_UNAVAILABLE')
    expect(unavailableHarness.resolveInstallRequest).not.toHaveBeenCalled()
    expect(unavailableHarness.update).not.toHaveBeenCalled()
  })

  it('rejects mismatched Coordinator identities and claimed success without exact Registry postconditions', async () => {
    for (const mutate of [
      (value: any) => { value.moduleId = 'org.simulator.other' },
      (value: any) => { value.kind = 'install' },
      (value: any) => { value.operationId = 'foreign-operation' },
    ]) {
      const harness = controllerHarness()
      harness.update.mockImplementationOnce(async (request: any) => {
        const value = result('update', request.operationId)
        mutate(value)
        return value
      })
      const state = await harness.controller.updateToRc()
      expect(state).toMatchObject({
        status: 'error', errorCode: 'ACCEPTANCE_COORDINATOR_RESULT_MISMATCH',
      })
      expect(state.operation).toBeUndefined()
    }

    const noStateTransition = controllerHarness()
    noStateTransition.update.mockImplementationOnce(async (request: any) => result('update', request.operationId))
    const noStateTransitionState = await noStateTransition.controller.updateToRc()
    expect(noStateTransitionState).toMatchObject({
      status: 'error',
      activeVersion: '0.14.5',
      lastKnownGoodVersion: null,
      errorCode: 'ACCEPTANCE_POSTCONDITION_MISMATCH',
    })
    expect(noStateTransitionState.operation).toBeUndefined()

    const wrongTarget = controllerHarness()
    wrongTarget.update.mockImplementationOnce(async (request: any) => {
      wrongTarget.setState('0.14.6-rc.1', '0.14.5')
      return result('update', request.operationId, true, '0.14.5', '0.14.6-rc.1')
    })
    const wrongTargetState = await wrongTarget.controller.updateToRc()
    expect(wrongTargetState).toMatchObject({
      status: 'error', errorCode: 'ACCEPTANCE_POSTCONDITION_MISMATCH',
    })
    expect(wrongTargetState.operation).toBeUndefined()

    const mixedInstalledVersions = controllerHarness()
    mixedInstalledVersions.update.mockImplementationOnce(async (request: any) => {
      mixedInstalledVersions.setState('0.14.6-rc.1', '0.14.5')
      mixedInstalledVersions.setInstalledVersions(['0.14.4', '0.14.5', '0.14.6-rc.1'])
      return result('update', request.operationId)
    })
    const mixedState = await mixedInstalledVersions.controller.updateToRc()
    expect(mixedState).toMatchObject({
      status: 'error', errorCode: 'ACCEPTANCE_POSTCONDITION_MISMATCH',
    })
    expect(mixedState.operation).toBeUndefined()
  })

  it('rejects claimed success unless the real daemon and view match the active version', async () => {
    const cases: Array<[string, (harness: ReturnType<typeof controllerHarness>) => void]> = [
      ['stopped daemon', (harness) => harness.setDaemon('stopped')],
      ['degraded daemon', (harness) => harness.setDaemon('degraded')],
      ['wrong daemon version', (harness) => harness.setDaemon('healthy', '0.14.5')],
      ['missing daemon', (harness) => harness.setDaemon(undefined)],
      ['detached view', (harness) => harness.setView('detached')],
      ['wrong view version', (harness) => harness.setView('attached', '0.14.5')],
      ['missing view', (harness) => harness.setView(undefined)],
    ]
    for (const [, configure] of cases) {
      const harness = controllerHarness()
      harness.update.mockImplementationOnce(async (request: any) => {
        harness.setState('0.14.6-rc.1', '0.14.5')
        harness.setInstalledVersions(['0.14.5', '0.14.6-rc.1'])
        harness.setDaemon('healthy')
        harness.setView('attached')
        configure(harness)
        return result('update', request.operationId)
      })
      const state = await harness.controller.updateToRc()
      expect(state).toMatchObject({
        status: 'error', errorCode: 'ACCEPTANCE_POSTCONDITION_MISMATCH',
      })
      expect(state.operation).toBeUndefined()
    }
  })

  it('coalesces concurrent invocations so a queued renderer call cannot chain update then rollback', async () => {
    const harness = controllerHarness()
    let release: ((request: ResolvedModuleCoordinatorInstallRequest) => void) | undefined
    harness.resolveInstallRequest.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const update = harness.controller.updateToRc()
    const rollback = harness.controller.rollback()
    expect(rollback).toBe(update)
    expect((await harness.controller.getState()).status).toBe('busy')
    release?.(resolvedRequest())
    await update
    expect(harness.update).toHaveBeenCalledTimes(1)
    expect(harness.rollback).not.toHaveBeenCalled()
  })
})

describe('OpenDesign acceptance IPC', () => {
  it('registers one explicit false availability reply and no mutation handlers when the gate is off', () => {
    const invokeHandlers = new Map<string, unknown>()
    const listeners = new Map<string, (event: any) => void>()
    const ipc = {
      handle(channel: string, handler: unknown) { invokeHandlers.set(channel, handler) },
      removeHandler(channel: string) { invokeHandlers.delete(channel) },
      on(channel: string, handler: (event: any) => void) {
        if (listeners.has(channel)) throw new Error('duplicate listener')
        listeners.set(channel, handler)
      },
      removeListener(channel: string, handler: (event: any) => void) {
        if (listeners.get(channel) === handler) listeners.delete(channel)
      },
    } as unknown as Pick<IpcMain, 'handle' | 'removeHandler' | 'on' | 'removeListener'>

    const registration = registerOpenDesignAcceptanceIpc(ipc)
    expect(invokeHandlers.size).toBe(0)
    expect([...listeners.keys()]).toEqual([OPEN_DESIGN_ACCEPTANCE_CHANNELS.IS_AVAILABLE])
    const event: { returnValue: boolean | undefined } = { returnValue: undefined }
    listeners.get(OPEN_DESIGN_ACCEPTANCE_CHANNELS.IS_AVAILABLE)?.(event)
    expect(event.returnValue).toBe(false)
    registration.dispose()
    expect(listeners.size).toBe(0)
  })

  it('registers only fixed no-input channels and validates Host main-frame senders', async () => {
    const harness = controllerHarness()
    const invokeHandlers = new Map<string, (event: any, ...args: unknown[]) => unknown>()
    const listeners = new Map<string, (event: any) => void>()
    const ipc = {
      handle(channel: string, handler: (event: any, ...args: unknown[]) => unknown) {
        if (invokeHandlers.has(channel)) throw new Error('duplicate invoke')
        invokeHandlers.set(channel, handler)
      },
      removeHandler(channel: string) { invokeHandlers.delete(channel) },
      on(channel: string, handler: (event: any) => void) {
        if (listeners.has(channel)) throw new Error('duplicate listener')
        listeners.set(channel, handler)
      },
      removeListener(channel: string, handler: (event: any) => void) {
        if (listeners.get(channel) === handler) listeners.delete(channel)
      },
    } as unknown as Pick<IpcMain, 'handle' | 'removeHandler' | 'on' | 'removeListener'>

    const first = registerOpenDesignAcceptanceIpc(ipc, harness.controller)
    expect([...invokeHandlers.keys()].sort()).toEqual([
      OPEN_DESIGN_ACCEPTANCE_CHANNELS.GET_STATE,
      OPEN_DESIGN_ACCEPTANCE_CHANNELS.ROLLBACK,
      OPEN_DESIGN_ACCEPTANCE_CHANNELS.UPDATE_TO_RC,
    ].sort())
    expect([...listeners.keys()]).toEqual([OPEN_DESIGN_ACCEPTANCE_CHANNELS.IS_AVAILABLE])

    const sender = { mainFrame: {} }
    const valid = { sender: 'host', senderFrame: undefined, returnValue: undefined } as any
    valid.sender = sender
    sender.mainFrame = valid.senderFrame = {}
    // Match the controller's fixed Host sender for this IPC-specific harness.
    const ipcController = new OpenDesignAcceptanceController({
      bootstrap: readyBootstrap(),
      getRuntime: () => harness.runtime,
      host: { isAllowedSender: (candidate) => candidate === sender },
    })
    first.dispose()
    const registration = registerOpenDesignAcceptanceIpc(ipc, ipcController)
    listeners.get(OPEN_DESIGN_ACCEPTANCE_CHANNELS.IS_AVAILABLE)?.(valid)
    expect(valid.returnValue).toBe(true)
    const foreign = { sender: {}, senderFrame: {}, returnValue: undefined }
    listeners.get(OPEN_DESIGN_ACCEPTANCE_CHANNELS.IS_AVAILABLE)?.(foreign)
    expect((foreign as any).returnValue).toBe(false)

    const getState = invokeHandlers.get(OPEN_DESIGN_ACCEPTANCE_CHANNELS.GET_STATE)!
    expect(await getState(valid)).toMatchObject({ activeVersion: '0.14.5' })
    await expect(Promise.resolve().then(() => getState(valid, {}))).rejects.toThrow('do not accept input')
    await expect(Promise.resolve().then(() => getState({ sender: {}, senderFrame: {} }))).rejects.toThrow('sender was rejected')
    await expect(Promise.resolve().then(() => getState({ sender, senderFrame: {} }))).rejects.toThrow('sender was rejected')

    const replacement = registerOpenDesignAcceptanceIpc(ipc, ipcController)
    expect(invokeHandlers.size).toBe(3)
    registration.dispose()
    expect(invokeHandlers.size).toBe(3)
    replacement.dispose()
    replacement.dispose()
    expect(invokeHandlers.size).toBe(0)
    expect(listeners.size).toBe(0)
  })
})
