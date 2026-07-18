import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { ISessionManager } from '@craft-agent/server-core/handlers'
import type { ModuleAgentConnectionAdmission } from '@craft-agent/server-core/sessions'
import type {
  BackendCredentialAuthoritySnapshot,
  BackendRuntimeAuthoritySnapshot,
} from '@craft-agent/shared/agent/backend'
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

const ADMISSION_FAILURE_CODES = Object.freeze({
  'Acceptance Connection admission is disposed': 'DISPOSED',
  'Acceptance Connection workspace is unavailable': 'WORKSPACE_UNAVAILABLE',
  'Acceptance Connection workspace config is unavailable': 'WORKSPACE_CONFIG_UNAVAILABLE',
  'Acceptance Connection is unavailable': 'CONNECTION_UNAVAILABLE',
  'Acceptance Connection runtime is unavailable': 'RUNTIME_UNAVAILABLE',
  'Acceptance requires an authenticated Connection': 'UNAUTHENTICATED',
  'Acceptance Connection environment identity is unavailable': 'ENVIRONMENT_IDENTITY_UNAVAILABLE',
  'Acceptance Connection is not authenticated': 'CREDENTIAL_NOT_AUTHENTICATED',
  'Acceptance Connection credential is unavailable': 'CREDENTIAL_UNAVAILABLE',
  'Acceptance Connection credential type is unsupported': 'CREDENTIAL_TYPE_UNSUPPORTED',
  'Acceptance Connection authority changed while reading': 'AUTHORITY_CHANGED',
  'Acceptance Connection authority mismatch': 'AUTHORITY_MISMATCH',
  'Acceptance Connection admission is already armed': 'ALREADY_ARMED',
} as const)

/** Safe diagnostics only; it never returns a provider response or credential data. */
export function openDesignConnectionAdmissionFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  return ADMISSION_FAILURE_CODES[message as keyof typeof ADMISSION_FAILURE_CODES] ?? 'UNKNOWN'
}

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
  readonly provider: BackendRuntimeAuthoritySnapshot['provider']
  readonly authType: BackendRuntimeAuthoritySnapshot['authType']
  readonly resolvedModel: string
  readonly providerCredential: BackendCredentialAuthoritySnapshot
  readonly material: Readonly<Record<string, unknown>>
}

interface StableAuthority extends AuthoritySnapshot {
  readonly authorityHmacSha256: string
  readonly credentialHmacSha256: string
}

interface ArmedAuthority {
  readonly key: Buffer
  readonly workspaceId: string
  readonly workspaceRoot: string
  readonly llmConnection: string
  readonly provider: BackendRuntimeAuthoritySnapshot['provider']
  readonly authType: BackendRuntimeAuthoritySnapshot['authType']
  readonly resolvedModel: string
  readonly authorityHmacSha256: string
  readonly credentialHmacSha256: string
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

function hmacCredential(key: Buffer, credential: BackendCredentialAuthoritySnapshot): string {
  return createHmac('sha256', key)
    .update('simulator-open-design-acceptance-provider-credential-v1\0', 'utf8')
    .update(canonicalJson(credential), 'utf8')
    .digest('hex')
}

function equalSha256(left: string, right: string): boolean {
  if (!SHA256.test(left) || !SHA256.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

async function credentialAuthority(
  credentials: CredentialReader,
  connection: LlmConnection,
): Promise<Readonly<{
  generation: Readonly<Record<string, unknown>>
  providerCredential: BackendCredentialAuthoritySnapshot
}>> {
  if (connection.authType === 'none') {
    throw new Error('Acceptance requires an authenticated Connection')
  }
  if (connection.authType === 'environment') {
    throw new Error('Acceptance Connection environment identity is unavailable')
  }
  if (!await credentials.hasLlmCredentials(connection.slug, connection.authType, connection.providerType)) {
    throw new Error('Acceptance Connection is not authenticated')
  }
  switch (connection.authType) {
    case 'api_key':
    case 'api_key_with_endpoint':
    case 'bearer_token': {
      const value = await credentials.getLlmApiKey(connection.slug)
      if (!value) throw new Error('Acceptance Connection credential is unavailable')
      const providerCredential = Object.freeze({ kind: 'api-key' as const, value })
      return Object.freeze({
        generation: Object.freeze({ kind: 'api-key-generation', value }),
        providerCredential,
      })
    }
    case 'oauth': {
      const oauth = await credentials.getLlmOAuth(connection.slug)
      if (!oauth?.accessToken) throw new Error('Acceptance Connection credential is unavailable')
      const providerCredential: BackendCredentialAuthoritySnapshot = connection.piAuthProvider === 'github-copilot'
        && oauth.refreshToken
        ? Object.freeze({
          kind: 'oauth-access-refresh' as const,
          accessToken: oauth.accessToken,
          refreshToken: oauth.refreshToken,
          expiresAt: oauth.expiresAt ?? null,
        })
        : Object.freeze({ kind: 'oauth-access' as const, accessToken: oauth.accessToken })
      return Object.freeze({
        generation: Object.freeze({
          kind: 'oauth-generation',
          accessToken: oauth.accessToken,
          refreshToken: oauth.refreshToken ?? null,
          idToken: oauth.idToken ?? null,
          expiresAt: oauth.expiresAt ?? null,
        }),
        providerCredential,
      })
    }
    case 'iam_credentials': {
      const iam = await credentials.getLlmIamCredentials(connection.slug)
      if (!iam) throw new Error('Acceptance Connection credential is unavailable')
      const providerCredential = Object.freeze({
        kind: 'iam' as const,
        accessKeyId: iam.accessKeyId,
        secretAccessKey: iam.secretAccessKey,
        region: iam.region ?? null,
        sessionToken: iam.sessionToken ?? null,
      })
      return Object.freeze({
        generation: Object.freeze({ ...providerCredential, kind: 'iam-generation' }),
        providerCredential,
      })
    }
    case 'service_account_file':
      throw new Error('Acceptance Connection credential type is unsupported')
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
  #armTail: Promise<void> = Promise.resolve()
  #disposed = false

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
    if (this.#disposed) throw new Error('Acceptance Connection admission is disposed')
    const key = parseAuthorityKey(request.keyBase64)
    try {
      const authority = await this.#readStableAuthority(key)
      if (this.#disposed) throw new Error('Acceptance Connection admission is disposed')
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
    let release!: () => void
    const turn = new Promise<void>((resolve) => { release = resolve })
    const previous = this.#armTail
    this.#armTail = previous.then(() => turn)
    try {
      await previous
      if (this.#disposed) throw new Error('Acceptance Connection admission is disposed')
      const existing = this.#armed
      if (existing && !timingSafeEqual(existing.key, key)) {
        throw new Error('Acceptance Connection admission is already armed')
      }
      if (existing && !equalSha256(existing.authorityHmacSha256, request.expectedHmacSha256)) {
        throw new Error('Acceptance Connection authority mismatch')
      }
      const authority = await this.#readStableAuthority(key)
      if (this.#disposed) throw new Error('Acceptance Connection admission is disposed')
      if (!equalSha256(authority.authorityHmacSha256, request.expectedHmacSha256)) {
        throw new Error('Acceptance Connection authority mismatch')
      }
      if (!existing) {
        this.#armed = Object.freeze({
          key: Buffer.from(key),
          workspaceId: authority.workspaceId,
          workspaceRoot: authority.workspaceRoot,
          llmConnection: authority.llmConnection,
          provider: authority.provider,
          authType: authority.authType,
          resolvedModel: authority.resolvedModel,
          authorityHmacSha256: authority.authorityHmacSha256,
          credentialHmacSha256: authority.credentialHmacSha256,
        })
      }
      return Object.freeze({
        schemaVersion: 1 as const,
        armed: true as const,
        authorityHmacSha256: authority.authorityHmacSha256,
      })
    } finally {
      release()
      key.fill(0)
    }
  }

  /**
   * Arms the effective Craft Connection entirely inside the main process.
   *
   * OpenDesign is a normal module surface, not an acceptance-console feature:
   * a signed-in user must not first perform an invisible H1/A1 handshake in
   * DevTools before the first Module Turn can start. The random authority key
   * is process-local, never crosses IPC, and is cleared immediately after the
   * existing proof-and-arm flow completes.
   */
  async armActiveConnection(): Promise<void> {
    if (this.#disposed) throw new Error('Acceptance Connection admission is disposed')
    const key = randomBytes(32)
    const keyBase64 = key.toString('base64')
    try {
      const authority = await this.getConnectionAuthority({ keyBase64 })
      await this.armConnectionAdmission({
        keyBase64,
        expectedHmacSha256: authority.authorityHmacSha256,
      })
    } finally {
      key.fill(0)
    }
  }

  async admit(workspaceId: string): Promise<Readonly<{
    llmConnection: string
    provider: BackendRuntimeAuthoritySnapshot['provider']
    authType: BackendRuntimeAuthoritySnapshot['authType']
    resolvedModel: string
  }>> {
    const armed = this.#armed
    if (this.#disposed || !armed) throw new Error('Acceptance Connection admission is not armed')
    if (workspaceId !== armed.workspaceId) throw new Error('Acceptance Connection workspace mismatch')
    const authority = await this.#readStableAuthority(armed.key, workspaceId)
    if (!equalSha256(authority.authorityHmacSha256, armed.authorityHmacSha256)
      || authority.workspaceRoot !== armed.workspaceRoot
      || authority.llmConnection !== armed.llmConnection
      || authority.provider !== armed.provider
      || authority.authType !== armed.authType
      || authority.resolvedModel !== armed.resolvedModel
      || !equalSha256(authority.credentialHmacSha256, armed.credentialHmacSha256)
      || this.#armed !== armed) {
      throw new Error('Acceptance Connection authority drifted')
    }
    return Object.freeze({
      llmConnection: armed.llmConnection,
      provider: armed.provider,
      authType: armed.authType,
      resolvedModel: armed.resolvedModel,
    })
  }

  async assertConnection(input: Readonly<{
    workspaceId: string
  } & BackendRuntimeAuthoritySnapshot>): Promise<void> {
    const armed = this.#armed
    if (!armed
      || input.workspaceId !== armed.workspaceId
      || input.connectionSlug !== armed.llmConnection
      || input.provider !== armed.provider
      || input.authType !== armed.authType
      || input.resolvedModel !== armed.resolvedModel) {
      throw new Error('Acceptance Connection admission mismatch')
    }
    await this.admit(input.workspaceId)
  }

  async assertCredential(input: Readonly<{
    workspaceId: string
    llmConnection: string
    credential: BackendCredentialAuthoritySnapshot
  }>): Promise<void> {
    const armed = this.#armed
    if (!armed || input.workspaceId !== armed.workspaceId || input.llmConnection !== armed.llmConnection) {
      throw new Error('Acceptance Connection admission mismatch')
    }
    await this.admit(input.workspaceId)
    const actualHmac = hmacCredential(armed.key, input.credential)
    if (!equalSha256(actualHmac, armed.credentialHmacSha256) || this.#armed !== armed) {
      throw new Error('Acceptance Connection credential mismatch')
    }
  }

  dispose(): void {
    this.#disposed = true
    this.#armed?.key.fill(0)
    this.#armed = undefined
  }

  async #readStableAuthority(key: Buffer, expectedWorkspaceId?: string): Promise<StableAuthority> {
    const first = await this.#readAuthoritySnapshot(expectedWorkspaceId)
    const firstHmac = hmacAuthority(key, first.material)
    const firstCredentialHmac = hmacCredential(key, first.providerCredential)
    const second = await this.#readAuthoritySnapshot(expectedWorkspaceId)
    const secondHmac = hmacAuthority(key, second.material)
    const secondCredentialHmac = hmacCredential(key, second.providerCredential)
    if (!equalSha256(firstHmac, secondHmac)
      || !equalSha256(firstCredentialHmac, secondCredentialHmac)
      || first.workspaceId !== second.workspaceId
      || first.workspaceRoot !== second.workspaceRoot
      || first.llmConnection !== second.llmConnection
      || first.provider !== second.provider
      || first.authType !== second.authType
      || first.resolvedModel !== second.resolvedModel) {
      throw new Error('Acceptance Connection authority changed while reading')
    }
    return Object.freeze({
      ...second,
      authorityHmacSha256: secondHmac,
      credentialHmacSha256: secondCredentialHmac,
    })
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
    if ((runtime.provider !== 'anthropic' && runtime.provider !== 'pi')
      || !runtime.authType || !runtime.resolvedModel) {
      throw new Error('Acceptance Connection runtime is unavailable')
    }
    const credential = await credentialAuthority(this.#credentials, connection)
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
      credential: credential.generation,
      providerCredential: credential.providerCredential,
    })
    return Object.freeze({
      workspaceId: workspace.id,
      workspaceRoot,
      llmConnection: connection.slug,
      provider: runtime.provider,
      authType: runtime.authType as BackendRuntimeAuthoritySnapshot['authType'],
      resolvedModel: runtime.resolvedModel,
      providerCredential: credential.providerCredential,
      material,
    })
  }
}
