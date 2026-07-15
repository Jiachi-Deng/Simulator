import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModuleId, ModulePlatform, ModuleVersion } from '@simulator/module-contract'
import type {
  ModuleCoordinator,
  ModuleCoordinatorInstallRequest,
  ModuleCoordinatorReleaseRequest,
} from '@simulator/module-coordinator'
import type {
  GitHubReleaseRedirectPolicy,
  ModuleDownloaderOptions,
} from '@simulator/module-downloader'
import type { LoadedDevelopmentModuleBundle } from './development-module-bundle'
import type { OpenDesignDevelopmentBootstrap } from './open-design-development-bootstrap'
import { OPEN_DESIGN_MODULE_ID } from '../shared/open-design-module-ipc'

// `copy-assets.ts` copies `apps/electron/resources` into `dist/resources`, and
// electron-builder installs the Electron app payload below `resources/app`.
// Keep the production channel inside that code-signed, build-owned tree.
export const OPEN_DESIGN_OFFICIAL_CHANNEL_CONFIG_RELATIVE_PATH = join(
  'app',
  'dist',
  'resources',
  'open-design-official-channel.json',
)

const MAX_CONFIG_BYTES = 64 * 1024
const MAX_TRUSTED_KEYS = 8
const ROOT_FIELDS = ['schemaVersion', 'moduleId', 'version', 'platform', 'catalogUrl', 'githubRelease', 'trustedKeys'] as const
const GITHUB_FIELDS = ['owner', 'repository', 'tag'] as const
const KEY_FIELDS = ['keyId', 'publicKey', 'activeFrom', 'activeUntil', 'revokedAt'] as const
const KEY_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/
const RELEASE_SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,254})$/
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

type DataRecord = Record<string, unknown>
type TrustedKeys = ModuleDownloaderOptions['trustedKeys']

export interface OpenDesignOfficialChannel {
  readonly trustedKeys: TrustedKeys
  readonly githubReleaseRedirectPolicy: GitHubReleaseRedirectPolicy
  readonly releaseRequest: ModuleCoordinatorReleaseRequest
}

export type OpenDesignOfficialChannelBootstrap =
  | { readonly status: 'ready'; readonly channel: OpenDesignOfficialChannel }
  | { readonly status: 'not-ready'; readonly errorCode: string; readonly errorMessage: string }

export type OpenDesignHostChannelBootstrap =
  | { readonly status: 'ready'; readonly source: 'development'; readonly bundle: LoadedDevelopmentModuleBundle }
  | { readonly status: 'ready'; readonly source: 'official'; readonly channel: OpenDesignOfficialChannel }
  | { readonly status: 'not-ready'; readonly errorCode: string; readonly errorMessage: string }

export interface LoadOpenDesignOfficialChannelOptions {
  readonly isPackaged: boolean
  readonly resourcesPath: string
  readonly platform: string
  readonly readConfig?: (path: string) => Promise<Uint8Array>
}

function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value as Record<string, unknown>)) freeze(nested)
  }
  return value
}

function notReady(errorCode: string): OpenDesignOfficialChannelBootstrap {
  return freeze({
    status: 'not-ready' as const,
    errorCode,
    errorMessage: 'The OpenDesign official channel is not ready.',
  })
}

function record(value: unknown): DataRecord | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return undefined
  }
  return value as DataRecord
}

function exactFields(value: DataRecord, fields: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  return actual.length === expected.length && actual.every((field, index) => field === expected[index])
}

function onlyFields(value: DataRecord, allowed: readonly string[], required: readonly string[]): boolean {
  const fields = Object.keys(value)
  return required.every((field) => Object.hasOwn(value, field)) && fields.every((field) => allowed.includes(field))
}

function canonicalTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) return undefined
  return value
}

function exactReleaseSegment(value: unknown): value is string {
  return typeof value === 'string'
    && RELEASE_SEGMENT_PATTERN.test(value)
    && value !== '.'
    && value !== '..'
    && value !== 'latest'
}

function parseTrustedKeys(value: unknown): TrustedKeys | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length === 0 || value.length > MAX_TRUSTED_KEYS) return undefined
  const keys: TrustedKeys[number][] = []
  const seen = new Set<string>()
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return undefined
    const input = record(value[index])
    if (!input || !onlyFields(input, KEY_FIELDS, ['keyId', 'publicKey', 'activeFrom'])) return undefined
    if (typeof input.keyId !== 'string' || !KEY_ID_PATTERN.test(input.keyId) || seen.has(input.keyId)) return undefined
    if (typeof input.publicKey !== 'string' || input.publicKey.length !== 44) return undefined
    const publicKey = Buffer.from(input.publicKey, 'base64')
    if (publicKey.byteLength !== 32 || publicKey.toString('base64') !== input.publicKey) return undefined
    const activeFrom = canonicalTimestamp(input.activeFrom)
    const activeUntil = input.activeUntil === undefined ? undefined : canonicalTimestamp(input.activeUntil)
    const revokedAt = input.revokedAt === undefined ? undefined : canonicalTimestamp(input.revokedAt)
    if (!activeFrom
      || (input.activeUntil !== undefined && !activeUntil)
      || (input.revokedAt !== undefined && !revokedAt)
      || (activeUntil !== undefined && activeFrom >= activeUntil)
      || (revokedAt !== undefined && activeFrom >= revokedAt)) return undefined
    seen.add(input.keyId)
    keys.push(freeze({
      keyId: input.keyId,
      publicKey: Uint8Array.from(publicKey),
      activeFrom,
      ...(activeUntil === undefined ? {} : { activeUntil }),
      ...(revokedAt === undefined ? {} : { revokedAt }),
    }))
  }
  return freeze(keys)
}

function parseOfficialChannel(value: unknown, platform: string): OpenDesignOfficialChannel | undefined {
  const input = record(value)
  if (!input || !exactFields(input, ROOT_FIELDS)
    || input.schemaVersion !== 1
    || input.moduleId !== OPEN_DESIGN_MODULE_ID
    || typeof input.version !== 'string' || !VERSION_PATTERN.test(input.version)
    || input.platform !== platform || platform !== 'darwin-arm64') return undefined

  const github = record(input.githubRelease)
  if (!github || !exactFields(github, GITHUB_FIELDS)
    || typeof github.owner !== 'string' || !OWNER_PATTERN.test(github.owner)
    || typeof github.repository !== 'string' || !REPOSITORY_PATTERN.test(github.repository)
    || !exactReleaseSegment(github.tag)) return undefined

  if (typeof input.catalogUrl !== 'string') return undefined
  let catalogUrl: URL
  try {
    catalogUrl = new URL(input.catalogUrl)
  } catch {
    return undefined
  }
  const segments = catalogUrl.pathname.split('/')
  if (catalogUrl.href !== input.catalogUrl
    || catalogUrl.origin !== 'https://github.com'
    || catalogUrl.username !== '' || catalogUrl.password !== ''
    || catalogUrl.search !== '' || catalogUrl.hash !== ''
    || segments.length !== 7
    || segments[0] !== ''
    || segments[1] !== github.owner
    || segments[2] !== github.repository
    || segments[3] !== 'releases'
    || segments[4] !== 'download'
    || segments[5] !== github.tag
    || !exactReleaseSegment(segments[6])) return undefined

  const trustedKeys = parseTrustedKeys(input.trustedKeys)
  if (!trustedKeys) return undefined
  return freeze({
    trustedKeys,
    githubReleaseRedirectPolicy: freeze({ owner: github.owner, repository: github.repository }),
    releaseRequest: freeze({
      catalogUrl: input.catalogUrl,
      moduleId: OPEN_DESIGN_MODULE_ID as ModuleId,
      version: input.version as ModuleVersion,
    }),
  })
}

/** Loads only the fixed, code-signed packaged resource. No CLI, env, or user-data override is accepted. */
export async function loadOpenDesignOfficialChannel(
  options: LoadOpenDesignOfficialChannelOptions,
): Promise<OpenDesignOfficialChannelBootstrap> {
  if (!options.isPackaged) return notReady('OFFICIAL_CHANNEL_PACKAGED_CONFIG_UNAVAILABLE')
  const path = join(options.resourcesPath, OPEN_DESIGN_OFFICIAL_CHANNEL_CONFIG_RELATIVE_PATH)
  let bytes: Uint8Array
  try {
    bytes = await (options.readConfig ?? (async (input) => readFile(input)))(path)
  } catch (error) {
    return notReady((error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'OFFICIAL_CHANNEL_CONFIG_MISSING'
      : 'OFFICIAL_CHANNEL_CONFIG_UNREADABLE')
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_CONFIG_BYTES) {
    return notReady('OFFICIAL_CHANNEL_CONFIG_INVALID')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return notReady('OFFICIAL_CHANNEL_CONFIG_INVALID')
  }
  const channel = parseOfficialChannel(parsed, options.platform)
  return channel ? freeze({ status: 'ready' as const, channel }) : notReady('OFFICIAL_CHANNEL_CONFIG_INVALID')
}

/** Explicit development input is authoritative; it can never silently fall through to production trust. */
export function selectOpenDesignHostChannel(
  development: OpenDesignDevelopmentBootstrap,
  official: OpenDesignOfficialChannelBootstrap,
): OpenDesignHostChannelBootstrap {
  if (development.status === 'ready') return freeze({ status: 'ready', source: 'development', bundle: development.bundle })
  if (development.status === 'not-ready') return freeze({
    status: 'not-ready',
    errorCode: development.errorCode,
    errorMessage: development.errorMessage,
  })
  if (official.status === 'ready') return freeze({ status: 'ready', source: 'official', channel: official.channel })
  return official
}

export async function resolveOpenDesignHostInstallRequest(
  bootstrap: OpenDesignHostChannelBootstrap,
  coordinator: Pick<ModuleCoordinator, 'resolveInstallRequest'> | undefined,
): Promise<ModuleCoordinatorInstallRequest | undefined> {
  if (bootstrap.status !== 'ready') return undefined
  if (bootstrap.source === 'development') return bootstrap.bundle.installRequest
  if (!coordinator) return undefined
  return coordinator.resolveInstallRequest(bootstrap.channel.releaseRequest)
}
