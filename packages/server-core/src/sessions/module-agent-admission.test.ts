import { afterEach, describe, expect, it } from 'bun:test'
import {
  createSession as createStoredSession,
  type ModuleAgentRunMetadata,
} from '@craft-agent/shared/sessions'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, createManagedSession } from './SessionManager.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createTransientManager(contractVersion: 1 | 2 = 2): Promise<{
  manager: SessionManager
  managed: ReturnType<typeof createManagedSession>
  ownership: ModuleAgentRunMetadata
}> {
  const rootPath = await mkdtemp(join(tmpdir(), 'module-agent-admission-'))
  temporaryRoots.push(rootPath)
  const ownership: ModuleAgentRunMetadata = {
    transient: true,
    contractVersion,
    moduleId: 'org.simulator.open-design',
    runHandle: `run_${'1'.repeat(32)}`,
    idempotencyKeyDigest: '2'.repeat(64),
    requestDigest: '3'.repeat(64),
    workerEpoch: 'epoch_admission_fence',
    state: 'accepted',
  }
  const stored = await createStoredSession(rootPath, {
    name: 'OpenDesign',
    hidden: true,
    workingDirectory: rootPath,
    enabledSourceSlugs: [],
    moduleAgentRun: ownership,
  })
  const managed = createManagedSession(stored, {
    id: 'workspace-admission',
    name: 'Admission Workspace',
    rootPath,
    createdAt: Date.now(),
  } as never, { messagesLoaded: true })
  const manager = new SessionManager()
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(managed.id, managed)
  return { manager, managed, ownership }
}

describe('v2 Module provider admission fence', () => {
  for (const fenceKind of ['cancel', 'deadline'] as const) {
    it(`prevents provider creation when ${fenceKind} wins a delayed preflight`, async () => {
      const { manager, managed } = await createTransientManager()
      await manager.updateModuleAgentRunState(managed.id, 'starting')
      let releasePreflight!: () => void
      const preflightBlocked = new Promise<void>((resolve) => { releasePreflight = resolve })
      let enteredPreflight!: () => void
      const preflightEntered = new Promise<void>((resolve) => { enteredPreflight = resolve })
      let providerStarts = 0

      const internals = manager as unknown as {
        ensureMessagesLoaded: () => Promise<void>
        getOrCreateAgent: () => Promise<never>
      }
      internals.ensureMessagesLoaded = async () => {
        enteredPreflight()
        await preflightBlocked
      }
      internals.getOrCreateAgent = async () => {
        providerStarts++
        throw new Error('provider must not start')
      }

      const admission = manager.sendModuleAgentMessage(managed.id, 'build a dashboard')
      // Install the rejection observer before fencing so the test itself never
      // creates an unhandled-rejection scheduling race.
      const admissionResult = admission.then(
        () => 'resolved' as const,
        (error: unknown) => error,
      )
      await preflightEntered
      if (fenceKind === 'cancel') {
        await manager.cancelProcessing(managed.id, true)
      } else {
        await manager.updateModuleAgentRunState(managed.id, 'failed')
      }
      releasePreflight()

      const result = await admissionResult
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).not.toContain('provider must not start')
      expect(providerStarts).toBe(0)
      expect(managed.isProcessing).toBe(false)
      manager.cleanup()
    })
  }

  it('rejects direct sendMessage calls that bypass the Host admission seam', async () => {
    const { manager, managed } = await createTransientManager()
    await expect(manager.sendMessage(managed.id, 'bypass')).rejects.toThrow(
      'require provider admission authority',
    )
    manager.cleanup()
  })

  it('refuses provider admission before the Run owns starting state', async () => {
    const { manager, managed } = await createTransientManager()
    await expect(manager.sendModuleAgentMessage(managed.id, 'too early')).rejects.toThrow(
      'requires starting state',
    )
    manager.cleanup()
  })

  it('rejects authority drift before creating any provider runtime', async () => {
    const { manager, managed } = await createTransientManager()
    await manager.updateModuleAgentRunState(managed.id, 'starting')
    let providerStarts = 0
    ;(manager as unknown as { getOrCreateAgent: () => Promise<never> }).getOrCreateAgent = async () => {
      providerStarts++
      throw new Error('provider must not start')
    }
    const result = await manager.sendModuleAgentMessage(
      managed.id,
      'drifted v2 authority',
      async () => { throw new Error('authority drifted') },
    ).then(() => 'resolved', (error: unknown) => error)
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).not.toContain('authority drifted')
    expect(providerStarts).toBe(0)
    expect(managed.isProcessing).toBe(false)
    manager.cleanup()
  })

  it('rechecks authority after runtime creation and before agent.chat', async () => {
    const { manager, managed } = await createTransientManager()
    await manager.updateModuleAgentRunState(managed.id, 'starting')
    let authorityChecks = 0
    let chatCalls = 0
    ;(manager as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => ({
      chat: () => { chatCalls++; throw new Error('chat must not start') },
    })
    const result = await manager.sendModuleAgentMessage(
      managed.id,
      'drift after runtime creation',
      async () => {
        authorityChecks++
        if (authorityChecks === 2) throw new Error('authority drifted')
      },
    ).then(() => 'resolved', (error: unknown) => error)
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).not.toContain('authority drifted')
    expect(authorityChecks).toBe(2)
    expect(chatCalls).toBe(0)
    expect(managed.isProcessing).toBe(false)
    manager.cleanup()
  })

  it('performs a final authority assertion immediately before iterator.next', async () => {
    const { manager, managed } = await createTransientManager()
    await manager.updateModuleAgentRunState(managed.id, 'starting')
    let authorityChecks = 0
    let chatCalls = 0
    let nextCalls = 0
    ;(manager as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => ({
      setAllSources: () => undefined,
      getModel: () => 'fixture-model',
      chat: () => {
        chatCalls++
        return {
          [Symbol.asyncIterator]() { return this },
          next: async () => { nextCalls++; return { done: true, value: undefined } },
        }
      },
    })
    const result = await manager.sendModuleAgentMessage(
      managed.id,
      'drift before iterator',
      async () => {
        authorityChecks++
        if (authorityChecks === 4) throw new Error('authority drifted')
      },
    ).then(() => 'resolved', (error: unknown) => error)
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).not.toContain('authority drifted')
    expect(authorityChecks).toBe(4)
    expect(chatCalls).toBe(1)
    expect(nextCalls).toBe(0)
    expect(managed.isProcessing).toBe(false)
    manager.cleanup()
  })
})

describe('v1 Module provider authority fence', () => {
  it('rejects drift before creating the legacy provider runtime', async () => {
    const { manager, managed } = await createTransientManager(1)
    let providerStarts = 0
    ;(manager as unknown as { getOrCreateAgent: () => Promise<never> }).getOrCreateAgent = async () => {
      providerStarts++
      throw new Error('provider must not start')
    }
    await expect(manager.sendLegacyModuleAgentMessage(
      managed.id,
      'drifted v1 authority',
      async () => { throw new Error('authority drifted') },
    )).rejects.toThrow()
    expect(providerStarts).toBe(0)
    expect(managed.isProcessing).toBe(false)
    manager.cleanup()
  })
})
