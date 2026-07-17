export const OPEN_DESIGN_ACCEPTANCE_CHANNELS = Object.freeze({
  IS_AVAILABLE: 'open-design-acceptance:is-available',
  GET_STATE: 'open-design-acceptance:get-state',
  UPDATE_TO_RC: 'open-design-acceptance:update-to-rc',
  ROLLBACK: 'open-design-acceptance:rollback',
  GET_BLACKOUT_PROXY_CAPABILITY: 'open-design-acceptance:get-blackout-proxy-capability',
  ARM_NEXT_BLACKOUT: 'open-design-acceptance:arm-next-blackout',
  TAKE_BLACKOUT_EVIDENCE: 'open-design-acceptance:take-blackout-evidence',
  GET_MODULE_AGENT_RUNTIME_SNAPSHOT: 'open-design-acceptance:get-module-agent-runtime-snapshot',
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

/** No method accepts renderer-controlled release, URL, token, path, run handle, hash, module, or operation identifiers. */
export interface OpenDesignAcceptanceFacade {
  getState(): Promise<OpenDesignAcceptanceState>
  updateToRc(): Promise<OpenDesignAcceptanceState>
  rollback(): Promise<OpenDesignAcceptanceState>
  getBlackoutProxyCapability(): Promise<OpenDesignBlackoutCapability>
  armNextBlackout(request: OpenDesignBlackoutArmRequest): Promise<OpenDesignBlackoutArmResult>
  takeBlackoutEvidence(request: OpenDesignBlackoutEvidenceRequest): Promise<OpenDesignBlackoutEvidence>
  getModuleAgentRuntimeSnapshot(): Promise<OpenDesignModuleAgentRuntimeSnapshot>
}
