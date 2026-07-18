import { afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Workspace } from '@craft-agent/core/types'
import { ClaudeAgent } from '@craft-agent/shared/agent'
import type { AgentBackend } from '@craft-agent/shared/agent/backend'
import {
  parseModuleAgentRunMetadata,
  type ModuleAgentRunMetadata,
} from '@craft-agent/shared/sessions'
import { SessionManager, createManagedSession } from './SessionManager'

type Managed = ReturnType<typeof createManagedSession>

interface RuntimeDisposalHarness {
  disposeManagedAgentRuntime(managed: Managed, reason: string): Promise<void>
}

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function validModuleOwnership(state: ModuleAgentRunMetadata['state'] = 'running'): ModuleAgentRunMetadata {
  return parseModuleAgentRunMetadata({
    transient: true,
    contractVersion: 2,
    moduleId: 'org.simulator.open-design',
    runHandle: `run_${'1'.repeat(32)}`,
    idempotencyKeyDigest: '2'.repeat(64),
    requestDigest: '3'.repeat(64),
    workerEpoch: 'epoch_runtime_refresh_fence',
    state,
  })
}

async function createManaged(
  id: string,
  hidden = false,
  moduleAgentRun?: ModuleAgentRunMetadata,
): Promise<{
  manager: SessionManager
  managed: Managed
}> {
  const root = await mkdtemp(join(tmpdir(), 'claude-disposal-containment-'))
  roots.push(root)
  const workspace = {
    id: 'workspace-1',
    name: 'Workspace',
    rootPath: root,
    createdAt: 1,
  } as Workspace
  const manager = new SessionManager()
  const managed = createManagedSession(
    { id, hidden, moduleAgentRun },
    workspace,
    { messagesLoaded: true },
  )
  return { manager, managed }
}

function createClaudeHarness(): AgentBackend {
  const agent = Object.create(ClaudeAgent.prototype) as AgentBackend
  agent.isProcessing = () => false
  agent.forceAbort = mock(() => {})
  return agent
}

async function resolveWithin(promise: Promise<void>, timeoutMs = 250): Promise<'resolved' | 'timed-out'> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(() => 'resolved' as const),
      new Promise<'timed-out'>((resolve) => {
        timeout = setTimeout(() => resolve('timed-out'), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

describe('Claude Session disposal containment', () => {
  it('keeps ordinary Host runtime refresh on the pre-existing synchronous dispose path', async () => {
    const { manager, managed } = await createManaged('visible-session')
    const agent = createClaudeHarness()
    const lifecycle: string[] = []
    agent.dispose = () => {
      lifecycle.push('dispose')
      throw new Error('ordinary dispose fixture failure')
    }
    agent.disposeAndReap = async () => {
      lifecycle.push('disposeAndReap')
      await new Promise<never>(() => {})
    }
    managed.agent = agent

    expect('disposeForRestart' in agent).toBe(false)
    const outcome = await resolveWithin(
      (manager as unknown as RuntimeDisposalHarness)
        .disposeManagedAgentRuntime(managed, 'fixture runtime refresh'),
    )

    // The original ordinary path is synchronous dispose(), whose failure is
    // logged/contained while runtime ownership is cleared for lazy recreation.
    // The strict transient method must not be selected or awaited here.
    expect(outcome).toBe('resolved')
    expect(lifecycle).toEqual(['dispose'])
    expect(managed.agent).toBeNull()
  })

  it('selects awaited disposeAndReap for a transient Module Session', async () => {
    const { manager, managed } = await createManaged(
      'module-session',
      true,
      validModuleOwnership(),
    )
    const agent = createClaudeHarness()
    const lifecycle: string[] = []
    agent.dispose = () => { lifecycle.push('dispose') }
    agent.disposeAndReap = async () => { lifecycle.push('disposeAndReap') }
    managed.agent = agent
    ;(manager as unknown as { sessions: Map<string, Managed> }).sessions.set(managed.id, managed)

    await manager.disposeSessionAndReap(managed.id, 250)

    expect(lifecycle).toEqual(['disposeAndReap'])
    expect(managed.agent).toBeNull()
    await expect(manager.getSession(managed.id)).resolves.toBeNull()
  })

  it('freezes a valid transient runtime across public connection refresh until strict reap', async () => {
    const ownership = validModuleOwnership('running')
    const { manager, managed } = await createManaged(
      'module-session-refresh',
      true,
      ownership,
    )
    const agent = createClaudeHarness()
    const lifecycle: string[] = []
    agent.dispose = () => { lifecycle.push('dispose') }
    agent.disposeAndReap = async () => { lifecycle.push('disposeAndReap') }
    agent.updateRuntimeConfig = async () => {
      lifecycle.push('updateRuntimeConfig')
      return false
    }
    managed.agent = agent
    managed.llmConnection = 'module-connection'
    managed.backendRuntimeSignature = '__stale_module_runtime_signature__'
    managed.backendRestartSignature = '__stale_module_restart_signature__'
    ;(manager as unknown as { sessions: Map<string, Managed> }).sessions.set(managed.id, managed)

    await manager.refreshConnectionRuntime('module-connection')

    // Generic refresh must not update, dispose, recreate, or detach any part
    // of a one-Turn runtime from its atomic ownership record.
    expect(lifecycle).toEqual([])
    expect(managed.agent).toBe(agent)
    expect(managed.llmConnection).toBe('module-connection')
    expect(managed.backendRuntimeSignature).toBe('__stale_module_runtime_signature__')
    expect(managed.backendRestartSignature).toBe('__stale_module_restart_signature__')
    expect(managed.moduleAgentRun).toEqual(ownership)

    await manager.disposeSessionAndReap(managed.id, 250)

    expect(lifecycle).toEqual(['disposeAndReap'])
    expect(managed.agent).toBeNull()
    await expect(manager.getSession(managed.id)).resolves.toBeNull()
  })

  it('preserves transient ownership when strict Claude disposal fails', async () => {
    const { manager, managed } = await createManaged(
      'module-session-failure',
      true,
      validModuleOwnership('failed'),
    )
    const agent = createClaudeHarness()
    const lifecycle: string[] = []
    agent.dispose = () => { lifecycle.push('dispose') }
    agent.disposeAndReap = async () => {
      lifecycle.push('disposeAndReap')
      throw new Error('strict Claude fixture failure')
    }
    managed.agent = agent
    ;(manager as unknown as { sessions: Map<string, Managed> }).sessions.set(managed.id, managed)

    await expect(manager.disposeSessionAndReap(managed.id, 250))
      .rejects.toThrow('strict Claude fixture failure')

    expect(lifecycle).toEqual(['disposeAndReap', 'dispose'])
    expect(managed.agent).toBe(agent)
    expect(manager.getModuleAgentSessionResidueSnapshot().transientSessions).toBe(1)
    await expect(manager.getSession(managed.id)).resolves.toBeNull()
  })
})
