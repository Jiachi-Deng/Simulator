import type {
  VisibleCraftTurnStateChange,
  VisibleCraftTurnStateListener,
} from '../handlers/session-manager-interface'

export interface VisibleCraftTurnGateOptions {
  onListenerError?: (error: unknown, change: VisibleCraftTurnStateChange) => void
}

/**
 * Serializes the aggregate visible-Craft-turn lifecycle. Serializing begin/end
 * avoids a second Craft session slipping past while the first transition is
 * still waiting for Module Agent cancellation.
 */
export class VisibleCraftTurnGate {
  private readonly activeSessionIds = new Set<string>()
  private readonly listeners = new Set<VisibleCraftTurnStateListener>()
  private transitionTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: VisibleCraftTurnGateOptions = {}) {}

  subscribe(listener: VisibleCraftTurnStateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  begin(sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.activeSessionIds.has(sessionId)) return
      const wasInactive = this.activeSessionIds.size === 0
      this.activeSessionIds.add(sessionId)
      if (wasInactive) {
        await this.emit({
          active: true,
          sessionId,
          activeSessionCount: this.activeSessionIds.size,
        })
      }
    })
  }

  end(sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.activeSessionIds.delete(sessionId)) return
      if (this.activeSessionIds.size === 0) {
        await this.emit({ active: false, sessionId, activeSessionCount: 0 })
      }
    })
  }

  clear(): void {
    this.activeSessionIds.clear()
    this.listeners.clear()
  }

  snapshot(): Readonly<{ activeSessionCount: number }> {
    return Object.freeze({ activeSessionCount: this.activeSessionIds.size })
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.transitionTail.then(operation, operation)
    this.transitionTail = result.catch(() => undefined)
    return result
  }

  private async emit(change: VisibleCraftTurnStateChange): Promise<void> {
    await Promise.all([...this.listeners].map(async (listener) => {
      try {
        await listener(change)
      } catch (error) {
        this.options.onListenerError?.(error, change)
      }
    }))
  }
}
