export const OPEN_DESIGN_ACCEPTANCE_CHANNELS = Object.freeze({
  IS_AVAILABLE: 'open-design-acceptance:is-available',
  GET_STATE: 'open-design-acceptance:get-state',
  UPDATE_TO_RC: 'open-design-acceptance:update-to-rc',
  ROLLBACK: 'open-design-acceptance:rollback',
  GET_BLACKOUT_PROXY_CAPABILITY: 'open-design-acceptance:get-blackout-proxy-capability',
  ARM_NEXT_BLACKOUT: 'open-design-acceptance:arm-next-blackout',
  TAKE_BLACKOUT_EVIDENCE: 'open-design-acceptance:take-blackout-evidence',
  GET_MODULE_AGENT_RUNTIME_SNAPSHOT: 'open-design-acceptance:get-module-agent-runtime-snapshot',
  GET_RUNTIME_BINDING: 'open-design-acceptance:get-runtime-binding',
  GET_CONNECTION_AUTHORITY: 'open-design-acceptance:get-connection-authority',
  ARM_CONNECTION_ADMISSION: 'open-design-acceptance:arm-connection-admission',
})

export const OPEN_DESIGN_BLACKOUT_CASE_IDS = Object.freeze([
  'D01', 'D02', 'D03', 'D04',
  'L01', 'L02', 'L03', 'L04',
  'E01', 'E02', 'E03', 'E04',
  'S01', 'S02', 'S03', 'S04',
  'F01', 'F02', 'F03', 'F04',
] as const)
const BLACKOUT_CASE_IDS = new Set<string>(OPEN_DESIGN_BLACKOUT_CASE_IDS)
const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SAFE_TYPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA256 = /^[0-9a-f]{64}$/
const BLACKOUT_PRODUCER = 'external-host-agent-sse-proxy' as const

type JsonRecord = Record<string, unknown>

function exactRecord(value: unknown, fields: readonly string[], name: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${name} is invalid`)
  const actual = Object.keys(value as JsonRecord).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new TypeError(`${name} is invalid`)
  }
  return value as JsonRecord
}

function ordinal(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 20) {
    throw new TypeError(`${name} is invalid`)
  }
  return value
}

function timestamp(value: unknown, name: string): number {
  if (typeof value !== 'string') throw new TypeError(`${name} is invalid`)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new TypeError(`${name} is invalid`)
  return parsed
}

function evidenceIdentity(record: JsonRecord): { evidenceId: string; caseId: string; turnOrdinal: number } {
  if (typeof record.evidenceId !== 'string' || !EVIDENCE_ID.test(record.evidenceId)
    || typeof record.caseId !== 'string' || !BLACKOUT_CASE_IDS.has(record.caseId)) {
    throw new TypeError('Blackout evidence identity is invalid')
  }
  return {
    evidenceId: record.evidenceId,
    caseId: record.caseId,
    turnOrdinal: ordinal(record.turnOrdinal, 'Blackout turn ordinal'),
  }
}

export interface OpenDesignBlackoutCapability {
  readonly schemaVersion: 1
  readonly available: true
  readonly producer: typeof BLACKOUT_PRODUCER
  readonly blackoutMs: 65_000
  readonly heartbeatMs: 10_000
}

export interface OpenDesignBlackoutArmRequest {
  readonly caseId: string
  readonly stack: 'new'
  readonly turnOrdinal: number
}

export interface OpenDesignBlackoutArmResult {
  readonly schemaVersion: 1
  readonly armed: true
  readonly producer: typeof BLACKOUT_PRODUCER
  readonly evidenceId: string
  readonly caseId: string
  readonly turnOrdinal: number
  readonly blackoutMs: 65_000
  readonly heartbeatMs: 10_000
}

export interface OpenDesignBlackoutEvidenceRequest {
  readonly evidenceId: string
  readonly caseId: string
  readonly turnOrdinal: number
}

export interface OpenDesignBlackoutDeliveredFrame {
  readonly sequence: number
  readonly at: string
  readonly type: string
  readonly source: 'daemon' | 'host-health' | 'harness'
  readonly business: boolean
  readonly payloadSha256: string
}

export interface OpenDesignBlackoutEvidence {
  readonly schemaVersion: 1
  readonly producer: typeof BLACKOUT_PRODUCER
  readonly evidenceId: string
  readonly caseId: string
  readonly turnOrdinal: number
  readonly startedAt: string
  readonly endedAt: string
  readonly eventSequenceBefore: number
  readonly eventSequenceAfter: number
  readonly bufferedEventCount: number
  readonly replayedEventCount: number
  readonly replaySequenceStart: number
  readonly eventsLost: 0
  readonly heartbeatCount: number
  readonly heartbeatMaxGapMs: number
  readonly replayComplete: true
  readonly terminalEventCount: 1
  readonly deliveredFrames: readonly OpenDesignBlackoutDeliveredFrame[]
}

export interface OpenDesignModuleAgentLaneSnapshot {
  readonly activeRuns: number
  readonly moduleSessions: number
}

export interface OpenDesignModuleAgentSessionResidueSnapshot {
  readonly hiddenSessions: number
  readonly transientSessions: number
  readonly quarantinedSessions: number
}

export interface OpenDesignModuleAgentRuntimeSnapshot {
  readonly schemaVersion: 1
  readonly v1: OpenDesignModuleAgentLaneSnapshot
  readonly v2: OpenDesignModuleAgentLaneSnapshot
  readonly sessions: OpenDesignModuleAgentSessionResidueSnapshot
}

/**
 * Values already known to the H1 verifier. The packaged App compares these
 * values with its own process-local authority and never returns either path.
 */
export interface OpenDesignAcceptanceRuntimeBindingRequest {
  readonly profileRealpath: string
  readonly configRealpath: string
  readonly mainPid: number
  readonly serverPid: number
  readonly serverLockStartedAt: number
}

/** Deliberately path-free, credential-free, read-only H1 runtime authority. */
export interface OpenDesignAcceptanceRuntimeBinding {
  readonly schemaVersion: 1
  readonly configRootMatches: boolean
  readonly userDataRootMatches: boolean
  readonly mainPidMatches: boolean
  readonly serverIdentityMatches: boolean
  readonly runtimeInstanceDigest: string
}

/** One-time 32-byte H1/A1 authority key. It is accepted but never returned. */
export interface OpenDesignAcceptanceConnectionAuthorityRequest {
  readonly keyBase64: string
}

/** Credential- and identity-free proof for the currently effective Connection. */
export interface OpenDesignAcceptanceConnectionAuthorityResult {
  readonly schemaVersion: 1
  readonly authenticated: true
  readonly authorityHmacSha256: string
}

export interface OpenDesignAcceptanceConnectionArmRequest {
  readonly keyBase64: string
  readonly expectedHmacSha256: string
}

export interface OpenDesignAcceptanceConnectionArmResult {
  readonly schemaVersion: 1
  readonly armed: true
  readonly authorityHmacSha256: string
}

function absolutePath(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length < 2 || value.length > 4096
    || !value.startsWith('/') || value.includes('\0') || value.endsWith('/')) {
    throw new TypeError(`${name} is invalid`)
  }
  return value
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} is invalid`)
  }
  return value
}

export function parseOpenDesignAcceptanceRuntimeBindingRequest(
  value: unknown,
): OpenDesignAcceptanceRuntimeBindingRequest {
  const record = exactRecord(value, [
    'configRealpath', 'mainPid', 'profileRealpath', 'serverLockStartedAt', 'serverPid',
  ], 'Acceptance runtime binding request')
  return Object.freeze({
    profileRealpath: absolutePath(record.profileRealpath, 'Acceptance profile path'),
    configRealpath: absolutePath(record.configRealpath, 'Acceptance config path'),
    mainPid: positiveSafeInteger(record.mainPid, 'Acceptance main PID'),
    serverPid: positiveSafeInteger(record.serverPid, 'Acceptance server PID'),
    serverLockStartedAt: positiveSafeInteger(record.serverLockStartedAt, 'Acceptance server start'),
  })
}

export function parseOpenDesignAcceptanceRuntimeBinding(
  value: unknown,
): OpenDesignAcceptanceRuntimeBinding {
  const record = exactRecord(value, [
    'configRootMatches', 'mainPidMatches', 'runtimeInstanceDigest', 'schemaVersion',
    'serverIdentityMatches', 'userDataRootMatches',
  ], 'Acceptance runtime binding')
  if (record.schemaVersion !== 1
    || typeof record.configRootMatches !== 'boolean'
    || typeof record.userDataRootMatches !== 'boolean'
    || typeof record.mainPidMatches !== 'boolean'
    || typeof record.serverIdentityMatches !== 'boolean'
    || typeof record.runtimeInstanceDigest !== 'string'
    || !SHA256.test(record.runtimeInstanceDigest)) {
    throw new TypeError('Acceptance runtime binding is invalid')
  }
  return Object.freeze(record) as unknown as OpenDesignAcceptanceRuntimeBinding
}

function authorityKeyBase64(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new TypeError('Acceptance Connection authority key is invalid')
  }
  return value
}

export function parseOpenDesignAcceptanceConnectionAuthorityRequest(
  value: unknown,
): OpenDesignAcceptanceConnectionAuthorityRequest {
  const record = exactRecord(value, ['keyBase64'], 'Acceptance Connection authority request')
  return Object.freeze({ keyBase64: authorityKeyBase64(record.keyBase64) })
}

export function parseOpenDesignAcceptanceConnectionAuthorityResult(
  value: unknown,
): OpenDesignAcceptanceConnectionAuthorityResult {
  const record = exactRecord(
    value,
    ['authenticated', 'authorityHmacSha256', 'schemaVersion'],
    'Acceptance Connection authority result',
  )
  if (record.schemaVersion !== 1 || record.authenticated !== true
    || typeof record.authorityHmacSha256 !== 'string' || !SHA256.test(record.authorityHmacSha256)) {
    throw new TypeError('Acceptance Connection authority result is invalid')
  }
  return Object.freeze(record) as unknown as OpenDesignAcceptanceConnectionAuthorityResult
}

export function parseOpenDesignAcceptanceConnectionArmRequest(
  value: unknown,
): OpenDesignAcceptanceConnectionArmRequest {
  const record = exactRecord(
    value,
    ['expectedHmacSha256', 'keyBase64'],
    'Acceptance Connection arm request',
  )
  if (typeof record.expectedHmacSha256 !== 'string' || !SHA256.test(record.expectedHmacSha256)) {
    throw new TypeError('Acceptance Connection arm request is invalid')
  }
  return Object.freeze({
    keyBase64: authorityKeyBase64(record.keyBase64),
    expectedHmacSha256: record.expectedHmacSha256,
  })
}

export function parseOpenDesignAcceptanceConnectionArmResult(
  value: unknown,
): OpenDesignAcceptanceConnectionArmResult {
  const record = exactRecord(
    value,
    ['armed', 'authorityHmacSha256', 'schemaVersion'],
    'Acceptance Connection arm result',
  )
  if (record.schemaVersion !== 1 || record.armed !== true
    || typeof record.authorityHmacSha256 !== 'string' || !SHA256.test(record.authorityHmacSha256)) {
    throw new TypeError('Acceptance Connection arm result is invalid')
  }
  return Object.freeze(record) as unknown as OpenDesignAcceptanceConnectionArmResult
}

export function parseOpenDesignModuleAgentRuntimeSnapshot(
  value: unknown,
): OpenDesignModuleAgentRuntimeSnapshot {
  const record = exactRecord(value, ['schemaVersion', 'sessions', 'v1', 'v2'], 'Module Agent runtime snapshot')
  if (record.schemaVersion !== 1) throw new TypeError('Module Agent runtime snapshot is invalid')
  const parseLane = (raw: unknown): OpenDesignModuleAgentLaneSnapshot => {
    const lane = exactRecord(raw, ['activeRuns', 'moduleSessions'], 'Module Agent lane snapshot')
    if (typeof lane.activeRuns !== 'number' || !Number.isSafeInteger(lane.activeRuns) || lane.activeRuns < 0
      || typeof lane.moduleSessions !== 'number' || !Number.isSafeInteger(lane.moduleSessions) || lane.moduleSessions < 0) {
      throw new TypeError('Module Agent lane snapshot is invalid')
    }
    return Object.freeze({ activeRuns: lane.activeRuns, moduleSessions: lane.moduleSessions })
  }
  const sessions = exactRecord(
    record.sessions,
    ['hiddenSessions', 'quarantinedSessions', 'transientSessions'],
    'Module Agent Session residue snapshot',
  )
  for (const field of ['hiddenSessions', 'quarantinedSessions', 'transientSessions'] as const) {
    if (typeof sessions[field] !== 'number' || !Number.isSafeInteger(sessions[field]) || sessions[field] < 0) {
      throw new TypeError('Module Agent Session residue snapshot is invalid')
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    v1: parseLane(record.v1),
    v2: parseLane(record.v2),
    sessions: Object.freeze({
      hiddenSessions: sessions.hiddenSessions as number,
      transientSessions: sessions.transientSessions as number,
      quarantinedSessions: sessions.quarantinedSessions as number,
    }),
  })
}

export function parseOpenDesignBlackoutArmRequest(value: unknown): OpenDesignBlackoutArmRequest {
  const record = exactRecord(value, ['caseId', 'stack', 'turnOrdinal'], 'Blackout arm request')
  if (typeof record.caseId !== 'string' || !BLACKOUT_CASE_IDS.has(record.caseId) || record.stack !== 'new') {
    throw new TypeError('Blackout arm request is invalid')
  }
  return Object.freeze({ caseId: record.caseId, stack: 'new', turnOrdinal: ordinal(record.turnOrdinal, 'Blackout turn ordinal') })
}

export function parseOpenDesignBlackoutEvidenceRequest(value: unknown): OpenDesignBlackoutEvidenceRequest {
  const record = exactRecord(value, ['caseId', 'evidenceId', 'turnOrdinal'], 'Blackout evidence request')
  return Object.freeze(evidenceIdentity(record))
}

export function parseOpenDesignBlackoutCapability(value: unknown): OpenDesignBlackoutCapability {
  const record = exactRecord(value,
    ['available', 'blackoutMs', 'heartbeatMs', 'producer', 'schemaVersion'],
    'Blackout capability')
  if (record.schemaVersion !== 1 || record.available !== true || record.producer !== BLACKOUT_PRODUCER
    || record.blackoutMs !== 65_000 || record.heartbeatMs !== 10_000) {
    throw new TypeError('Blackout capability is invalid')
  }
  return Object.freeze(record) as unknown as OpenDesignBlackoutCapability
}

export function parseOpenDesignBlackoutArmResult(value: unknown): OpenDesignBlackoutArmResult {
  const record = exactRecord(value, [
    'armed', 'blackoutMs', 'caseId', 'evidenceId', 'heartbeatMs', 'producer', 'schemaVersion', 'turnOrdinal',
  ], 'Blackout arm result')
  const identity = evidenceIdentity(record)
  if (record.schemaVersion !== 1 || record.armed !== true || record.producer !== BLACKOUT_PRODUCER
    || record.blackoutMs !== 65_000 || record.heartbeatMs !== 10_000) {
    throw new TypeError('Blackout arm result is invalid')
  }
  return Object.freeze({ ...record, ...identity }) as unknown as OpenDesignBlackoutArmResult
}

export function parseOpenDesignBlackoutEvidence(value: unknown): OpenDesignBlackoutEvidence {
  const record = exactRecord(value, [
    'bufferedEventCount', 'caseId', 'deliveredFrames', 'endedAt', 'eventSequenceAfter', 'eventSequenceBefore',
    'eventsLost', 'evidenceId', 'heartbeatCount', 'heartbeatMaxGapMs', 'producer', 'replayedEventCount',
    'replayComplete', 'replaySequenceStart', 'schemaVersion', 'startedAt', 'terminalEventCount', 'turnOrdinal',
  ], 'Blackout evidence')
  const identity = evidenceIdentity(record)
  const startedAt = timestamp(record.startedAt, 'Blackout start')
  const endedAt = timestamp(record.endedAt, 'Blackout end')
  if (endedAt - startedAt < 65_000 || record.schemaVersion !== 1 || record.producer !== BLACKOUT_PRODUCER
    || record.eventsLost !== 0 || record.replayComplete !== true || record.terminalEventCount !== 1
    || !Number.isSafeInteger(record.eventSequenceBefore) || !Number.isSafeInteger(record.eventSequenceAfter)
    || !Number.isSafeInteger(record.bufferedEventCount) || (record.bufferedEventCount as number) < 1
    || !Number.isSafeInteger(record.replayedEventCount) || record.replayedEventCount !== record.bufferedEventCount
    || !Number.isSafeInteger(record.replaySequenceStart)
    || !Number.isSafeInteger(record.heartbeatCount) || !Number.isSafeInteger(record.heartbeatMaxGapMs)
    || !Array.isArray(record.deliveredFrames) || record.deliveredFrames.length < 9
    || record.deliveredFrames.length > 1_040) {
    throw new TypeError('Blackout evidence is invalid')
  }
  const frames = record.deliveredFrames.map((value, index): OpenDesignBlackoutDeliveredFrame => {
    const frame = exactRecord(value, ['at', 'business', 'payloadSha256', 'sequence', 'source', 'type'], 'Blackout frame')
    if (frame.sequence !== index + 1 || typeof frame.type !== 'string' || !SAFE_TYPE.test(frame.type)
      || !['daemon', 'host-health', 'harness'].includes(String(frame.source))
      || typeof frame.business !== 'boolean' || typeof frame.payloadSha256 !== 'string' || !SHA256.test(frame.payloadSha256)) {
      throw new TypeError('Blackout frame is invalid')
    }
    timestamp(frame.at, 'Blackout frame timestamp')
    return Object.freeze(frame) as unknown as OpenDesignBlackoutDeliveredFrame
  })
  for (let index = 1; index < frames.length; index += 1) {
    if (Date.parse(frames[index]!.at) <= Date.parse(frames[index - 1]!.at)) {
      throw new TypeError('Blackout frame timestamps are not monotonic')
    }
  }
  const before = record.eventSequenceBefore as number
  const after = record.eventSequenceAfter as number
  const replaySequenceStart = record.replaySequenceStart as number
  const replayedEventCount = record.replayedEventCount as number
  if (before < 1 || after <= before || after > frames.length
    || replaySequenceStart !== after + 1
    || replaySequenceStart + replayedEventCount - 1 > frames.length
    || frames[before - 1]?.type !== 'blackout.started'
    || frames[after - 1]?.type !== 'blackout.ended'
    || Date.parse(frames[before - 1]!.at) !== startedAt
    || Date.parse(frames[after - 1]!.at) !== endedAt) {
    throw new TypeError('Blackout evidence boundary is invalid')
  }
  const interval = frames.filter((frame) => {
    const at = Date.parse(frame.at)
    return at >= startedAt && at <= endedAt
  })
  const heartbeats = interval.filter((frame) => frame.source === 'host-health' && frame.type === 'heartbeat')
  const replayedFrames = frames.slice(replaySequenceStart - 1, replaySequenceStart - 1 + replayedEventCount)
  if (interval.some((frame) => frame.business)
    || heartbeats.length !== record.heartbeatCount || heartbeats.length < 6
    || replayedFrames.length !== replayedEventCount
    || replayedFrames.some((frame) => frame.source !== 'daemon' || frame.business !== true
      || Date.parse(frame.at) <= endedAt)
    || frames.filter((frame) => frame.type === 'turn.completed').length !== 1
    || frames.some((frame) => frame.type === 'turn.failed' || frame.type === 'turn.interrupted')
    || frames.filter((frame) => frame.type === 'run.closed').length !== 1) {
    throw new TypeError('Blackout evidence outcome is invalid')
  }
  const heartbeatGaps = heartbeats.slice(1).map((frame, index) => (
    Date.parse(frame.at) - Date.parse(heartbeats[index]!.at)
  ))
  const maxGap = heartbeatGaps.length > 0 ? Math.max(...heartbeatGaps) : 0
  if (record.heartbeatMaxGapMs !== maxGap || maxGap > 12_000) {
    throw new TypeError('Blackout heartbeat evidence is invalid')
  }
  return Object.freeze({ ...record, ...identity, deliveredFrames: Object.freeze(frames) }) as unknown as OpenDesignBlackoutEvidence
}

export type OpenDesignAcceptanceStatus = 'ready' | 'busy' | 'error'
export type OpenDesignAcceptanceAction = 'updateToRc' | 'rollback'

export interface OpenDesignAcceptanceOperationEvidence {
  readonly operationId: string
  readonly kind: 'update' | 'rollback'
  readonly ok: boolean
}

/** Deliberately narrow, non-secret evidence returned only by the gated acceptance surface. */
export interface OpenDesignAcceptanceState {
  readonly status: OpenDesignAcceptanceStatus
  readonly hostVersion: '0.12.0'
  readonly activeVersion: string | null
  readonly lastKnownGoodVersion: string | null
  readonly installedVersions: readonly string[]
  /** True only when the active Module daemon is healthy and version-aligned. */
  readonly running: boolean
  /** True only when the active Module view is attached and version-aligned. */
  readonly viewAttached: boolean
  readonly action?: OpenDesignAcceptanceAction
  readonly operation?: OpenDesignAcceptanceOperationEvidence
  readonly errorCode?: string
}

/** No method accepts renderer-controlled release, URL, token, run handle, hash, module, or operation identifiers. */
export interface OpenDesignAcceptanceFacade {
  getState(): Promise<OpenDesignAcceptanceState>
  updateToRc(): Promise<OpenDesignAcceptanceState>
  rollback(): Promise<OpenDesignAcceptanceState>
  getBlackoutProxyCapability(): Promise<OpenDesignBlackoutCapability>
  armNextBlackout(request: OpenDesignBlackoutArmRequest): Promise<OpenDesignBlackoutArmResult>
  takeBlackoutEvidence(request: OpenDesignBlackoutEvidenceRequest): Promise<OpenDesignBlackoutEvidence>
  getModuleAgentRuntimeSnapshot(): Promise<OpenDesignModuleAgentRuntimeSnapshot>
  /** Compares already-known canonical H1 values; it cannot read or mutate path contents. */
  getRuntimeBinding(request: OpenDesignAcceptanceRuntimeBindingRequest): Promise<OpenDesignAcceptanceRuntimeBinding>
  /** Returns only a keyed digest; raw Connection and credential identity stay in Host memory. */
  getConnectionAuthority(
    request: OpenDesignAcceptanceConnectionAuthorityRequest,
  ): Promise<OpenDesignAcceptanceConnectionAuthorityResult>
  /** Arms one exact H1-approved authority for this process lifetime. */
  armConnectionAdmission(
    request: OpenDesignAcceptanceConnectionArmRequest,
  ): Promise<OpenDesignAcceptanceConnectionArmResult>
}
