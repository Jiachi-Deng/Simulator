import { ContractValidationError, stableJson } from './json.ts'
import { parseRequestEnvelope } from './schema.ts'
import {
  DEFAULT_LIMITS,
  SCHEMA_VERSION,
  type ApprovalResolution,
  type BridgeDependencies,
  type BridgeErrorCode,
  type BridgeSnapshot,
  type CapabilityGrant,
  type CapabilityGrantRequest,
  type CapabilityKind,
  type ContractLimits,
  type EventEnvelope,
  type JsonObject,
  type JsonValue,
  type PathResolution,
  type RequestEnvelope,
  type ResponseEnvelope,
} from './types.ts'

interface CapabilityRecord {
  tokenHash: string
  kind: CapabilityKind
  moduleId: string
  processId: string
  workspaceRoot: PathResolution
  allowedMethods: Set<CapabilityKind>
  expiresAt: number
  maxUses: number
  uses: number
  nonce: string
  revoked: boolean
}

interface ReplayRecord {
  identityHash: string
  response: ResponseEnvelope
}

interface ApprovalRecord {
  approvalId: string
  moduleId: string
  processId: string
  sessionId: string
  turnId: string
  requestId: string
  prompt: string
  expiresAt: number
  status: 'pending' | 'approved' | 'denied' | 'cancelled' | 'timed_out'
  reason?: string
}

export interface ApprovalStatus {
  approvalId: string
  status: ApprovalRecord['status']
  reason?: string
}

export class ModuleHostBridge {
  readonly #deps: BridgeDependencies
  readonly #limits: ContractLimits
  readonly #capabilities = new Map<string, CapabilityRecord>()
  readonly #replays = new Map<string, ReplayRecord>()
  readonly #approvals = new Map<string, ApprovalRecord>()
  readonly #auditEvents: EventEnvelope[] = []
  #auditSequence = 0
  #approvalSequence = 0
  #tail: Promise<void> = Promise.resolve()

  constructor(dependencies: BridgeDependencies) {
    this.#deps = dependencies
    this.#limits = Object.freeze({ ...DEFAULT_LIMITS, ...dependencies.limits })
  }

  grant(input: CapabilityGrantRequest): Promise<CapabilityGrant> {
    return this.#exclusive(async () => {
      if (input.descriptor.kind === 'host-agent.opaque') {
        throw new BridgePolicyError('UNSUPPORTED_CAPABILITY', 'Host-agent opaque capabilities are unsupported by this bridge version')
      }
      if (!Number.isFinite(input.expiresAt) || input.expiresAt <= this.#deps.clock.now()) {
        throw new ContractValidationError('Capability expiry must be in the future')
      }
      if (!Number.isSafeInteger(input.maxUses) || input.maxUses < 1) {
        throw new ContractValidationError('Capability maxUses must be a positive integer')
      }
      if (input.allowedMethods.length === 0 || !input.allowedMethods.includes(input.descriptor.kind)) {
        throw new ContractValidationError('Allowed methods must include the capability kind')
      }
      if (new Set(input.allowedMethods).size !== input.allowedMethods.length) {
        throw new ContractValidationError('Allowed methods must be unique')
      }

      const [workspaceRoot, filesystemRoot, hostDataRoot, moduleDataRoot] = await Promise.all([
        this.#deps.paths.resolve(input.workspaceRoot),
        this.#deps.paths.resolve(this.#deps.forbiddenRoots.filesystemRoot),
        this.#deps.paths.resolve(this.#deps.forbiddenRoots.hostDataRoot),
        this.#deps.paths.resolve(this.#deps.forbiddenRoots.moduleDataRoot),
      ])
      if (this.#isForbidden(workspaceRoot.realPath, filesystemRoot, hostDataRoot, moduleDataRoot)) {
        throw new BridgePolicyError('PATH_DENIED', 'Workspace root is a protected host path')
      }

      const token = toHex(this.#deps.entropy.bytes(32))
      if (token.length !== 64) throw new ContractValidationError('Entropy source must return exactly 32 bytes')
      const tokenHash = this.#deps.hasher.hash(token)
      if (this.#capabilities.has(tokenHash)) throw new ContractValidationError('Entropy source generated a duplicate token')

      this.#capabilities.set(tokenHash, {
        tokenHash,
        kind: input.descriptor.kind,
        moduleId: input.moduleId,
        processId: input.processId,
        workspaceRoot,
        allowedMethods: new Set(input.allowedMethods),
        expiresAt: input.expiresAt,
        maxUses: input.maxUses,
        uses: 0,
        nonce: input.nonce,
        revoked: false,
      })
      await this.#audit('capability.issued', {
        moduleId: input.moduleId,
        processId: input.processId,
        kind: input.descriptor.kind,
        expiresAt: input.expiresAt,
        maxUses: input.maxUses,
      })
      return { token, expiresAt: input.expiresAt, maxUses: input.maxUses }
    })
  }

  handle(input: unknown): Promise<ResponseEnvelope> {
    let parsed: RequestEnvelope
    try {
      parsed = parseRequestEnvelope(input, this.#limits)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid request'
      const code = message.startsWith('Unsupported schema version') ? 'UNSUPPORTED_VERSION' : 'INVALID_REQUEST'
      return Promise.resolve(errorResponse(extractRequestId(input), code, message))
    }

    return this.#exclusive(async () => {
      const identityHash = this.#deps.hasher.hash(stableJson(parsed as unknown as JsonValue))
      const replay = this.#replays.get(parsed.requestId)
      if (replay) {
        if (replay.identityHash !== identityHash) {
          await this.#audit('capability.denied', scopedAudit(parsed, { code: 'REPLAY_MISMATCH' }))
          return errorResponse(parsed.requestId, 'REPLAY_MISMATCH', 'Request id was already used with a different identity')
        }
        return structuredClone(replay.response)
      }

      const response = await this.#authorize(parsed)
      this.#rememberReplay(parsed.requestId, identityHash, response)
      return structuredClone(response)
    })
  }

  revokeModule(moduleId: string): Promise<number> {
    return this.#exclusive(() => this.#revoke(record => record.moduleId === moduleId, 'module'))
  }

  revokeProcess(moduleId: string, processId: string): Promise<number> {
    return this.#exclusive(() => this.#revoke(record => record.moduleId === moduleId && record.processId === processId, 'process'))
  }

  revokeAll(): Promise<number> {
    return this.#exclusive(() => this.#revoke(() => true, 'all'))
  }

  restartProcess(moduleId: string, processId: string): Promise<void> {
    return this.#exclusive(async () => {
      await this.#revoke(record => record.moduleId === moduleId && record.processId === processId, 'crash')
      await this.#cancelApprovals(record => record.moduleId === moduleId && record.processId === processId, 'process restarted')
    })
  }

  cancelApproval(approvalId: string): Promise<ApprovalStatus> {
    return this.#exclusive(async () => {
      const record = this.#approvals.get(approvalId)
      if (!record) throw new BridgePolicyError('APPROVAL_NOT_FOUND', 'Approval was not found')
      if (record.status !== 'pending') throw new BridgePolicyError('APPROVAL_NOT_PENDING', 'Approval is not pending')
      record.status = 'cancelled'
      record.reason = 'cancelled by trusted host'
      record.prompt = ''
      await this.#audit('approval.cancelled', approvalAudit(record))
      return approvalStatus(record)
    })
  }

  getApproval(approvalId: string): ApprovalStatus | undefined {
    const record = this.#approvals.get(approvalId)
    return record ? approvalStatus(record) : undefined
  }

  sweepExpired(): Promise<{ capabilities: number; approvals: number }> {
    return this.#exclusive(async () => {
      const now = this.#deps.clock.now()
      let capabilities = 0
      let approvals = 0
      for (const record of this.#capabilities.values()) {
        if (!record.revoked && record.expiresAt <= now) {
          record.revoked = true
          capabilities += 1
          await this.#audit('capability.revoked', capabilityAudit(record, { reason: 'expired' }))
        }
      }
      for (const record of this.#approvals.values()) {
        if (record.status === 'pending' && record.expiresAt <= now) {
          record.status = 'timed_out'
          record.reason = 'approval expired'
          record.prompt = ''
          approvals += 1
          await this.#audit('approval.timed_out', approvalAudit(record))
        }
      }
      return { capabilities, approvals }
    })
  }

  snapshot(): BridgeSnapshot {
    let activeCapabilities = 0
    let pendingApprovals = 0
    const now = this.#deps.clock.now()
    for (const record of this.#capabilities.values()) {
      if (!record.revoked && record.expiresAt > now && record.uses < record.maxUses) activeCapabilities += 1
    }
    for (const record of this.#approvals.values()) {
      if (record.status === 'pending' && record.expiresAt > now) pendingApprovals += 1
    }
    return {
      activeCapabilities,
      replayEntries: this.#replays.size,
      pendingApprovals,
      auditEvents: structuredClone(this.#auditEvents),
    }
  }

  async #authorize(request: RequestEnvelope): Promise<ResponseEnvelope> {
    const tokenHash = this.#deps.hasher.hash(request.capabilityToken)
    const record = this.#capabilities.get(tokenHash)
    const deny = async (code: BridgeErrorCode, message: string): Promise<ResponseEnvelope> => {
      await this.#audit('capability.denied', scopedAudit(request, { code }))
      return errorResponse(request.requestId, code, message)
    }

    if (!record) return deny('CAPABILITY_NOT_FOUND', 'Capability token was not found')
    if (record.revoked) return deny('CAPABILITY_REVOKED', 'Capability was revoked')
    if (record.expiresAt <= this.#deps.clock.now()) return deny('CAPABILITY_EXPIRED', 'Capability expired')
    if (record.uses >= record.maxUses) return deny('CAPABILITY_EXHAUSTED', 'Capability use limit was reached')
    if (record.moduleId !== request.moduleId || record.processId !== request.processId || !record.allowedMethods.has(request.method)) {
      return deny('CAPABILITY_SCOPE_MISMATCH', 'Capability scope does not match request identity')
    }

    const path = await this.#authorizePath(request, record)
    if (path === false) return deny('PATH_DENIED', 'Requested path is outside the workspace or targets protected host data')

    record.uses += 1
    let result: JsonObject
    if (request.method === 'approval.request') {
      result = this.#beginApproval(request)
    } else if (request.method === 'credential.use') {
      result = {
        authorized: true,
        method: request.method,
        credentialHandle: request.payload.credentialHandle!,
        operation: request.payload.operation!,
      }
    } else {
      result = { authorized: true, method: request.method }
      if (path) result.canonicalPath = path.realPath
    }

    await this.#audit('capability.used', scopedAudit(request, { kind: record.kind, use: record.uses }))
    return successResponse(request.requestId, result)
  }

  async #authorizePath(request: RequestEnvelope, record: CapabilityRecord): Promise<PathResolution | undefined | false> {
    const untrustedPath = pathFromRequest(request)
    if (!untrustedPath) return undefined
    const [candidate, filesystemRoot, hostDataRoot, moduleDataRoot] = await Promise.all([
      this.#deps.paths.resolve(untrustedPath),
      this.#deps.paths.resolve(this.#deps.forbiddenRoots.filesystemRoot),
      this.#deps.paths.resolve(this.#deps.forbiddenRoots.hostDataRoot),
      this.#deps.paths.resolve(this.#deps.forbiddenRoots.moduleDataRoot),
    ])
    if (!this.#deps.paths.isEqualOrWithin(candidate.realPath, record.workspaceRoot.realPath)) return false
    if (this.#isForbidden(candidate.realPath, filesystemRoot, hostDataRoot, moduleDataRoot)) return false
    return candidate
  }

  #isForbidden(candidate: string, filesystem: PathResolution, host: PathResolution, module: PathResolution): boolean {
    return candidate === filesystem.realPath
      || this.#deps.paths.isEqualOrWithin(candidate, host.realPath)
      || this.#deps.paths.isEqualOrWithin(candidate, module.realPath)
  }

  #beginApproval(request: RequestEnvelope): JsonObject {
    const expiresAt = request.payload.expiresAt as number
    const approvalId = `approval-${++this.#approvalSequence}`
    const record: ApprovalRecord = {
      approvalId,
      moduleId: request.moduleId,
      processId: request.processId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      requestId: request.requestId,
      prompt: request.payload.prompt as string,
      expiresAt,
      status: 'pending',
    }
    this.#approvals.set(approvalId, record)
    void this.#audit('approval.pending', approvalAudit(record))
    void this.#deps.approvals.resolve({
      approvalId,
      moduleId: record.moduleId,
      processId: record.processId,
      sessionId: record.sessionId,
      turnId: record.turnId,
      requestId: record.requestId,
      prompt: record.prompt,
      expiresAt: record.expiresAt,
    }).then(
      resolution => this.#completeApproval(approvalId, resolution),
      () => this.#completeApproval(approvalId, { decision: 'denied', reason: 'resolver failed' }),
    )
    return { approvalId, status: 'pending' }
  }

  #completeApproval(approvalId: string, resolution: ApprovalResolution): Promise<void> {
    return this.#exclusive(async () => {
      const record = this.#approvals.get(approvalId)
      if (!record || record.status !== 'pending') return
      if (record.expiresAt <= this.#deps.clock.now()) {
        record.status = 'timed_out'
        record.reason = 'approval expired'
        record.prompt = ''
        await this.#audit('approval.timed_out', approvalAudit(record))
        return
      }
      record.status = resolution.decision
      record.reason = resolution.reason
      record.prompt = ''
      await this.#audit('approval.resolved', approvalAudit(record))
    })
  }

  async #revoke(predicate: (record: CapabilityRecord) => boolean, reason: string): Promise<number> {
    let count = 0
    for (const record of this.#capabilities.values()) {
      if (!record.revoked && predicate(record)) {
        record.revoked = true
        count += 1
        await this.#audit('capability.revoked', capabilityAudit(record, { reason }))
      }
    }
    return count
  }

  async #cancelApprovals(predicate: (record: ApprovalRecord) => boolean, reason: string): Promise<number> {
    let count = 0
    for (const record of this.#approvals.values()) {
      if (record.status === 'pending' && predicate(record)) {
        record.status = 'cancelled'
        record.reason = reason
        record.prompt = ''
        count += 1
        await this.#audit('approval.cancelled', approvalAudit(record))
      }
    }
    return count
  }

  #rememberReplay(requestId: string, identityHash: string, response: ResponseEnvelope): void {
    if (this.#replays.size >= this.#limits.maxReplayEntries) {
      const oldest = this.#replays.keys().next().value
      if (oldest !== undefined) this.#replays.delete(oldest)
    }
    this.#replays.set(requestId, { identityHash, response: structuredClone(response) })
  }

  async #audit(event: EventEnvelope['event'], payload: JsonObject): Promise<void> {
    const envelope: EventEnvelope = {
      schemaVersion: SCHEMA_VERSION,
      type: 'event',
      eventId: `audit-${++this.#auditSequence}`,
      event,
      occurredAt: this.#deps.clock.now(),
      payload,
    }
    if (this.#auditEvents.length >= this.#limits.maxAuditEvents) this.#auditEvents.shift()
    this.#auditEvents.push(envelope)
    await this.#deps.audit.record(structuredClone(envelope))
  }

  #exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const run = this.#tail.then(operation, operation)
    this.#tail = run.then(() => undefined, () => undefined)
    return run
  }
}

export class BridgePolicyError extends Error {
  constructor(readonly code: BridgeErrorCode, message: string) {
    super(message)
    this.name = 'BridgePolicyError'
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function extractRequestId(input: unknown): string {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const requestId = (input as Record<string, unknown>).requestId
    if (typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 256) return requestId
  }
  return 'invalid'
}

function successResponse(requestId: string, result: JsonObject): ResponseEnvelope {
  return { schemaVersion: SCHEMA_VERSION, type: 'response', requestId, ok: true, result }
}

function errorResponse(requestId: string, code: BridgeErrorCode, message: string): ResponseEnvelope {
  return { schemaVersion: SCHEMA_VERSION, type: 'response', requestId, ok: false, error: { code, message } }
}

function pathFromRequest(request: RequestEnvelope): string | undefined {
  switch (request.method) {
    case 'folder.pick': return request.payload.suggestedRoot as string | undefined
    case 'path.authorize': return request.payload.path as string
    case 'file.export': return request.payload.sourcePath as string
    case 'artifact.publish': return request.payload.artifactPath as string
    default: return undefined
  }
}

function scopedAudit(request: RequestEnvelope, extra: JsonObject = {}): JsonObject {
  return {
    moduleId: request.moduleId,
    processId: request.processId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    requestId: request.requestId,
    method: request.method,
    ...extra,
  }
}

function capabilityAudit(record: CapabilityRecord, extra: JsonObject = {}): JsonObject {
  return { moduleId: record.moduleId, processId: record.processId, kind: record.kind, ...extra }
}

function approvalAudit(record: ApprovalRecord): JsonObject {
  return {
    approvalId: record.approvalId,
    moduleId: record.moduleId,
    processId: record.processId,
    sessionId: record.sessionId,
    turnId: record.turnId,
    requestId: record.requestId,
    status: record.status,
  }
}

function approvalStatus(record: ApprovalRecord): ApprovalStatus {
  return { approvalId: record.approvalId, status: record.status, ...(record.reason ? { reason: record.reason } : {}) }
}
