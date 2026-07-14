import { describe, expect, it, mock } from 'bun:test'
import { parseModuleManifest } from '@simulator/module-contract'
import type { LoadedDevelopmentModuleBundle } from '../development-module-bundle'
import {
  loadOpenDesignDevelopmentBootstrap,
  OPEN_DESIGN_DEVELOPMENT_BUNDLE_ARGUMENT,
} from '../open-design-development-bootstrap'
import { OPEN_DESIGN_MODULE_ID } from '../../shared/open-design-module-ipc'

const DESCRIPTOR_PATH = '/private/tmp/open-design-development/bundle-descriptor.json'
const ARCHIVE_URL = 'https://m1-development.invalid/open-design/module.tar.gz'
const ARCHIVE_SHA256 = 'a'.repeat(64)
const parsedManifest = parseModuleManifest({
  schemaVersion: 1,
  id: OPEN_DESIGN_MODULE_ID,
  version: '0.14.1-development.1',
  artifacts: [{
    platform: 'darwin-arm64',
    entrypoint: 'runtime/open-design-launcher',
    url: ARCHIVE_URL,
    sha256: ARCHIVE_SHA256,
  }],
  capabilities: [],
})
if (!parsedManifest.ok) throw new Error('Test OpenDesign manifest must be valid')
const TEST_MANIFEST = parsedManifest.value

function loadedBundle(overrides: Partial<LoadedDevelopmentModuleBundle['release']> = {}): LoadedDevelopmentModuleBundle {
  return {
    catalogUrl: 'https://m1-development.invalid/open-design/catalog-envelope.json',
    trustedKeys: [],
    fetchAdapter: { fetch: mock(async () => { throw new Error('not used') }) },
    installRequest: {
      catalogUrl: 'https://m1-development.invalid/open-design/catalog-envelope.json',
      descriptor: {
        verified: true,
        manifest: TEST_MANIFEST,
        artifact: TEST_MANIFEST.artifacts[0]!,
        extractedManifestSha256: TEST_MANIFEST.artifacts[0]!.sha256,
        format: 'tar.gz',
      },
      hostVersionRange: '*',
    },
    release: {
      developmentOnly: true,
      nonPromotable: true,
      moduleId: OPEN_DESIGN_MODULE_ID,
      version: '0.14.1-development.1',
      platform: 'darwin-arm64',
      archiveUrl: ARCHIVE_URL,
      archiveSha256: ARCHIVE_SHA256,
      archiveSize: 1024,
      ...overrides,
    },
  }
}

describe('loadOpenDesignDevelopmentBootstrap', () => {
  it('stays disabled unless both explicit flags are present', async () => {
    const loadBundle = mock(async () => loadedBundle())
    expect(await loadOpenDesignDevelopmentBootstrap({ argv: [], platform: 'darwin-arm64', loadBundle })).toEqual({ status: 'disabled' })
    expect(await loadOpenDesignDevelopmentBootstrap({
      argv: [`${OPEN_DESIGN_DEVELOPMENT_BUNDLE_ARGUMENT}${DESCRIPTOR_PATH}`],
      platform: 'darwin-arm64',
      loadBundle,
    })).toEqual({ status: 'disabled' })
    expect(await loadOpenDesignDevelopmentBootstrap({ argv: ['--debug'], platform: 'darwin-arm64', loadBundle })).toEqual({ status: 'disabled' })
    expect(loadBundle).not.toHaveBeenCalled()
  })

  it('loads one fixed OpenDesign descriptor only on darwin-arm64', async () => {
    const bundle = loadedBundle()
    const loadBundle = mock(async () => bundle)
    const result = await loadOpenDesignDevelopmentBootstrap({
      argv: ['--debug', `${OPEN_DESIGN_DEVELOPMENT_BUNDLE_ARGUMENT}${DESCRIPTOR_PATH}`],
      platform: 'darwin-arm64',
      loadBundle,
    })
    expect(result).toEqual({ status: 'ready', bundle })
    expect(loadBundle).toHaveBeenCalledWith({ descriptorPath: DESCRIPTOR_PATH, expectedModuleId: OPEN_DESIGN_MODULE_ID })
  })

  it('rejects duplicate, empty, unsupported, and mismatched development inputs', async () => {
    const loadBundle = mock(async () => loadedBundle())
    const duplicate = ['--debug', `${OPEN_DESIGN_DEVELOPMENT_BUNDLE_ARGUMENT}${DESCRIPTOR_PATH}`, `${OPEN_DESIGN_DEVELOPMENT_BUNDLE_ARGUMENT}/other`]
    expect((await loadOpenDesignDevelopmentBootstrap({ argv: duplicate, platform: 'darwin-arm64', loadBundle })).status).toBe('not-ready')
    expect((await loadOpenDesignDevelopmentBootstrap({ argv: ['--debug', OPEN_DESIGN_DEVELOPMENT_BUNDLE_ARGUMENT], platform: 'darwin-arm64', loadBundle })).status).toBe('not-ready')
    expect((await loadOpenDesignDevelopmentBootstrap({ argv: ['--debug', `${OPEN_DESIGN_DEVELOPMENT_BUNDLE_ARGUMENT}${DESCRIPTOR_PATH}`], platform: 'linux-x64', loadBundle })).status).toBe('not-ready')
    expect(loadBundle).not.toHaveBeenCalled()

    const wrongTarget = mock(async () => loadedBundle({ moduleId: 'org.simulator.other' }))
    expect((await loadOpenDesignDevelopmentBootstrap({
      argv: ['--debug', `${OPEN_DESIGN_DEVELOPMENT_BUNDLE_ARGUMENT}${DESCRIPTOR_PATH}`],
      platform: 'darwin-arm64',
      loadBundle: wrongTarget,
    }))).toMatchObject({ status: 'not-ready', errorCode: 'DEVELOPMENT_BUNDLE_TARGET_MISMATCH' })
  })

  it('contains loader failures without exposing the descriptor path', async () => {
    const loadBundle = mock(async () => { throw new Error(`failed at ${DESCRIPTOR_PATH}`) })
    const result = await loadOpenDesignDevelopmentBootstrap({
      argv: ['--debug', `${OPEN_DESIGN_DEVELOPMENT_BUNDLE_ARGUMENT}${DESCRIPTOR_PATH}`],
      platform: 'darwin-arm64',
      loadBundle,
    })
    expect(result).toMatchObject({ status: 'not-ready', errorCode: 'DEVELOPMENT_BUNDLE_VERIFICATION_FAILED' })
    expect(JSON.stringify(result)).not.toContain(DESCRIPTOR_PATH)
  })
})
