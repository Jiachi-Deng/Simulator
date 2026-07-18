import { createHmac, timingSafeEqual } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { ISessionManager } from '@craft-agent/server-core/handlers'
import type { ModuleAgentConnectionAdmission } from '@craft-agent/server-core/sessions'
import {
  getDefaultLlmConnection,
  getLlmConnection,
  getMiniModel,
  type LlmAuthType,
  type LlmConnection,
  type LlmProviderType,
} from '@craft-agent/shared/config'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import {
  connectionAuthTypeToBackendAuthType,
  providerTypeToAgentProvider,
  resolveModelForProvider,
} from '@craft-agent/shared/agent/backend'
import { loadWorkspaceConfig, type WorkspaceConfig } from '@craft-agent/shared/workspaces'
import type {
  OpenDesignAcceptanceConnectionArmRequest,
  OpenDesignAcceptanceConnectionArmResult,
  OpenDesignAcceptanceConnectionAuthorityRequest,
  OpenDesignAcceptanceConnectionAuthorityResult,
} from '../shared/open-design-acceptance-ipc'

const SHA256 = /^[0-9a-f]{64}$/

interface CredentialReader {
  hasLlmCredentials(slug: string, authType: LlmAuthType, providerType?: LlmProviderType): Promise<boolean>
  getLlmApiKey(slug: string): Promise<string | null>
  getLlmOAuth(slug: string): Promise<{
    accessToken: string
    refreshToken?: string
    expiresAt?: number
    idToken?: string
  } | null>
  getLlmIamCredentials(slug: string): Promise<{
    accessKeyId: string
    secretAccessKey: string
    region?: string
    sessionToken?: string
  } | null>
  getLlmServiceAccount(slug: string): Promise<{
    serviceAccountJson: string
    projectId?: string
    region?: string
    email?: string
  } | null>
}

interface ConnectionAuthoritySource {
  getGlobalDefaultConnection(): string | null
  getConnection(slug: string): LlmConnection | null
  loadWorkspaceConfig(root: string): WorkspaceConfig | null
  resolveRuntime(connection: LlmConnection, workspaceModel?: string): Readonly<{
    provider: string
    authType: string | null
    resolvedModel: string | null
  }>
}

export interface OpenDesignAcceptanceConnectionAdmissionOptions {
  readonly sessions: Pick<ISessionManager, 'getWorkspaces'>
  readonly resolveWorkspaceId: () => string | undefined
  readonly configRoot: string
  readonly userDataRoot: string
  readonly homeRoot?: string
  /** Deterministic seams used only by the admission unit tests. */
  readonly source?: ConnectionAuthoritySource
  readonly credentials?: CredentialReader
}

interface AuthoritySnapshot {
  readonly workspaceId: string
  readonly workspaceRoot: string
  readonly llmConnection: string
  readonly material: Readonly<Record<string, unknown>>
}

interface StableAuthority extends AuthoritySnapshot {
  readonly authorityHmacSha256: string
}

interface ArmedAuthority {
  readonly key: Buffer
  readonly workspaceId: string
  readonly workspaceRoot: string
  readonly llmConnection: string
  readonly authorityHmacSha256: string
}

function defaultSource(): ConnectionAuthoritySource {
  return Object.freeze({
    getGlobalDefaultConnection: getDefaultLlmConnection,
    getConnection: getLlmConnection,
    loadWorkspaceConfig,
    resolveRuntime(connection: LlmConnection, workspaceModel?: string) {
      const provider = providerTypeToAgentProvider(connection.providerType)
      let model = workspaceModel
      if (workspaceModel === 'fast') model = getMiniModel(connection) ?? connection.defaultModel
      if (workspaceModel === 'default') model = connection.defaultModel
      return Object.freeze({
        provider,
        authType: connectionAuthTypeToBackendAuthType(connection.authType) ?? null,
        resolvedModel: resolveModelForProvider(provider, model, connection) ?? null,
      })
    },
  })
}

function canonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize)
    if (candidate && typeof candidate === 'object') {
      const record = candidate as Record<string, unknown>
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, normalize(record[key])]))
    }
    if (candidate === undefined) return null
    return candidate
  }
  return JSON.stringify(normalize(value))
}

function parseAuthorityKey(keyBase64: string): Buffer {
  if (typeof keyBase64 !== 'string' || keyBase64.length !== 44) {
    throw new Error('Acceptance Connection authority key is invalid')
  }
  const key = Buffer.from(keyBase64, 'base64')
  if (key.byteLength !== 32 || key.toString('base64') !== keyBase64) {
    key.fill(0)
    throw new Error('Acceptance Connection authority key is invalid')
  }
  return key
}

function hmacAuthority(key: Buffer, material: Readonly<Record<string, unknown>>): string {
  return createHmac('sha256', key)
    .update('simulator-open-design-acceptance-connection-authority-v1\0', 'utf8')
    .update(canonicalJson(material), 'utf8')
    .digest('hex')
}

function equalSha256(left: string, right: string): boolean {
  if (!SHA256.test(left) || !SHA256.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

function jwtSubject(token: string | undefined): Readonly<{ issuer: string; subject: string }> | undefined {
  if (!token) return undefined
  try {
    const parts = token.split('.')
    if (parts.length !== 3 || !parts[1]) return undefined
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
    const { iss, sub } = payload as Record<string, unknown>
    if (typeof iss !== 'string' || iss.length < 1 || iss.length > 2048
      || typeof sub !== 'string' || sub.length < 1 || sub.length > 2048) return undefined
    return Object.freeze({ issuer: iss, subject: sub })
  } catch {
    return undefined
  }
}

async function credentialIdentity(
  credentials: CredentialReader,
  connection: LlmConnection,
): Promise<Readonly<Record<string, unknown>>> {
  if (!await credentials.hasLlmCredentials(connection.slug, connection.authType, connection.providerType)) {
    throw new Error('Acceptance Connection is not authenticated')
  }
  switch (connection.authType) {
    case 'none':
      return Object.freeze({ kind: 'none' })
    case 'environment':
      // Craft can resolve several provider-specific environment chains, some of
      // which include mutable external files. Acceptance cannot bind those
      // completely without leaking or duplicating provider logic, so it refuses
      // to authorize paid evidence through this ambiguous identity path.
      throw new Error('Acceptance Connection environment identity is unavailable')
    case 'api_key':
    case 'api_key_with_endpoint':
    case 'bearer_token': {
      const value = await credentials.getLlmApiKey(connection.slug)
      if (!value) throw new Error('Acceptance Connection credential is unavailable')
      return Object.freeze({ kind: 'api-key', value })
    }
    case 'oauth': {
      const oauth = await credentials.getLlmOAuth(connection.slug)
      if (!oauth) throw new Error('Acceptance Connection credential is unavailable')
      const subject = jwtSubject(oauth.idToken) ?? jwtSubject(oauth.accessToken)
      if (subject) return Object.freeze({ kind: 'oauth-subject', ...subject })
      if (oauth.refreshToken) return Object.freeze({ kind: 'oauth-refresh', value: oauth.refreshToken })
      return Object.freeze({ kind: 'oauth-access', value: oauth.accessToken })
    }
    case 'iam_credentials': {
      const iam = await credentials.getLlmIamCredentials(connection.slug)
      if (!iam) throw new Error('Acceptance Connection credential is unavailable')
      return Object.freeze({ kind: 'iam', ...iam })
    }
    case 'service_account_file': {
      const serviceAccount = await credentials.getLlmServiceAccount(connection.slug)
      if (!serviceAccount) throw new Error('Acceptance Connection credential is unavailable')
      return Object.freeze({ kind: 'service-account', ...serviceAccount })
    }
  }
}

/**
 * H1/A1 Connection authority. Raw Connection and credential identity never
 * leave this object; the renderer sees only an authenticated boolean and HMAC.
 */
export class OpenDesignAcceptanceConnectionAdmission implements ModuleAgentConnectionAdmission {
  readonly #options: OpenDesignAcceptanceConnectionAdmissionOptions
  readonly #source: ConnectionAuthoritySource
  readonly #credentials: CredentialReader
  readonly #homePath: string
  readonly #configPath: string
  readonly #userDataPath: string
  #armed?: ArmedAuthority

  constructor(options: OpenDesignAcceptanceConnectionAdmissionOptions) {
    this.#options = options
    this.#source = options.source ?? defaultSource()
    this.#credentials = options.credentials ?? getCredentialManager()
    this.#homePath = resolve(options.homeRoot ?? homedir())
    this.#configPath = resolve(options.configRoot)
    this.#userDataPath = resolve(options.userDataRoot)
  }

  async getConnectionAuthority(
    request: OpenDesignAcceptanceConnectionAuthorityRequest,
  ): Promise<OpenDesignAcceptanceConnectionAuthorityResult> {
    const key = parseAuthorityKey(request.keyBase64)
    try {
      const authority = await this.#readStableAuthority(key)
      return Object.freeze({
        schemaVersion: 1 as const,
        authenticated: true as const,
        authorityHmacSha256: authority.authorityHmacSha256,
      })
    } finally {
      key.fill(0)
    }
  }

  async armConnectionAdmission(
    request: OpenDesignAcceptanceConnectionArmRequest,
  ): Promise<OpenDesignAcceptanceConnectionArmResult> {
    const key = parseAuthorityKey(request.keyBase64)
    try {
      const existing = this.#armed
      if (existing && !timingSafeEqual(existing.key, key)) {
        throw new Error('Acceptance Connection admission is already armed')
      }
      if (existing && !equalSha256(existing.authorityHmacSha256, request.expectedHmacSha256)) {
        throw new Error('Acceptance Connection authority mismatch')
      }
      const authority = await this.#readStableAuthority(key)
      if (!equalSha256(authority.authorityHmacSha256, request.expectedHmacSha256)) {
        throw new Error('Acceptance Connection authority mismatch')
      }
      if (!existing) {
        this.#armed = Object.freeze({
          key: Buffer.from(key),
          workspaceId: authority.workspaceId,
          workspaceRoot: authority.workspaceRoot,
          llmConnection: authority.llmConnection,
          authorityHmacSha256: authority.authorityHmacSha256,
        })
      }
      return Object.freeze({
        schemaVersion: 1 as const,
        armed: true as const,
        authorityHmacSha256: authority.authorityHmacSha256,
      })
    } finally {
      key.fill(0)
    }
  }

  async admit(workspaceId: string): Promise<Readonly<{ llmConnection: string }>> {
    const armed = this.#armed
    if (!armed) throw new Error('Acceptance Connection admission is not armed')
    if (workspaceId !== armed.workspaceId) throw new Error('Acceptance Connection workspace mismatch')
    const authority = await this.#readStableAuthority(armed.key, workspaceId)
    if (!equalSha256(authority.authorityHmacSha256, armed.authorityHmacSha256)
      || authority.workspaceRoot !== armed.workspaceRoot
      || authority.llmConnection !== armed.llmConnection) {
      throw new Error('Acceptance Connection authority drifted')
    }
    return Object.freeze({ llmConnection: armed.llmConnection })
  }

  async assertConnection(input: Readonly<{ workspaceId: string; llmConnection: string }>): Promise<void> {
    const armed = this.#armed
    if (!armed || input.workspaceId !== armed.workspaceId || input.llmConnection !== armed.llmConnection) {
      throw new Error('Acceptance Connection admission mismatch')
    }
    await this.admit(input.workspaceId)
  }

  dispose(): void {
    this.#armed?.key.fill(0)
    this.#armed = undefined
  }

  async #readStableAuthority(key: Buffer, expectedWorkspaceId?: string): Promise<StableAuthority> {
    const first = await this.#readAuthoritySnapshot(expectedWorkspaceId)
    const firstHmac = hmacAuthority(key, first.material)
    const second = await this.#readAuthoritySnapshot(expectedWorkspaceId)
    const secondHmac = hmacAuthority(key, second.material)
    if (!equalSha256(firstHmac, secondHmac)
      || first.workspaceId !== second.workspaceId
      || first.workspaceRoot !== second.workspaceRoot
      || first.llmConnection !== second.llmConnection) {
      throw new Error('Acceptance Connection authority changed while reading')
    }
    return Object.freeze({ ...second, authorityHmacSha256: secondHmac })
  }

  async #readAuthoritySnapshot(expectedWorkspaceId?: string): Promise<AuthoritySnapshot> {
    const workspaceId = this.#options.resolveWorkspaceId()
    if (!workspaceId || (expectedWorkspaceId !== undefined && workspaceId !== expectedWorkspaceId)) {
      throw new Error('Acceptance Connection workspace is unavailable')
    }
    const workspace = this.#options.sessions.getWorkspaces().find((candidate) => candidate.id === workspaceId)
    if (!workspace) throw new Error('Acceptance Connection workspace is unavailable')
    const workspaceRoot = realpathSync(workspace.rootPath)
    const workspaceConfig = this.#source.loadWorkspaceConfig(workspaceRoot)
    if (!workspaceConfig || workspaceConfig.id !== workspace.id) {
      throw new Error('Acceptance Connection workspace config is unavailable')
    }
    const workspaceDefault = workspaceConfig.defaults?.defaultLlmConnection ?? null
    const globalDefault = this.#source.getGlobalDefaultConnection()
    const workspaceConnection = workspaceDefault ? this.#source.getConnection(workspaceDefault) : null
    const connection = workspaceConnection ?? (globalDefault ? this.#source.getConnection(globalDefault) : null)
    if (!connection) throw new Error('Acceptance Connection is unavailable')
    const resolution = workspaceConnection ? 'workspace' : 'global'
    const runtime = this.#source.resolveRuntime(connection, workspaceConfig.defaults?.model)
    const credential = await credentialIdentity(this.#credentials, connection)
    const material = Object.freeze({
      schemaVersion: 1,
      roots: Object.freeze({
        home: realpathSync(this.#homePath),
        config: realpathSync(this.#configPath),
        userData: realpathSync(this.#userDataPath),
      }),
      workspace: Object.freeze({
        id: workspace.id,
        root: workspaceRoot,
      }),
      defaults: Object.freeze({
        resolution,
        workspaceConnection: workspaceDefault,
        globalConnection: globalDefault,
        workspaceModel: workspaceConfig.defaults?.model ?? null,
      }),
      connection: Object.freeze({
        slug: connection.slug,
        providerType: connection.providerType,
        authType: connection.authType,
        baseUrl: connection.baseUrl ?? null,
        defaultModel: connection.defaultModel ?? null,
        models: connection.models ?? null,
        modelSelectionMode: connection.modelSelectionMode ?? null,
        piAuthProvider: connection.piAuthProvider ?? null,
        customEndpoint: connection.customEndpoint ?? null,
        midStreamBehavior: connection.midStreamBehavior ?? null,
      }),
      runtime,
      credential,
    })
    return Object.freeze({
      workspaceId: workspace.id,
      workspaceRoot,
      llmConnection: connection.slug,
      material,
    })
  }
}
