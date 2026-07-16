import {
  HOST_AGENT_LIMITS,
  parseHostAgentEvent,
  type HostAgentEvent,
} from '@simulator/host-agent-contract'
import { HostAgentRunCoreError } from './types.ts'

const encoder = new TextEncoder()

interface RetainedEvent {
  event: HostAgentEvent
  bytes: number
}

/** Bounded continuous suffix. Eviction is explicit and stale cursors fail closed. */
export class HostAgentReplayBuffer {
  readonly #events: RetainedEvent[] = []
  #bytes = 0

  constructor(
    readonly maxEvents = HOST_AGENT_LIMITS.maxReplayEvents,
    readonly maxBytes = HOST_AGENT_LIMITS.maxReplayBytes,
  ) {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > HOST_AGENT_LIMITS.maxReplayEvents) {
      throw new TypeError('maxEvents exceeds the Host Agent contract ceiling')
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > HOST_AGENT_LIMITS.maxReplayBytes) {
      throw new TypeError('maxBytes exceeds the Host Agent contract ceiling')
    }
  }

  get size(): number { return this.#events.length }
  get byteLength(): number { return this.#bytes }
  get earliestSequence(): number | undefined { return this.#events[0]?.event.sequence }
  get latestSequence(): number | undefined { return this.#events.at(-1)?.event.sequence }

  append(input: HostAgentEvent): HostAgentEvent {
    const event = parseHostAgentEvent(input)
    const expected = (this.latestSequence ?? 0) + 1
    if (event.sequence !== expected) throw new TypeError(`event sequence must be ${expected}`)
    const bytes = encoder.encode(JSON.stringify(event)).byteLength
    if (bytes > this.maxBytes) throw new TypeError('event exceeds the entire replay byte budget')
    this.#events.push({ event, bytes })
    this.#bytes += bytes
    while (this.#events.length > this.maxEvents || this.#bytes > this.maxBytes) {
      const removed = this.#events.shift()
      if (removed) this.#bytes -= removed.bytes
    }
    return event
  }

  replay(afterSequence?: number): HostAgentEvent[] {
    const latest = this.latestSequence ?? 0
    if (afterSequence === undefined) return this.#events.map(({ event }) => event)
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence > latest) {
      throw new HostAgentRunCoreError('INVALID_REQUEST', 'Last-Event-ID is outside the retained run range')
    }
    const earliest = this.earliestSequence
    if (earliest !== undefined && afterSequence < earliest - 1) {
      throw new HostAgentRunCoreError('REPLAY_UNAVAILABLE', 'The requested event replay is no longer retained')
    }
    return this.#events.filter(({ event }) => event.sequence > afterSequence).map(({ event }) => event)
  }
}
