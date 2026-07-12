import { ContractValidationError, stableJson } from './json.ts'
import { parseRawRequest, parseRequestEnvelope } from './schema.ts'
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
  response: ResponseEnvelope
  receiptId?: string
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

interface PolicyDenial {
  code: BridgeErrorCode
  message: string
}

interface ExecutionReceiptRecord extends ExecutionReceipt {
  tokenHash: string
  generation: number
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
  readonly #generations = new Map<string, number>()
  readonly #replays = new Map<string, ReplayRecord>()
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
      if (input.descriptor.kind === 'host-agent.opaque') {
        throw new BridgePolicyError('UNSUPPORTED_CAPABILITY', 'Host-agent opaque capabilities are unsupported by this bridge version')
      }
      if (!input.moduleId || !input.processId || !input.nonce) {
        throw new ContractValidationError('Capability identity and nonce must be non-empty')
      }
      if (!Number.isFinite(input.expiresAt) || input.expiresAt <= this.#deps.clock.now()) {
        throw new ContractValidationError('Capability expiry must be in the future')
      }
      if (!Number.isSafeInteger(input.maxUses) || input.maxUses < 1) {
        throw new ContractValidationError('Capability maxUses must be a positive integer')
      }
      if (input.allowedMethods.length !== 1 || input.allowedMethods[0] !== input.descriptor.kind) {
        throw new ContractValidationError('Allowed methods must exactly match the capability descriptor kind')
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
        kind: input.descriptor.kind,
        moduleId: input.moduleId,
        processId: input.processId,
        generation,
        workspaceRoot,
        allowedMethods: new Set(input.allowedMethods),
        expiresAt: input.expiresAt,
        maxUses: input.maxUses,
        uses: 0,
        nonce: input.nonce,
        revoked: false,
      })
      this.#audit('capability.issued', {
        moduleId: input.moduleId,
        processId: input.processId,
        kind: input.descriptor.kind,
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
      const count = this.#revoke(record => record.moduleId === moduleId, 'module')
      this.#cancelApprovals(record => record.moduleId === moduleId, 'module revoked')
      return count
    })
  }

  revokeProcess(moduleId: string, processId: string): Promise<number> {
    return this.#exclusive(async () => {
      this.#advanceGeneration(moduleId, processId)
      const count = this.#revoke(record => record.moduleId === moduleId && record.processId === processId, 'process')
      this.#cancelApprovals(record => record.moduleId === moduleId && record.processId === processId, 'process revoked')
      return count
    })
  }

  revokeAll(): Promise<number> {
    return this.#exclusive(async () => {
      for (const key of this.#generations.keys()) this.#generations.set(key, this.#generations.get(key)! + 1)
      const count = this.#revoke(() => true, 'all')
      this.#cancelApprovals(() => true, 'all capabilities revoked')
      return count
    })
  }

  restartProcess(moduleId: string, processId: string): Promise<void> {
    return this.#exclusive(async () => {
      this.#advanceGeneration(moduleId, processId)
      this.#revoke(record => record.moduleId === moduleId && record.processId === processId, 'crash')
      this.#cancelApprovals(record => record.moduleId === moduleId && record.processId === processId, 'process restarted')
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
      replayEntries: this.#replays.size,
      pendingApprovals,
      auditEvents: structuredClone(this.#auditEvents),
    }
  }

  #handleParsed(parsed: RequestEnvelope, context: TrustedTransportContext): Promise<ResponseEnvelope> {
    const request = { ...parsed, moduleId: context.moduleId, processId: context.processId }
    return this.#exclusive(async () => {
      const identityHash = this.#deps.hasher.hash(stableJson(request as unknown as JsonValue))
      const replay = this.#replays.get(request.requestId)
      if (replay) {
        if (replay.identityHash !== identityHash) {
          this.#audit('capability.denied', scopedAudit(request, { code: 'REPLAY_MISMATCH' }))
          return errorResponse(request.requestId, 'REPLAY_MISMATCH', 'Request id was already used with a different identity')
        }
        const record = this.#capabilities.get(replay.tokenHash)
        const denial = this.#validateCapability(record, request, true, replay.generation)
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

      if (this.#replays.size >= this.#limits.maxReplayEntries) {
        return this.#deny(request, { code: 'REPLAY_CAPACITY', message: 'Replay store capacity was reached' })
      }

      const { response, tokenHash, generation, receiptId } = await this.#authorize(request, context)
      if (response.ok && tokenHash !== undefined && generation !== undefined) {
        this.#rememberReplay(request.requestId, { identityHash, tokenHash, generation, response, ...(receiptId ? { receiptId } : {}) })
      }
      return structuredClone(response)
    })
  }

  async #authorize(
    request: RequestEnvelope,
    context: TrustedTransportContext,
  ): Promise<{ response: ResponseEnvelope; tokenHash?: string; generation?: number; receiptId?: string }> {
    const tokenHash = this.#deps.hasher.hash(request.capabilityToken)
    const record = this.#capabilities.get(tokenHash)
    const denial = this.#validateCapability(record, request, false)
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
    if (request.method === 'approval.request') {
      result = this.#beginApproval(request)
    } else {
      const receipt = this.#createReceipt(request, record)
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
    }
  }

  #validateCapability(
    record: CapabilityRecord | undefined,
    request: RequestEnvelope,
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
    if (record.moduleId !== request.moduleId || record.processId !== request.processId
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

  #createReceipt(request: RequestEnvelope, capability: CapabilityRecord): ExecutionReceiptRecord {
    const receipt: ExecutionReceiptRecord = {
      receiptId: `receipt-${++this.#receiptSequence}`,
      requestId: request.requestId,
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
    if (receipt.moduleId !== context.moduleId || receipt.processId !== context.processId) {
      throw new BridgePolicyError('EXECUTION_RECEIPT_NOT_FOUND', 'Execution receipt was not found')
    }
    return receipt
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
    this.#audit('approval.pending', approvalAudit(record))
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
    return this.#exclusive(() => {
      const record = this.#approvals.get(approvalId)
      if (!record || record.status !== 'pending') return
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
        record.status = 'cancelled'
        record.reason = reason
        record.prompt = ''
        count += 1
        this.#audit('approval.cancelled', approvalAudit(record))
      }
    }
    return count
  }

  #rememberReplay(requestId: string, replay: ReplayRecord): void {
    this.#replays.set(requestId, { ...replay, response: structuredClone(replay.response) })
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
    if (!context.ownerId || !context.moduleId || !context.processId) {
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
    const prefix = `${moduleId}\u0000`
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
  return `${moduleId}\u0000${processId}`
}

async function raceTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    operation,
    new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs) }),
  ])
  if (timer !== undefined) clearTimeout(timer)
}
