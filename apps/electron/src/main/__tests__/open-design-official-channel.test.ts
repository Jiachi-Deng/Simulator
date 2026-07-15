import { afterEach, describe, expect, it, mock } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ModuleCoordinatorInstallRequest } from '@simulator/module-coordinator'
import type { LoadedDevelopmentModuleBundle } from '../development-module-bundle'
import {
  loadOpenDesignOfficialChannel,
  OPEN_DESIGN_OFFICIAL_CHANNEL_CONFIG_RELATIVE_PATH,
  resolveOpenDesignHostInstallRequest,
  selectOpenDesignHostChannel,
} from '../open-design-official-channel'
import { OPEN_DESIGN_MODULE_ID } from '../../shared/open-design-module-ipc'

const roots: string[] = []
const CATALOG_URL = 'https://github.com/Jiachi-Deng/Simulator/releases/download/open-design-v0.14.1/open-design-catalog.json'

function publicKeyBase64(): string {
  const pair = generateKeyPairSync('ed25519')
  const der = pair.publicKey.export({ format: 'der', type: 'spki' })
  return Buffer.from(der.subarray(der.byteLength - 32)).toString('base64')
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    moduleId: OPEN_DESIGN_MODULE_ID,
    version: '0.14.1',
    platform: 'darwin-arm64',
    catalogUrl: CATALOG_URL,
    githubRelease: {
      owner: 'Jiachi-Deng',
      repository: 'Simulator',
      tag: 'open-design-v0.14.1',
    },
    trustedKeys: [{
      keyId: 'open-design-release-2026',
      publicKey: publicKeyBase64(),
      activeFrom: '2026-07-01T00:00:00.000Z',
    }],
    ...overrides,
  }
}

async function packagedFixture(value: unknown = config()): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'simulator-open-design-channel-'))
  roots.push(root)
  const path = join(root, OPEN_DESIGN_OFFICIAL_CHANNEL_CONFIG_RELATIVE_PATH)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('loadOpenDesignOfficialChannel', () => {
  it('loads a strict packaged exact-tag channel with built-in public trust roots', async () => {
    const resourcesPath = await packagedFixture()
    const result = await loadOpenDesignOfficialChannel({
      isPackaged: true,
      resourcesPath,
      platform: 'darwin-arm64',
    })

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error('Expected official channel to be ready')
    expect(result.channel.releaseRequest.catalogUrl).toBe(CATALOG_URL)
    expect(String(result.channel.releaseRequest.moduleId)).toBe(OPEN_DESIGN_MODULE_ID)
    expect(String(result.channel.releaseRequest.version)).toBe('0.14.1')
    expect(result.channel.githubReleaseRedirectPolicy).toEqual({ owner: 'Jiachi-Deng', repository: 'Simulator' })
    expect(result.channel.trustedKeys).toHaveLength(1)
    expect(result.channel.trustedKeys[0]?.publicKey).toBeInstanceOf(Uint8Array)
    expect(result.channel.trustedKeys[0]?.publicKey.byteLength).toBe(32)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.channel)).toBe(true)
    expect(Object.isFrozen(result.channel.trustedKeys)).toBe(true)
  })

  it('is production-neutral not-ready outside a packaged app or when config is absent', async () => {
    const resourcesPath = await packagedFixture()
    expect(await loadOpenDesignOfficialChannel({
      isPackaged: false,
      resourcesPath,
      platform: 'darwin-arm64',
    })).toMatchObject({ status: 'not-ready', errorCode: 'OFFICIAL_CHANNEL_PACKAGED_CONFIG_UNAVAILABLE' })

    const missingRoot = await mkdtemp(join(tmpdir(), 'simulator-open-design-channel-missing-'))
    roots.push(missingRoot)
    const missing = await loadOpenDesignOfficialChannel({
      isPackaged: true,
      resourcesPath: missingRoot,
      platform: 'darwin-arm64',
    })
    expect(missing).toMatchObject({ status: 'not-ready', errorCode: 'OFFICIAL_CHANNEL_CONFIG_MISSING' })
    expect(JSON.stringify(missing)).not.toContain(missingRoot)
  })

  it('rejects fields that could redirect trust, target another build, or weaken exact-tag transport', async () => {
    const base = config()
    const invalid = [
      { ...base, unknown: true },
      { ...base, moduleId: 'org.simulator.other' },
      { ...base, version: '0.14' },
      { ...base, platform: 'darwin-x64' },
      { ...base, catalogUrl: `${CATALOG_URL}?token=unsafe` },
      { ...base, catalogUrl: 'https://github.com/attacker/Simulator/releases/download/open-design-v0.14.1/open-design-catalog.json' },
      { ...base, catalogUrl: 'https://github.com/Jiachi-Deng/Simulator/releases/latest/download/open-design-catalog.json' },
      { ...base, catalogUrl: 'https://github.com/Jiachi-Deng/Simulator/releases/download/open-design-v0.14.1%2F..%2Fevil/open-design-catalog.json' },
      { ...base, githubRelease: { owner: 'attacker', repository: 'Simulator', tag: 'open-design-v0.14.1' } },
      { ...base, githubRelease: { owner: 'Jiachi-Deng', repository: 'Simulator', tag: 'latest' } },
      { ...base, githubRelease: { owner: 'Jiachi-Deng', repository: 'Simulator', tag: 'open-design-v0.14.1', extra: true } },
      { ...base, trustedKeys: [] },
      { ...base, trustedKeys: [{ keyId: 'release', publicKey: 'not-base64', activeFrom: '2026-07-01T00:00:00.000Z' }] },
      { ...base, trustedKeys: [{ keyId: 'release', publicKey: publicKeyBase64(), activeFrom: 'not-a-time' }] },
    ]

    for (const value of invalid) {
      const resourcesPath = await packagedFixture(value)
      expect(await loadOpenDesignOfficialChannel({
        isPackaged: true,
        resourcesPath,
        platform: 'darwin-arm64',
      })).toMatchObject({ status: 'not-ready', errorCode: 'OFFICIAL_CHANNEL_CONFIG_INVALID' })
    }
  })
})

describe('OpenDesign Host channel selection', () => {
  it('keeps explicit development input isolated and otherwise chooses the official channel', async () => {
    const resourcesPath = await packagedFixture()
    const official = await loadOpenDesignOfficialChannel({ isPackaged: true, resourcesPath, platform: 'darwin-arm64' })
    if (official.status !== 'ready') throw new Error('Expected official channel fixture')
    const developmentBundle = { installRequest: { catalogUrl: 'https://development.invalid/catalog.json' } } as LoadedDevelopmentModuleBundle

    expect(selectOpenDesignHostChannel({ status: 'ready', bundle: developmentBundle }, official)).toMatchObject({
      status: 'ready',
      source: 'development',
    })
    expect(selectOpenDesignHostChannel({
      status: 'not-ready',
      errorCode: 'DEVELOPMENT_BUNDLE_INVALID',
      errorMessage: 'Development bundle failed.',
    }, official)).toEqual({
      status: 'not-ready',
      errorCode: 'DEVELOPMENT_BUNDLE_INVALID',
      errorMessage: 'Development bundle failed.',
    })
    expect(selectOpenDesignHostChannel({ status: 'disabled' }, official)).toMatchObject({
      status: 'ready',
      source: 'official',
    })
  })

  it('resolves official installs through the coordinator and leaves development requests local', async () => {
    const resourcesPath = await packagedFixture()
    const official = await loadOpenDesignOfficialChannel({ isPackaged: true, resourcesPath, platform: 'darwin-arm64' })
    if (official.status !== 'ready') throw new Error('Expected official channel fixture')
    const officialHost = selectOpenDesignHostChannel({ status: 'disabled' }, official)
    const resolved = { catalogUrl: CATALOG_URL } as ModuleCoordinatorInstallRequest
    const coordinator = { resolveInstallRequest: mock(async () => resolved) }

    expect(await resolveOpenDesignHostInstallRequest(officialHost, coordinator)).toBe(resolved)
    expect(coordinator.resolveInstallRequest).toHaveBeenCalledWith(official.channel.releaseRequest)

    const developmentRequest = { catalogUrl: 'https://development.invalid/catalog.json' } as ModuleCoordinatorInstallRequest
    const developmentHost = selectOpenDesignHostChannel({
      status: 'ready',
      bundle: { installRequest: developmentRequest } as LoadedDevelopmentModuleBundle,
    }, official)
    expect(await resolveOpenDesignHostInstallRequest(developmentHost, coordinator)).toBe(developmentRequest)
    expect(coordinator.resolveInstallRequest).toHaveBeenCalledTimes(1)
  })
})
