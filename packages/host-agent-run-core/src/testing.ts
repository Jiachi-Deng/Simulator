import type {
  CreateHostAgentSessionInput,
  CreatedHostAgentSession,
  HostAgentRunSessionPort,
  HostAgentSessionEvent,
} from './types.ts'

type HostAgentSessionEventInput = HostAgentSessionEvent extends infer Event
  ? Event extends HostAgentSessionEvent
    ? Omit<Event, 'sessionId'>
    : never
  : never

export class DeterministicHostAgentRunIdSource {
  #next = 1

  createHex(bytes: number): string {
    return (this.#next++).toString(16).padStart(bytes * 2, '0')
  }
}

export class InMemoryHostAgentRunSessionPort implements HostAgentRunSessionPort {
  readonly created: CreateHostAgentSessionInput[] = []
  readonly states: Array<{ sessionId: string; state: string }> = []
  readonly prompts: Array<{ sessionId: string; prompt: string }> = []
  readonly cancelled: string[] = []
  readonly reaped: string[] = []
  readonly listeners = new Map<string, Set<(event: HostAgentSessionEvent) => void>>()
  createError?: Error
  updateError?: Error
  sendError?: Error
  reapError?: Error

  async createSession(input: CreateHostAgentSessionInput): Promise<CreatedHostAgentSession> {
    if (this.createError) throw this.createError
    this.created.push(structuredClone(input))
    return {
      sessionId: `session-${this.created.length}`,
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      workingDirectory: input.workingDirectory,
      hidden: true,
    }
  }

  async updateRunState(sessionId: string, state: Parameters<HostAgentRunSessionPort['updateRunState']>[1]): Promise<void> {
    if (this.updateError) throw this.updateError
    this.states.push({ sessionId, state })
  }

  async sendTurn(sessionId: string, prompt: string): Promise<void> {
    if (this.sendError) throw this.sendError
    this.prompts.push({ sessionId, prompt })
  }

  async cancelTurn(sessionId: string): Promise<void> { this.cancelled.push(sessionId) }
  async awaitStopped(): Promise<void> {}

  async disposeAndReap(sessionId: string): Promise<void> {
    if (this.reapError) throw this.reapError
    this.reaped.push(sessionId)
  }

  subscribe(sessionId: string, listener: (event: HostAgentSessionEvent) => void): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set()
    listeners.add(listener)
    this.listeners.set(sessionId, listeners)
    return () => listeners.delete(listener)
  }

  emit(sessionId: string, event: HostAgentSessionEventInput): void {
    for (const listener of this.listeners.get(sessionId) ?? []) {
      listener({ ...event, sessionId } as HostAgentSessionEvent)
    }
  }
}
