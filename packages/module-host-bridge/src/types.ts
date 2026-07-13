export const SCHEMA_VERSION = 1 as const

export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export const CAPABILITY_KINDS = [
  'folder.pick',
  'path.authorize',
  'file.export',
  'external.open',
  'oauth.launch',
  'credential.use',
  'approval.request',
  'notification.send',
  'artifact.publish',
] as const

export type CapabilityKind = (typeof CAPABILITY_KINDS)[number]
export type CapabilityDescriptor =
  | { kind: CapabilityKind }
  | { kind: 'host-agent.opaque'; version: number; opaque: JsonObject }

export interface RequestEnvelope {
  schemaVersion: typeof SCHEMA_VERSION
  type: 'request'
  requestId: string
  moduleId: string
  processId: string
  sessionId: string
  turnId: string
  method: CapabilityKind
  capabilityToken: string
  nonce: string
  payload: JsonObject
}

export interface ResponseEnvelope {
  schemaVersion: typeof SCHEMA_VERSION
  type: 'response'
  requestId: string
  replayed: boolean
  ok: boolean
  result?: JsonObject
  error?: BridgeError
}

export interface EventEnvelope {
  schemaVersion: typeof SCHEMA_VERSION
  type: 'event'
  eventId: string
  event: AuditEventKind
  occurredAt: number
  payload: JsonObject
}

export const BRIDGE_ERROR_CODES = [
  'INVALID_REQUEST',
  'UNSUPPORTED_VERSION',
  'UNSUPPORTED_CAPABILITY',
  'CAPABILITY_NOT_FOUND',
  'CAPABILITY_EXPIRED',
  'CAPABILITY_REVOKED',
  'CAPABILITY_EXHAUSTED',
  'CAPABILITY_SCOPE_MISMATCH',
  'PATH_DENIED',
  'REPLAY_MISMATCH',
  'REPLAY_CAPACITY',
  'APPROVAL_NOT_FOUND',
  'APPROVAL_NOT_PENDING',
  'CREDENTIAL_DENIED',
  'URL_DENIED',
  'EXECUTION_RECEIPT_NOT_FOUND',
  'EXECUTION_RECEIPT_STATE',
] as const

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number]

export interface BridgeError {
  code: BridgeErrorCode
  message: string
}

export interface ContractLimits {
  maxBytes: number
  maxDepth: number
  maxNodes: number
  maxStringLength: number
  maxObjectKeys: number
  maxAuditEvents: number
  maxAuditQueue: number
  auditSinkTimeoutMs: number
  maxReplayEntries: number
}

export const DEFAULT_LIMITS: ContractLimits = Object.freeze({
  maxBytes: 64 * 1024,
  maxDepth: 12,
  maxNodes: 2_048,
  maxStringLength: 8_192,
  maxObjectKeys: 64,
  maxAuditEvents: 512,
  maxAuditQueue: 256,
  auditSinkTimeoutMs: 250,
  maxReplayEntries: 1_024,
})

export interface Clock {
  now(): number
}

export interface EntropySource {
  bytes(length: number): Uint8Array
}

export interface TokenHasher {
  hash(token: string): string
}

export interface PathResolution {
  canonicalPath: string
  realPath: string
}

export interface PathAuthority {
  resolve(untrustedPath: string): Promise<PathResolution>
  isEqualOrWithin(candidateRealPath: string, rootRealPath: string): boolean
}

export const PATH_OPERATIONS = ['read', 'write', 'create', 'delete', 'enumerate'] as const
export type PathOperation = (typeof PATH_OPERATIONS)[number]

export interface TrustedTransportContext {
  ownerId: string
  moduleId: string
  processId: string
}

export interface CredentialAuthority {
  validate(input: {
    opaqueHandle: string
    ownerId: string
    moduleId: string
    processId: string
    operation: string
  }): boolean | Promise<boolean>
}

export interface URLAuthority {
  authorize(input: {
    kind: 'external.open' | 'oauth.launch'
    url: string
    moduleId: string
    processId: string
  }): { authorized: boolean; normalizedUrl?: string } | Promise<{ authorized: boolean; normalizedUrl?: string }>
}

export interface AuditSink {
  record(event: EventEnvelope): void | Promise<void>
}

export interface ApprovalResolution {
  decision: 'approved' | 'denied'
  reason?: string
}

export interface TrustedApprovalResolver {
  resolve(input: {
    approvalId: string
    ownerId: string
    moduleId: string
    processId: string
    sessionId: string
    turnId: string
    requestId: string
    prompt: string
    expiresAt: number
  }): Promise<ApprovalResolution>
}

export interface CapabilityGrantRequest {
  descriptor: CapabilityDescriptor
  ownerId: string
  moduleId: string
  processId: string
  workspaceRoot: string
  allowedMethods: CapabilityKind[]
  expiresAt: number
  maxUses: number
  nonce: string
}

export interface CapabilityGrant {
  token: string
  expiresAt: number
  maxUses: number
}

export const EXECUTION_RECEIPT_STATUSES = ['authorized', 'executing', 'committed', 'failed'] as const
export type ExecutionReceiptStatus = (typeof EXECUTION_RECEIPT_STATUSES)[number]

export interface ExecutionReceipt {
  receiptId: string
  requestId: string
  ownerId: string
  moduleId: string
  processId: string
  method: CapabilityKind
  status: ExecutionReceiptStatus
}

export interface ExecutionClaim {
  acquired: boolean
  receipt: ExecutionReceipt
}

export const AUDIT_EVENT_KINDS = [
  'capability.issued',
  'capability.used',
  'capability.denied',
  'capability.revoked',
  'approval.pending',
  'approval.resolved',
  'approval.cancelled',
  'approval.timed_out',
  'request.malformed',
  'execution.started',
  'execution.committed',
  'execution.failed',
] as const

export type AuditEventKind = (typeof AUDIT_EVENT_KINDS)[number]

export interface BridgeSnapshot {
  activeCapabilities: number
  replayEntries: number
  pendingApprovals: number
  auditEvents: readonly EventEnvelope[]
}

export interface BridgeDependencies {
  clock: Clock
  entropy: EntropySource
  hasher: TokenHasher
  paths: PathAuthority
  credentials: CredentialAuthority
  urls: URLAuthority
  audit: AuditSink
  approvals: TrustedApprovalResolver
  forbiddenRoots: {
    filesystemRoot: string
    hostDataRoot: string
    moduleDataRoot: string
  }
  limits?: Partial<ContractLimits>
}
