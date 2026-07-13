import { ContractValidationError, stableJson } from './json.ts'
import { parseRawRequest, parseRequestEnvelope } from './schema.ts'
import {
  CAPABILITY_KINDS,
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
  type ExecutionClaim,
  type ExecutionReceipt,
  type JsonObject,
  type JsonValue,
  type PathResolution,
  type RequestEnvelope,
  type ResponseEnvelope,
  type TrustedTransportContext,
} from './types.ts'

interface CapabilityRecord {
  tokenHash: string
  kind: CapabilityKind
  ownerId: string
  moduleId: string
  processId: string
  generation: number
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
  tokenHash: string
  generation: number
  ownerId: string
  moduleId: string
  processId: string
  response: ResponseEnvelope
  receiptId?: string
  approvalId?: string
}

interface ApprovalRecord {
  approvalId: string
  tokenHash: string
  generation: number
  ownerId: string
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

interface PolicyDenial {
  code: BridgeErrorCode
  message: string
}

interface ExecutionReceiptRecord extends ExecutionReceipt {
  tokenHash: string
  generation: number
}

const capabilityKinds = new Set<string>(CAPABILITY_KINDS)

export interface ApprovalStatus {
  approvalId: string
  status: ApprovalRecord['status']
  reason?: string
}

export class ModuleHostBridge {
  readonly #deps: BridgeDependencies
  readonly #limits: ContractLimits
  readonly #capabilities = new Map<string, CapabilityRecord>()
  readonly #generations = new Map<string, number>()
  readonly #replays = new Map<string, Map<string, ReplayRecord>>()
  readonly #receipts = new Map<string, ExecutionReceiptRecord>()
  readonly #approvals = new Map<string, ApprovalRecord>()
  readonly #auditEvents: EventEnvelope[] = []
  readonly #auditQueue: EventEnvelope[] = []
  readonly #auditWaiters: Array<() => void> = []
  #auditSequence = 0
  #approvalSequence = 0
  #receiptSequence = 0
  #auditDrainActive = false
  #tail: Promise<void> = Promise.resolve()

  constructor(dependencies: BridgeDependencies) {
    this.#deps = dependencies
    this.#limits = Object.freeze({ ...DEFAULT_LIMITS, ...dependencies.limits })
    for (const [name, value] of Object.entries(this.#limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new ContractValidationError(`Limit ${name} must be a positive integer`)
    }
  }

  grant(input: CapabilityGrantRequest): Promise<CapabilityGrant> {
    return this.#exclusive(async () => {
      if (input === null || typeof input !== 'object') {
        throw new ContractValidationError('Capability grant must be an object')
      }
      const descriptor = (input as { descriptor?: unknown }).descriptor
      const descriptorKind = descriptor !== null && typeof descriptor === 'object'
        ? (descriptor as { kind?: unknown }).kind
        : undefined
      if (descriptorKind === 'host-agent.opaque') {
        throw new BridgePolicyError('UNSUPPORTED_CAPABILITY', 'Host-agent opaque capabilities are unsupported by this bridge version')
      }
      if (!isCapabilityKind(descriptorKind)) {
        throw new BridgePolicyError('UNSUPPORTED_CAPABILITY', 'Capability descriptor kind must be a canonical supported method')
      }
      if (!Array.isArray(input.allowedMethods) || input.allowedMethods.length !== 1
        || !isCapabilityKind(input.allowedMethods[0]) || input.allowedMethods[0] !== descriptorKind) {
        throw new ContractValidationError('Allowed methods must exactly match a canonical capability descriptor kind')
      }
      if (!isNonEmptyString(input.ownerId) || !isNonEmptyString(input.moduleId)
        || !isNonEmptyString(input.processId) || !isNonEmptyString(input.nonce)) {
        throw new ContractValidationError('Capability identity and nonce must be non-empty')
      }
      if (!Number.isFinite(input.expiresAt) || input.expiresAt <= this.#deps.clock.now()) {
        throw new ContractValidationError('Capability expiry must be in the future')
      }
      if (!Number.isSafeInteger(input.maxUses) || input.maxUses < 1) {
        throw new ContractValidationError('Capability maxUses must be a positive integer')
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

      const generation = this.#currentGeneration(input.moduleId, input.processId)
      this.#capabilities.set(tokenHash, {
        tokenHash,
        kind: descriptorKind,
        ownerId: input.ownerId,
        moduleId: input.moduleId,
        processId: input.processId,
        generation,
        workspaceRoot,
        allowedMethods: new Set([descriptorKind]),
        expiresAt: input.expiresAt,
        maxUses: input.maxUses,
        uses: 0,
        nonce: input.nonce,
        revoked: false,
      })
      this.#audit('capability.issued', {
        moduleId: input.moduleId,
        processId: input.processId,
        kind: descriptorKind,
        expiresAt: input.expiresAt,
        maxUses: input.maxUses,
        generation,
      })
      return { token, expiresAt: input.expiresAt, maxUses: input.maxUses }
    })
  }

  /** Internal trusted-object API. Untrusted transport bytes should use handleRaw(). */
  handle(input: unknown, context: TrustedTransportContext): Promise<ResponseEnvelope> {
    this.#assertContext(context)
    let parsed: RequestEnvelope
    try {
      parsed = parseRequestEnvelope(input, this.#limits)
    } catch (error) {
      return this.#malformed(input, context, error, 'object')
    }
    return this.#handleParsed(parsed, context)
  }

  handleRaw(input: string | Uint8Array, context: TrustedTransportContext): Promise<ResponseEnvelope> {
    this.#assertContext(context)
    let parsed: RequestEnvelope
    try {
      parsed = parseRawRequest(input, this.#limits)
    } catch (error) {
      return this.#malformed(undefined, context, error, 'raw')
    }
    return this.#handleParsed(parsed, context)
  }

  claimExecution(receiptId: string, context: TrustedTransportContext): Promise<ExecutionClaim> {
    this.#assertContext(context)
    return this.#exclusive(() => {
      const receipt = this.#requireReceipt(receiptId, context)
      if (receipt.status !== 'authorized') return { acquired: false, receipt: publicReceipt(receipt) }
      const capability = this.#capabilities.get(receipt.tokenHash)
      const denial = this.#validateReceiptCapability(capability, receipt)
      if (denial) throw new BridgePolicyError(denial.code, denial.message)
      receipt.status = 'executing'
      this.#audit('execution.started', receiptAudit(receipt))
      return { acquired: true, receipt: publicReceipt(receipt) }
    })
  }

  completeExecution(
    receiptId: string,
    status: 'committed' | 'failed',
    context: TrustedTransportContext,
  ): Promise<ExecutionReceipt> {
    this.#assertContext(context)
    return this.#exclusive(() => {
      const receipt = this.#requireReceipt(receiptId, context)
      if (receipt.status !== 'executing') {
        throw new BridgePolicyError('EXECUTION_RECEIPT_STATE', 'Execution receipt is not executing')
      }
      receipt.status = status
      this.#audit(status === 'committed' ? 'execution.committed' : 'execution.failed', receiptAudit(receipt))
      return publicReceipt(receipt)
    })
  }

  revokeModule(moduleId: string): Promise<number> {
    return this.#exclusive(async () => {
      this.#advanceModuleGenerations(moduleId)
      const predicate = (record: CapabilityRecord) => record.moduleId === moduleId
      const count = this.#revoke(predicate, 'module')
      this.#cancelApprovalsForCapabilities(predicate, 'module revoked')
      return count
    })
  }

  revokeProcess(moduleId: string, processId: string): Promise<number> {
    return this.#exclusive(async () => {
      this.#advanceGeneration(moduleId, processId)
      const predicate = (record: CapabilityRecord) => record.moduleId === moduleId && record.processId === processId
      const count = this.#revoke(predicate, 'process')
      this.#cancelApprovalsForCapabilities(predicate, 'process revoked')
      return count
    })
  }

  revokeAll(): Promise<number> {
    return this.#exclusive(async () => {
      for (const key of this.#generations.keys()) this.#generations.set(key, this.#generations.get(key)! + 1)
      const predicate = () => true
      const count = this.#revoke(predicate, 'all')
      this.#cancelApprovalsForCapabilities(predicate, 'all capabilities revoked')
      return count
    })
  }

  restartProcess(moduleId: string, processId: string): Promise<void> {
    return this.#exclusive(async () => {
      this.#advanceGeneration(moduleId, processId)
      const predicate = (record: CapabilityRecord) => record.moduleId === moduleId && record.processId === processId
      this.#revoke(predicate, 'crash')
      this.#cancelApprovalsForCapabilities(predicate, 'process restarted')
    })
  }

  cancelApproval(approvalId: string): Promise<ApprovalStatus> {
    return this.#exclusive(() => {
      const record = this.#approvals.get(approvalId)
      if (!record) throw new BridgePolicyError('APPROVAL_NOT_FOUND', 'Approval was not found')
      if (record.status !== 'pending') throw new BridgePolicyError('APPROVAL_NOT_PENDING', 'Approval is not pending')
      record.status = 'cancelled'
      record.reason = 'cancelled by trusted host'
      record.prompt = ''
      this.#audit('approval.cancelled', approvalAudit(record))
      return approvalStatus(record)
    })
  }

  getApproval(approvalId: string): ApprovalStatus | undefined {
    const record = this.#approvals.get(approvalId)
    return record ? approvalStatus(record) : undefined
  }

  sweepExpired(): Promise<{ capabilities: number; approvals: number }> {
    return this.#exclusive(() => {
      const now = this.#deps.clock.now()
      let capabilities = 0
      let approvals = 0
      for (const record of this.#capabilities.values()) {
        if (!record.revoked && record.expiresAt <= now) {
          record.revoked = true
          capabilities += 1
          this.#audit('capability.revoked', capabilityAudit(record, { reason: 'expired' }))
          approvals += this.#cancelApprovalsForCapabilities(candidate => candidate === record, 'capability expired')
        }
      }
      for (const record of this.#approvals.values()) {
        if (record.status === 'pending' && record.expiresAt <= now) {
          record.status = 'timed_out'
          record.reason = 'approval expired'
          record.prompt = ''
          approvals += 1
          this.#audit('approval.timed_out', approvalAudit(record))
        }
      }
      return { capabilities, approvals }
    })
  }

  flushAudit(): Promise<void> {
    if (!this.#auditDrainActive && this.#auditQueue.length === 0) return Promise.resolve()
    return new Promise(resolve => this.#auditWaiters.push(resolve))
  }

  snapshot(): BridgeSnapshot {
    let activeCapabilities = 0
    let pendingApprovals = 0
    const now = this.#deps.clock.now()
    for (const record of this.#capabilities.values()) {
      if (!record.revoked && record.expiresAt > now && record.uses < record.maxUses
        && record.generation === this.#currentGeneration(record.moduleId, record.processId)) activeCapabilities += 1
    }
    for (const record of this.#approvals.values()) {
      if (record.status === 'pending' && record.expiresAt > now) pendingApprovals += 1
    }
    return {
      activeCapabilities,
      replayEntries: this.#replayEntryCount(),
      pendingApprovals,
      auditEvents: structuredClone(this.#auditEvents),
    }
  }

  #handleParsed(parsed: RequestEnvelope, context: TrustedTransportContext): Promise<ResponseEnvelope> {
    const request = { ...parsed, moduleId: context.moduleId, processId: context.processId }
    return this.#exclusive(async () => {
      const identityHash = this.#deps.hasher.hash(stableJson(request as unknown as JsonValue))
      const namespace = principalKey(context.ownerId, context.moduleId, context.processId)
      const replay = this.#replays.get(namespace)?.get(request.requestId)
      if (replay) {
        if (!this.#matchesPrincipal(replay, context) || replay.identityHash !== identityHash) {
          this.#audit('capability.denied', scopedAudit(request, { code: 'REPLAY_MISMATCH' }))
          return errorResponse(request.requestId, 'REPLAY_MISMATCH', 'Request id was already used with a different identity')
        }
        const record = this.#capabilities.get(replay.tokenHash)
        const denial = this.#validateCapability(record, request, context, true, replay.generation)
        if (denial) {
          this.#audit('capability.denied', scopedAudit(request, { code: denial.code }))
          return errorResponse(request.requestId, denial.code, denial.message)
        }
        const response = structuredClone(replay.response)
        response.replayed = true
        if (response.ok && response.result && replay.receiptId) {
          const receipt = this.#receipts.get(replay.receiptId)
          if (receipt) response.result.executionReceipt = receiptJson(receipt)
        }
        return response
      }

      this.#reclaimReplays(namespace)
      if ((this.#replays.get(namespace)?.size ?? 0) >= this.#limits.maxReplayEntries) {
        return this.#deny(request, { code: 'REPLAY_CAPACITY', message: 'Replay store capacity was reached' })
      }

      const { response, tokenHash, generation, receiptId, approvalId } = await this.#authorize(request, context)
      if (response.ok && tokenHash !== undefined && generation !== undefined) {
        this.#rememberReplay(namespace, request.requestId, {
          identityHash,
          tokenHash,
          generation,
          ownerId: context.ownerId,
          moduleId: context.moduleId,
          processId: context.processId,
          response,
          ...(receiptId ? { receiptId } : {}),
          ...(approvalId ? { approvalId } : {}),
        })
      }
      return structuredClone(response)
    })
  }

  async #authorize(
    request: RequestEnvelope,
    context: TrustedTransportContext,
  ): Promise<{ response: ResponseEnvelope; tokenHash?: string; generation?: number; receiptId?: string; approvalId?: string }> {
    const tokenHash = this.#deps.hasher.hash(request.capabilityToken)
    const record = this.#capabilities.get(tokenHash)
    const denial = this.#validateCapability(record, request, context, false)
    if (denial || !record) return { response: this.#deny(request, denial!) }

    const path = await this.#authorizePath(request, record)
    if (path === false) return { response: this.#deny(request, { code: 'PATH_DENIED', message: 'Requested path is outside the workspace or targets protected host data' }) }
    if (request.method === 'approval.request' && (request.payload.expiresAt as number) <= this.#deps.clock.now()) {
      return { response: this.#deny(request, { code: 'INVALID_REQUEST', message: 'Approval expiry must be in the future' }) }
    }

    let normalizedUrl: string | undefined
    if (request.method === 'external.open' || request.method === 'oauth.launch') {
      const url = request.method === 'external.open' ? request.payload.url as string : request.payload.authorizationUrl as string
      const decision = await this.#deps.urls.authorize({
        kind: request.method,
        url,
        moduleId: request.moduleId,
        processId: request.processId,
      })
      if (!decision.authorized || !decision.normalizedUrl) {
        return { response: this.#deny(request, { code: 'URL_DENIED', message: 'URL scheme or origin is not authorized' }) }
      }
      normalizedUrl = decision.normalizedUrl
    }

    if (request.method === 'credential.use') {
      const authorized = await this.#deps.credentials.validate({
        opaqueHandle: request.payload.credentialHandle as string,
        ownerId: context.ownerId,
        moduleId: request.moduleId,
        processId: request.processId,
        operation: request.payload.operation as string,
      })
      if (!authorized) {
        return { response: this.#deny(request, { code: 'CREDENTIAL_DENIED', message: 'Credential handle is not authorized for this operation' }) }
      }
    }

    record.uses += 1
    let result: JsonObject
    let receiptId: string | undefined
    let approvalId: string | undefined
    if (request.method === 'approval.request') {
      const approval = this.#beginApproval(request, record)
      result = approval.result
      approvalId = approval.approvalId
    } else {
      const receipt = this.#createReceipt(request, record, context)
      receiptId = receipt.receiptId
      result = { authorized: true, method: request.method, executionReceipt: receiptJson(receipt) }
      if (path) {
        result.canonicalPath = path.canonicalPath
        result.realPath = path.realPath
      }
      if (normalizedUrl) result.normalizedUrl = normalizedUrl
    }

    this.#audit('capability.used', scopedAudit(request, { kind: record.kind, use: record.uses }))
    return {
      response: successResponse(request.requestId, result),
      tokenHash,
      generation: record.generation,
      ...(receiptId ? { receiptId } : {}),
      ...(approvalId ? { approvalId } : {}),
    }
  }

  #validateCapability(
    record: CapabilityRecord | undefined,
    request: RequestEnvelope,
    context: TrustedTransportContext,
    replay: boolean,
    replayGeneration?: number,
  ): PolicyDenial | undefined {
    if (!record) return { code: 'CAPABILITY_NOT_FOUND', message: 'Capability token was not found' }
    if (record.revoked) return { code: 'CAPABILITY_REVOKED', message: 'Capability was revoked' }
    if (record.expiresAt <= this.#deps.clock.now()) return { code: 'CAPABILITY_EXPIRED', message: 'Capability expired' }
    const currentGeneration = this.#currentGeneration(record.moduleId, record.processId)
    if (record.generation !== currentGeneration || (replayGeneration !== undefined && replayGeneration !== currentGeneration)) {
      return { code: 'CAPABILITY_REVOKED', message: 'Capability belongs to an obsolete process generation' }
    }
    if (!replay && record.uses >= record.maxUses) return { code: 'CAPABILITY_EXHAUSTED', message: 'Capability use limit was reached' }
    if (record.ownerId !== context.ownerId || record.moduleId !== request.moduleId || record.processId !== request.processId
      || record.nonce !== request.nonce || record.kind !== request.method || !record.allowedMethods.has(request.method)) {
      return { code: 'CAPABILITY_SCOPE_MISMATCH', message: 'Capability scope does not match trusted request identity' }
    }
    return undefined
  }

  #validateReceiptCapability(
    record: CapabilityRecord | undefined,
    receipt: ExecutionReceiptRecord,
  ): PolicyDenial | undefined {
    if (!record) return { code: 'CAPABILITY_NOT_FOUND', message: 'Capability token was not found' }
    if (record.revoked) return { code: 'CAPABILITY_REVOKED', message: 'Capability was revoked before execution began' }
    if (record.expiresAt <= this.#deps.clock.now()) {
      return { code: 'CAPABILITY_EXPIRED', message: 'Capability expired before execution began' }
    }
    if (record.generation !== receipt.generation
      || record.generation !== this.#currentGeneration(record.moduleId, record.processId)) {
      return { code: 'CAPABILITY_REVOKED', message: 'Capability belongs to an obsolete process generation' }
    }
    if (record.ownerId !== receipt.ownerId || record.moduleId !== receipt.moduleId
      || record.processId !== receipt.processId || record.kind !== receipt.method) {
      return { code: 'CAPABILITY_SCOPE_MISMATCH', message: 'Execution receipt does not match capability scope' }
    }
    return undefined
  }

  #deny(request: RequestEnvelope, denial: PolicyDenial): ResponseEnvelope {
    this.#audit('capability.denied', scopedAudit(request, { code: denial.code }))
    return errorResponse(request.requestId, denial.code, denial.message)
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

  #createReceipt(
    request: RequestEnvelope,
    capability: CapabilityRecord,
    context: TrustedTransportContext,
  ): ExecutionReceiptRecord {
    const receipt: ExecutionReceiptRecord = {
      receiptId: `receipt-${++this.#receiptSequence}`,
      requestId: request.requestId,
      ownerId: context.ownerId,
      moduleId: request.moduleId,
      processId: request.processId,
      method: request.method,
      status: 'authorized',
      tokenHash: capability.tokenHash,
      generation: capability.generation,
    }
    this.#receipts.set(receipt.receiptId, receipt)
    return receipt
  }

  #requireReceipt(receiptId: string, context: TrustedTransportContext): ExecutionReceiptRecord {
    const receipt = this.#receipts.get(receiptId)
    if (!receipt) throw new BridgePolicyError('EXECUTION_RECEIPT_NOT_FOUND', 'Execution receipt was not found')
    if (receipt.ownerId !== context.ownerId || receipt.moduleId !== context.moduleId || receipt.processId !== context.processId) {
      throw new BridgePolicyError('EXECUTION_RECEIPT_NOT_FOUND', 'Execution receipt was not found')
    }
    return receipt
  }

  #beginApproval(request: RequestEnvelope, capability: CapabilityRecord): { approvalId: string; result: JsonObject } {
    const expiresAt = request.payload.expiresAt as number
    const approvalId = `approval-${++this.#approvalSequence}`
    const record: ApprovalRecord = {
      approvalId,
      tokenHash: capability.tokenHash,
      generation: capability.generation,
      ownerId: capability.ownerId,
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
    this.#audit('approval.pending', approvalAudit(record))
    void this.#deps.approvals.resolve({
      approvalId,
      ownerId: record.ownerId,
      moduleId: record.moduleId,
      processId: record.processId,
      sessionId: record.sessionId,
      turnId: record.turnId,
      requestId: record.requestId,
      prompt: record.prompt,
      expiresAt: record.expiresAt,
    }).then(
      resolution => this.#completeApproval(approvalId, record.tokenHash, record.generation, resolution),
      () => this.#completeApproval(approvalId, record.tokenHash, record.generation, { decision: 'denied', reason: 'resolver failed' }),
    )
    return { approvalId, result: { approvalId, status: 'pending' } }
  }

  #completeApproval(
    approvalId: string,
    tokenHash: string,
    generation: number,
    resolution: ApprovalResolution,
  ): Promise<void> {
    return this.#exclusive(() => {
      const record = this.#approvals.get(approvalId)
      if (!record || record.status !== 'pending' || record.tokenHash !== tokenHash || record.generation !== generation) return
      const capabilityDenial = this.#validateApprovalCapability(record)
      if (capabilityDenial) {
        this.#cancelApprovalRecord(record, capabilityDenial.message)
        return
      }
      if (record.expiresAt <= this.#deps.clock.now()) {
        record.status = 'timed_out'
        record.reason = 'approval expired'
        record.prompt = ''
        this.#audit('approval.timed_out', approvalAudit(record))
        return
      }
      record.status = resolution.decision
      record.reason = resolution.reason
      record.prompt = ''
      this.#audit('approval.resolved', approvalAudit(record))
    })
  }

  #revoke(predicate: (record: CapabilityRecord) => boolean, reason: string): number {
    let count = 0
    for (const record of this.#capabilities.values()) {
      if (!record.revoked && predicate(record)) {
        record.revoked = true
        count += 1
        this.#audit('capability.revoked', capabilityAudit(record, { reason }))
      }
    }
    return count
  }

  #cancelApprovals(predicate: (record: ApprovalRecord) => boolean, reason: string): number {
    let count = 0
    for (const record of this.#approvals.values()) {
      if (record.status === 'pending' && predicate(record)) {
        this.#cancelApprovalRecord(record, reason)
        count += 1
      }
    }
    return count
  }

  #cancelApprovalsForCapabilities(predicate: (record: CapabilityRecord) => boolean, reason: string): number {
    return this.#cancelApprovals(approval => {
      const capability = this.#capabilities.get(approval.tokenHash)
      return capability !== undefined
        && capability.generation === approval.generation
        && capability.ownerId === approval.ownerId
        && capability.moduleId === approval.moduleId
        && capability.processId === approval.processId
        && predicate(capability)
    }, reason)
  }

  #cancelApprovalRecord(record: ApprovalRecord, reason: string): void {
    record.status = 'cancelled'
    record.reason = reason
    record.prompt = ''
    this.#audit('approval.cancelled', approvalAudit(record))
  }

  #validateApprovalCapability(record: ApprovalRecord): PolicyDenial | undefined {
    const capability = this.#capabilities.get(record.tokenHash)
    if (!capability) return { code: 'CAPABILITY_NOT_FOUND', message: 'Capability was no longer available for approval' }
    if (capability.revoked) return { code: 'CAPABILITY_REVOKED', message: 'Capability was revoked before approval resolved' }
    if (capability.expiresAt <= this.#deps.clock.now()) return { code: 'CAPABILITY_EXPIRED', message: 'Capability expired before approval resolved' }
    if (capability.generation !== record.generation
      || capability.generation !== this.#currentGeneration(capability.moduleId, capability.processId)) {
      return { code: 'CAPABILITY_REVOKED', message: 'Capability belongs to an obsolete process generation' }
    }
    if (capability.ownerId !== record.ownerId || capability.moduleId !== record.moduleId || capability.processId !== record.processId) {
      return { code: 'CAPABILITY_SCOPE_MISMATCH', message: 'Capability scope changed before approval resolved' }
    }
    return undefined
  }

  #rememberReplay(namespace: string, requestId: string, replay: ReplayRecord): void {
    let entries = this.#replays.get(namespace)
    if (!entries) {
      entries = new Map()
      this.#replays.set(namespace, entries)
    }
    entries.set(requestId, { ...replay, response: structuredClone(replay.response) })
  }

  #reclaimReplays(namespace: string): void {
    const entries = this.#replays.get(namespace)
    if (!entries) return
    for (const [requestId, replay] of entries) {
      if (this.#isReplayReclaimable(replay)) entries.delete(requestId)
    }
    if (entries.size === 0) this.#replays.delete(namespace)
  }

  #isReplayReclaimable(replay: ReplayRecord): boolean {
    const capability = this.#capabilities.get(replay.tokenHash)
    const capabilityIsCurrent = capability !== undefined
      && !capability.revoked
      && capability.expiresAt > this.#deps.clock.now()
      && capability.generation === replay.generation
      && capability.generation === this.#currentGeneration(capability.moduleId, capability.processId)
    if (capabilityIsCurrent) return false

    if (replay.receiptId) {
      const receipt = this.#receipts.get(replay.receiptId)
      return receipt === undefined || receipt.status === 'committed' || receipt.status === 'failed'
    }
    if (replay.approvalId) return this.#approvals.get(replay.approvalId)?.status !== 'pending'
    return true
  }

  #matchesPrincipal(replay: ReplayRecord, context: TrustedTransportContext): boolean {
    return replay.ownerId === context.ownerId
      && replay.moduleId === context.moduleId
      && replay.processId === context.processId
  }

  #replayEntryCount(): number {
    let count = 0
    for (const entries of this.#replays.values()) count += entries.size
    return count
  }

  #malformed(
    input: unknown,
    context: TrustedTransportContext,
    error: unknown,
    source: 'object' | 'raw',
  ): Promise<ResponseEnvelope> {
    const message = error instanceof Error ? error.message : 'Invalid request'
    const code = message.startsWith('Unsupported schema version') ? 'UNSUPPORTED_VERSION' : 'INVALID_REQUEST'
    this.#audit('request.malformed', {
      trust: 'untrusted',
      source,
      moduleId: context.moduleId,
      processId: context.processId,
      code,
    })
    return Promise.resolve(errorResponse(extractRequestId(input), code, message))
  }

  #audit(event: EventEnvelope['event'], payload: JsonObject): void {
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
    if (this.#auditQueue.length >= this.#limits.maxAuditQueue) this.#auditQueue.shift()
    this.#auditQueue.push(structuredClone(envelope))
    this.#startAuditDrain()
  }

  #startAuditDrain(): void {
    if (this.#auditDrainActive) return
    this.#auditDrainActive = true
    void this.#drainAudit()
  }

  async #drainAudit(): Promise<void> {
    while (this.#auditQueue.length > 0) {
      const event = this.#auditQueue.shift()!
      const sink = Promise.resolve()
        .then(() => this.#deps.audit.record(event))
        .then(() => undefined, () => undefined)
      await raceTimeout(sink, this.#limits.auditSinkTimeoutMs)
    }
    this.#auditDrainActive = false
    for (const resolve of this.#auditWaiters.splice(0)) resolve()
    if (this.#auditQueue.length > 0) this.#startAuditDrain()
  }

  #assertContext(context: TrustedTransportContext): void {
    if (!context || !isNonEmptyString(context.ownerId)
      || !isNonEmptyString(context.moduleId) || !isNonEmptyString(context.processId)) {
      throw new ContractValidationError('Trusted transport context identity must be non-empty')
    }
  }

  #currentGeneration(moduleId: string, processId: string): number {
    const key = processKey(moduleId, processId)
    const current = this.#generations.get(key) ?? 0
    if (!this.#generations.has(key)) this.#generations.set(key, current)
    return current
  }

  #advanceGeneration(moduleId: string, processId: string): void {
    const key = processKey(moduleId, processId)
    this.#generations.set(key, (this.#generations.get(key) ?? 0) + 1)
  }

  #advanceModuleGenerations(moduleId: string): void {
    const prefix = `${JSON.stringify(moduleId)}\u0000`
    for (const key of this.#generations.keys()) {
      if (key.startsWith(prefix)) this.#generations.set(key, this.#generations.get(key)! + 1)
    }
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
  return { schemaVersion: SCHEMA_VERSION, type: 'response', requestId, replayed: false, ok: true, result }
}

function errorResponse(requestId: string, code: BridgeErrorCode, message: string): ResponseEnvelope {
  return { schemaVersion: SCHEMA_VERSION, type: 'response', requestId, replayed: false, ok: false, error: { code, message } }
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
  return { moduleId: record.moduleId, processId: record.processId, kind: record.kind, generation: record.generation, ...extra }
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

function receiptAudit(receipt: ExecutionReceipt): JsonObject {
  return {
    receiptId: receipt.receiptId,
    requestId: receipt.requestId,
    ownerId: receipt.ownerId,
    moduleId: receipt.moduleId,
    processId: receipt.processId,
    method: receipt.method,
    status: receipt.status,
  }
}

function receiptJson(receipt: ExecutionReceipt): JsonObject {
  return { receiptId: receipt.receiptId, status: receipt.status }
}

function publicReceipt(receipt: ExecutionReceipt): ExecutionReceipt {
  return {
    receiptId: receipt.receiptId,
    requestId: receipt.requestId,
    ownerId: receipt.ownerId,
    moduleId: receipt.moduleId,
    processId: receipt.processId,
    method: receipt.method,
    status: receipt.status,
  }
}

function approvalStatus(record: ApprovalRecord): ApprovalStatus {
  return { approvalId: record.approvalId, status: record.status, ...(record.reason ? { reason: record.reason } : {}) }
}

function processKey(moduleId: string, processId: string): string {
  return `${JSON.stringify(moduleId)}\u0000${JSON.stringify(processId)}`
}

function principalKey(ownerId: string, moduleId: string, processId: string): string {
  return `${JSON.stringify(ownerId)}\u0000${JSON.stringify(moduleId)}\u0000${JSON.stringify(processId)}`
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isCapabilityKind(value: unknown): value is CapabilityKind {
  return typeof value === 'string' && capabilityKinds.has(value)
}

async function raceTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    operation,
    new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs) }),
  ])
  if (timer !== undefined) clearTimeout(timer)
}
