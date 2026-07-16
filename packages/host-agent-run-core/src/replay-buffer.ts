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
  #available = true
  #lastSequence = 0

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
  get available(): boolean { return this.#available }
  get earliestSequence(): number | undefined { return this.#events[0]?.event.sequence }
  get latestSequence(): number | undefined { return this.#lastSequence === 0 ? undefined : this.#lastSequence }

  /** Dry-run the exact append constraints without consuming the sequence slot. */
  canAppend(input: HostAgentEvent): boolean {
    const event = parseHostAgentEvent(input)
    if (event.sequence !== this.#lastSequence + 1) return false
    return encoder.encode(JSON.stringify(event)).byteLength <= this.maxBytes
  }

  append(input: HostAgentEvent): HostAgentEvent {
    const event = parseHostAgentEvent(input)
    const expected = this.#lastSequence + 1
    if (event.sequence !== expected) throw new TypeError(`event sequence must be ${expected}`)
    const bytes = encoder.encode(JSON.stringify(event)).byteLength
    if (bytes > this.maxBytes) throw new TypeError('event exceeds the entire replay byte budget')
    this.#lastSequence = event.sequence
    // discard() invalidates historical continuity, not the live event stream.
    // Continue validating sequence numbers and let the owner notify listeners,
    // but do not retain a misleading partial suffix for future reconnects.
    if (!this.#available) return event
    this.#events.push({ event, bytes })
    this.#bytes += bytes
    while (this.#events.length > this.maxEvents || this.#bytes > this.maxBytes) {
      const removed = this.#events.shift()
      if (removed) this.#bytes -= removed.bytes
    }
    return event
  }

  /**
   * Release all retained event payloads while leaving the owning Run tombstone
   * intact. Once discarded, reconnect must fail explicitly instead of treating
   * an empty buffer as a continuous replay.
   */
  discard(): number {
    if (!this.#available) return 0
    const released = this.#bytes
    this.#events.length = 0
    this.#bytes = 0
    this.#available = false
    return released
  }

  replay(afterSequence?: number): HostAgentEvent[] {
    if (!this.#available) {
      throw new HostAgentRunCoreError('REPLAY_UNAVAILABLE', 'The requested event replay is no longer retained')
    }
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
