import type {
  CreateHostModuleSessionInput,
  CreatedHostModuleSession,
  ModuleAgentPathAuthority,
  ModuleAgentPortEvent,
  ModuleAgentSessionPort,
  ModuleAgentTokenSource,
} from './types.ts'

export class DeterministicModuleAgentTokenSource implements ModuleAgentTokenSource {
  #next = 1
  createHex(bytes: number): string {
    const value = (this.#next++).toString(16).padStart(bytes * 2, '0')
    return value.slice(-bytes * 2)
  }
}

export class MemoryModuleAgentPathAuthority implements ModuleAgentPathAuthority {
  async canonicalize(path: string): Promise<string> {
    if (!path.startsWith('/')) throw new Error('Test paths must be absolute')
    const parts: string[] = []
    for (const part of path.split('/')) {
      if (!part || part === '.') continue
      if (part === '..') parts.pop()
      else parts.push(part)
    }
    return `/${parts.join('/')}`
  }

  isEqualOrWithin(candidate: string, root: string): boolean {
    return candidate === root || candidate.startsWith(`${root}/`)
  }
}

export class FakeModuleAgentSessionPort implements ModuleAgentSessionPort {
  readonly created: CreateHostModuleSessionInput[] = []
  readonly sent: Array<{ sessionId: string; prompt: string }> = []
  readonly cancelled: string[] = []
  readonly deleted: string[] = []
  readonly #listeners = new Map<string, Set<(event: ModuleAgentPortEvent) => void>>()
  #nextSession = 1
  failSend = false
  failDelete = false

  async createSession(input: CreateHostModuleSessionInput): Promise<CreatedHostModuleSession> {
    this.created.push(input)
    const sessionId = `raw-${this.#nextSession++}`
    return {
      sessionId,
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      workingDirectory: input.workingDirectory,
      hidden: true,
    }
  }

  async sendTurn(sessionId: string, prompt: string): Promise<void> {
    if (this.failSend) throw new Error('sensitive provider failure')
    this.sent.push({ sessionId, prompt })
  }

  async cancelTurn(sessionId: string): Promise<void> {
    this.cancelled.push(sessionId)
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (this.failDelete) throw new Error('delete failed')
    this.deleted.push(sessionId)
    this.#listeners.delete(sessionId)
  }

  subscribe(sessionId: string, listener: (event: ModuleAgentPortEvent) => void): () => void {
    const listeners = this.#listeners.get(sessionId) ?? new Set()
    listeners.add(listener)
    this.#listeners.set(sessionId, listeners)
    return () => listeners.delete(listener)
  }

  emit(event: ModuleAgentPortEvent): void {
    for (const listener of this.#listeners.get(event.sessionId) ?? []) listener(event)
  }
}
