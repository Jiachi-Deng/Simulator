import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseModuleManifest, type ModuleManifest } from '@simulator/module-contract'
import type { ModuleRegistryCompatibilityException } from '@simulator/module-registry'
import {
  OPEN_DESIGN_0145_COMPATIBILITY_AUTHORITY_ID,
  OPEN_DESIGN_0145_COMPATIBILITY_AUTHORITY_RESOURCE_NAME,
  OPEN_DESIGN_0145_COMPATIBILITY_AUTHORITY_RESOURCE_SHA256,
  OPEN_DESIGN_0145_COMPATIBILITY_HOST,
  OPEN_DESIGN_0145_COMPATIBILITY_PROTOCOL,
  OPEN_DESIGN_0145_COMPATIBILITY_RATIONALE,
  OPEN_DESIGN_0145_INITIAL_PUBLISHED_CATALOG_SHA256,
  OPEN_DESIGN_0145_INITIAL_PUBLISHED_ENVELOPE_SHA256,
  OPEN_DESIGN_0145_ORIGINAL_HOST_VERSION_RANGE,
  OPEN_DESIGN_0145_PUBLIC_KEY_RAW_SHA256,
} from '../shared/open-design-compatibility-authority-contract'

// `copy-assets.ts` stages the authority below dist/resources, and electron-builder
// installs that build-owned tree below resources/app. No environment, CLI, or
// user-data path can replace this authority.
export const OPEN_DESIGN_0145_COMPATIBILITY_AUTHORITY_RELATIVE_PATH = join(
  'app',
  'dist',
  'resources',
  OPEN_DESIGN_0145_COMPATIBILITY_AUTHORITY_RESOURCE_NAME,
)

const MAX_AUTHORITY_BYTES = 64 * 1024
const ROOT_FIELDS = [
  'schemaVersion',
  'authorityId',
  'host',
  'originalHostVersionRange',
  'manifest',
  'releaseEvidence',
  'protocol',
  'rationale',
] as const
const HOST_FIELDS = ['version', 'platform'] as const
const MANIFEST_FIELDS = ['schemaVersion', 'id', 'version', 'artifacts', 'capabilities'] as const
const ARTIFACT_FIELDS = ['platform', 'url', 'sha256', 'entrypoint', 'auxiliaryExecutables'] as const
const RELEASE_EVIDENCE_FIELDS = [
  'githubRelease',
  'catalogUrl',
  'initialPublishedCatalogSha256',
  'initialPublishedEnvelopeSha256',
  'archiveSize',
  'extractedManifestSha256',
  'trustedKey',
] as const
const GITHUB_RELEASE_FIELDS = ['owner', 'repository', 'tag'] as const
const TRUSTED_KEY_FIELDS = ['keyId', 'publicKey', 'publicKeyRawSha256'] as const

const EXPECTED_ARTIFACT = Object.freeze({
  platform: 'darwin-arm64',
  url: 'https://github.com/Jiachi-Deng/Simulator/releases/download/open-design-v0.14.5/org.simulator.open-design-0.14.5-darwin-arm64.tar.gz',
  sha256: 'f883aaedd588c62d8a7ba6a4f94b6e2c8e448f9a8816758d6dbeb468a68d3e09',
  entrypoint: 'runtime/open-design-launcher',
  auxiliaryExecutables: Object.freeze([
    'runtime/node/bin/node',
    'runtime/daemon/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  ]),
})
const EXPECTED_CAPABILITIES = Object.freeze([
  'host-agent.use',
  'workspace.read',
  'workspace.write',
])
const EXPECTED_CATALOG_URL =
  'https://github.com/Jiachi-Deng/Simulator/releases/download/open-design-v0.14.5/org.simulator.open-design-0.14.5-catalog-v2-envelope.json'
const EXPECTED_EXTRACTED_MANIFEST_SHA256 =
  '9897521de3493eb2d35c76ff25cd9b714575024c42efd88ccd614331d5445414'
const EXPECTED_PUBLIC_KEY = 'KvpR89GuQd670SZMZuuR+aK4FUIprxRlqE58K3twQZk='

type DataRecord = Record<string, unknown>

export type OpenDesignCompatibilityAuthorityBootstrap =
  | {
      readonly status: 'ready'
      readonly compatibilityException: ModuleRegistryCompatibilityException
    }
  | {
      readonly status: 'not-ready'
      readonly errorCode: string
      readonly errorMessage: string
    }

export interface LoadOpenDesignCompatibilityAuthorityOptions {
  readonly isPackaged: boolean
  readonly resourcesPath: string
  readonly hostVersion: string
  readonly platform: string
  readonly readAuthority?: (path: string) => Promise<Uint8Array>
}

function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value as Record<string, unknown>)) freeze(nested)
  }
  return value
}

function notReady(errorCode: string): OpenDesignCompatibilityAuthorityBootstrap {
  return freeze({
    status: 'not-ready' as const,
    errorCode,
    errorMessage: 'The OpenDesign 0.14.5 compatibility authority is not ready.',
  })
}

function record(value: unknown): DataRecord | undefined {
  if (value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return undefined
  return value as DataRecord
}

function exactFields(value: DataRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((field, index) => field === sortedExpected[index])
}

function exactDenseStringArray(value: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length !== expected.length) return false
  for (let index = 0; index < expected.length; index += 1) {
    if (!Object.hasOwn(value, index) || value[index] !== expected[index]) return false
  }
  return true
}

function exactManifest(value: unknown): ModuleManifest | undefined {
  const manifest = record(value)
  if (!manifest
    || !exactFields(manifest, MANIFEST_FIELDS)
    || manifest.schemaVersion !== 1
    || manifest.id !== 'org.simulator.open-design'
    || manifest.version !== '0.14.5'
    || !exactDenseStringArray(manifest.capabilities, EXPECTED_CAPABILITIES)) return undefined

  if (!Array.isArray(manifest.artifacts)
    || Object.getPrototypeOf(manifest.artifacts) !== Array.prototype
    || manifest.artifacts.length !== 1
    || !Object.hasOwn(manifest.artifacts, 0)) return undefined
  const artifact = record(manifest.artifacts[0])
  if (!artifact
    || !exactFields(artifact, ARTIFACT_FIELDS)
    || artifact.platform !== EXPECTED_ARTIFACT.platform
    || artifact.url !== EXPECTED_ARTIFACT.url
    || artifact.sha256 !== EXPECTED_ARTIFACT.sha256
    || artifact.entrypoint !== EXPECTED_ARTIFACT.entrypoint
    || !exactDenseStringArray(artifact.auxiliaryExecutables, EXPECTED_ARTIFACT.auxiliaryExecutables)) {
    return undefined
  }

  const parsed = parseModuleManifest(manifest)
  return parsed.ok ? parsed.value : undefined
}

function exactReleaseEvidence(value: unknown): boolean {
  const evidence = record(value)
  if (!evidence || !exactFields(evidence, RELEASE_EVIDENCE_FIELDS)) return false
  const githubRelease = record(evidence.githubRelease)
  const trustedKey = record(evidence.trustedKey)
  // The two initial-publish digests below document the reviewed release
  // provenance. They are intentionally not returned in the Registry exception
  // and are never compared with a later, legitimately refreshed 12-hour
  // catalog. Runtime refresh trust remains the Downloader's signature check.
  if (!githubRelease
    || !exactFields(githubRelease, GITHUB_RELEASE_FIELDS)
    || githubRelease.owner !== 'Jiachi-Deng'
    || githubRelease.repository !== 'Simulator'
    || githubRelease.tag !== 'open-design-v0.14.5'
    || evidence.catalogUrl !== EXPECTED_CATALOG_URL
    || evidence.initialPublishedCatalogSha256 !== OPEN_DESIGN_0145_INITIAL_PUBLISHED_CATALOG_SHA256
    || evidence.initialPublishedEnvelopeSha256 !== OPEN_DESIGN_0145_INITIAL_PUBLISHED_ENVELOPE_SHA256
    || evidence.archiveSize !== 61_479_889
    || evidence.extractedManifestSha256 !== EXPECTED_EXTRACTED_MANIFEST_SHA256
    || !trustedKey
    || !exactFields(trustedKey, TRUSTED_KEY_FIELDS)
    || trustedKey.keyId !== 'open-design-release-2026-01'
    || trustedKey.publicKey !== EXPECTED_PUBLIC_KEY
    || trustedKey.publicKeyRawSha256 !== OPEN_DESIGN_0145_PUBLIC_KEY_RAW_SHA256) return false

  const decodedKey = Buffer.from(EXPECTED_PUBLIC_KEY, 'base64')
  return decodedKey.byteLength === 32
    && decodedKey.toString('base64') === EXPECTED_PUBLIC_KEY
    && createHash('sha256').update(decodedKey).digest('hex') === OPEN_DESIGN_0145_PUBLIC_KEY_RAW_SHA256
}

export function parseOpenDesignCompatibilityAuthority(
  value: unknown,
): ModuleRegistryCompatibilityException | undefined {
  const authority = record(value)
  if (!authority
    || !exactFields(authority, ROOT_FIELDS)
    || authority.schemaVersion !== 1
    || authority.authorityId !== OPEN_DESIGN_0145_COMPATIBILITY_AUTHORITY_ID
    || authority.originalHostVersionRange !== OPEN_DESIGN_0145_ORIGINAL_HOST_VERSION_RANGE
    || authority.protocol !== OPEN_DESIGN_0145_COMPATIBILITY_PROTOCOL
    || authority.rationale !== OPEN_DESIGN_0145_COMPATIBILITY_RATIONALE) return undefined

  const host = record(authority.host)
  if (!host
    || !exactFields(host, HOST_FIELDS)
    || host.version !== OPEN_DESIGN_0145_COMPATIBILITY_HOST.version
    || host.platform !== OPEN_DESIGN_0145_COMPATIBILITY_HOST.platform) return undefined
  const manifest = exactManifest(authority.manifest)
  if (!manifest || !exactReleaseEvidence(authority.releaseEvidence)) return undefined

  return freeze({
    host: OPEN_DESIGN_0145_COMPATIBILITY_HOST,
    hostVersionRange: OPEN_DESIGN_0145_ORIGINAL_HOST_VERSION_RANGE,
    manifest,
  }) as ModuleRegistryCompatibilityException
}

/** Loads only the exact, hash-pinned authority from the code-signed packaged app. */
export async function loadOpenDesignCompatibilityAuthority(
  options: LoadOpenDesignCompatibilityAuthorityOptions,
): Promise<OpenDesignCompatibilityAuthorityBootstrap> {
  if (!options.isPackaged) {
    return notReady('COMPATIBILITY_AUTHORITY_PACKAGED_RESOURCE_UNAVAILABLE')
  }
  if (options.hostVersion !== OPEN_DESIGN_0145_COMPATIBILITY_HOST.version
    || options.platform !== OPEN_DESIGN_0145_COMPATIBILITY_HOST.platform) {
    return notReady('COMPATIBILITY_AUTHORITY_HOST_MISMATCH')
  }

  const path = join(options.resourcesPath, OPEN_DESIGN_0145_COMPATIBILITY_AUTHORITY_RELATIVE_PATH)
  let bytes: Uint8Array
  try {
    bytes = await (options.readAuthority ?? (async (input) => readFile(input)))(path)
  } catch (error) {
    return notReady((error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'COMPATIBILITY_AUTHORITY_RESOURCE_MISSING'
      : 'COMPATIBILITY_AUTHORITY_RESOURCE_UNREADABLE')
  }
  if (!(bytes instanceof Uint8Array)
    || bytes.byteLength === 0
    || bytes.byteLength > MAX_AUTHORITY_BYTES
    || createHash('sha256').update(bytes).digest('hex')
      !== OPEN_DESIGN_0145_COMPATIBILITY_AUTHORITY_RESOURCE_SHA256) {
    return notReady('COMPATIBILITY_AUTHORITY_RESOURCE_INVALID')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return notReady('COMPATIBILITY_AUTHORITY_RESOURCE_INVALID')
  }
  const compatibilityException = parseOpenDesignCompatibilityAuthority(parsed)
  return compatibilityException
    ? freeze({ status: 'ready' as const, compatibilityException })
    : notReady('COMPATIBILITY_AUTHORITY_RESOURCE_INVALID')
}
