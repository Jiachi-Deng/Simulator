import { afterEach, describe, expect, it } from 'bun:test'
import { MemoryModuleAgentPathAuthority } from '@simulator/module-agent-gateway/testing'
import type { ModuleAgentPathAuthority, ModuleAgentPortEvent } from '@simulator/module-agent-gateway'
import type { HostAgentSessionEvent } from '@simulator/host-agent-run-core'
import type { Session } from '@craft-agent/shared/protocol'
import { checkModuleAgentToolBoundary } from '@craft-agent/shared/agent'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ISessionManager } from '../handlers/session-manager-interface'
import { CraftHostAgentRunSessionPort, CraftModuleAgentSessionPort } from './module-agent-adapter.ts'
import { toModuleAgentPortEvent } from './SessionManager.ts'
import { parseModuleAgentRunMetadata } from '@craft-agent/shared/sessions'

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('CraftModuleAgentSessionPort', () => {
  it('creates an invisible source-free session and leaves connection resolution to SessionManager', async () => {
    const container = await mkdtemp(join(tmpdir(), 'module-agent-adapter-'))
    temporaryRoots.push(container)
    const workspaceRoot = join(container, 'workspace')
    const moduleRoot = join(container, 'module-data', 'open-design')
    const projectRoot = join(moduleRoot, 'projects', 'design')
    const siblingProject = join(moduleRoot, 'projects', 'other-design')
    const daemonData = join(moduleRoot, 'open-design.db')
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(projectRoot, { recursive: true }),
      mkdir(siblingProject, { recursive: true }),
    ])
    let createOptions: Record<string, unknown> | undefined
    let internalOptions: Record<string, unknown> | undefined
    const lifecycleCalls: string[] = []
    const manager = {
      getWorkspaces: () => [{ id: 'workspace', rootPath: workspaceRoot }],
      createSession: async (_workspaceId: string, options: Record<string, unknown>, internal: Record<string, unknown>) => {
        createOptions = options
        internalOptions = internal
        return {
          id: 'raw', workspaceId: 'workspace', workspaceName: 'Workspace', lastMessageAt: 0,
          messages: [], isProcessing: false, hidden: true, workingDirectory: projectRoot,
        } as Session
      },
      deleteSession: async () => { lifecycleCalls.push('delete') },
      awaitSessionStopped: async () => { lifecycleCalls.push('stopped') },
      disposeSessionAndReap: async () => { lifecycleCalls.push('reaped') },
      sendMessage: async () => undefined,
      cancelProcessing: async () => undefined,
      onModuleAgentRuntimeEvent: () => () => undefined,
      onSessionComplete: () => () => undefined,
    } as unknown as ISessionManager
    const port = new CraftModuleAgentSessionPort(manager, new MemoryModuleAgentPathAuthority())
    const created = await port.createSession({
      workspaceId: 'workspace',
      workspaceRoot,
      authorizedWorkingRoot: moduleRoot,
      workingDirectory: projectRoot,
    })

    expect(created).toMatchObject({ sessionId: 'raw', hidden: true, workingDirectory: projectRoot })
    expect(createOptions).toMatchObject({ hidden: true, enabledSourceSlugs: [], permissionMode: 'allow-all' })
    expect(createOptions).not.toHaveProperty('llmConnection')
    expect(internalOptions).toMatchObject({ emitCreatedEvent: false })
    const ownership = parseModuleAgentRunMetadata(internalOptions?.moduleAgentRun)
    expect(ownership).toMatchObject({
      transient: true,
      contractVersion: 1,
      moduleId: 'open-design',
      state: 'accepted',
    })
    expect(checkModuleAgentToolBoundary('raw', 'Bash', { command: 'pwd' }).allowed).toBe(false)
    expect(checkModuleAgentToolBoundary('raw', 'Read', { file_path: join(projectRoot, 'index.ts') }).allowed).toBe(true)
    expect(checkModuleAgentToolBoundary('raw', 'Read', { file_path: join(siblingProject, 'secret.ts') }).allowed).toBe(false)
    expect(checkModuleAgentToolBoundary('raw', 'Write', { file_path: daemonData }).allowed).toBe(false)
    await port.awaitStopped('raw')
    await port.disposeAndReap('raw')
    expect(lifecycleCalls).toEqual(['stopped', 'reaped'])
    expect(checkModuleAgentToolBoundary('raw', 'Bash', { command: 'pwd' }).allowed).toBe(true)
  })

  it('returns from sendTurn before the long-running SessionManager promise and reports rejection generically', async () => {
    let rejectSend: (() => void) | undefined
    const manager = {
      sendMessage: () => new Promise<void>((_resolve, reject) => { rejectSend = () => reject(new Error('secret=abc')) }),
      onModuleAgentRuntimeEvent: () => () => undefined,
      onSessionComplete: () => () => undefined,
    } as unknown as ISessionManager
    const port = new CraftModuleAgentSessionPort(manager, new MemoryModuleAgentPathAuthority())
    const events: ModuleAgentPortEvent[] = []
    port.subscribe('raw', (event) => events.push(event))
    await port.sendTurn('raw', 'prompt')
    rejectSend!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toEqual([{ type: 'turn.failed', sessionId: 'raw', code: 'HOST_RUNTIME_ERROR' }])
    expect(JSON.stringify(events)).not.toContain('secret=abc')
  })

  it('passes the H1-pinned Connection explicitly and fails closed while admission is unarmed', async () => {
    const container = await mkdtemp(join(tmpdir(), 'module-agent-v1-connection-'))
    temporaryRoots.push(container)
    const workspaceRoot = join(container, 'workspace')
    const projectRoot = join(container, 'project')
    await Promise.all([mkdir(workspaceRoot), mkdir(projectRoot)])
    let createCalls = 0
    let createOptions: Record<string, unknown> | undefined
    const manager = {
      getWorkspaces: () => [{ id: 'workspace', rootPath: workspaceRoot }],
      createSession: async (_workspaceId: string, options: Record<string, unknown>) => {
        createCalls++
        createOptions = options
        return {
          id: 'v1-pinned', workspaceId: 'workspace', hidden: true, workingDirectory: projectRoot,
          llmConnection: options.llmConnection,
        } as Session
      },
      deleteSession: async () => undefined,
      onModuleAgentRuntimeEvent: () => () => undefined,
      onSessionComplete: () => () => undefined,
    } as unknown as ISessionManager
    let armed = false
    const admission = {
      admit: async () => {
        if (!armed) throw new Error('not armed')
        return { llmConnection: 'approved-connection' }
      },
      assertConnection: async () => {
        if (!armed) throw new Error('not armed')
      },
    }
    const port = new CraftModuleAgentSessionPort(manager, new MemoryModuleAgentPathAuthority(), admission)
    const input = {
      workspaceId: 'workspace', workspaceRoot, authorizedWorkingRoot: projectRoot, workingDirectory: projectRoot,
    }
    await expect(port.createSession(input)).rejects.toThrow('not armed')
    expect(createCalls).toBe(0)
    armed = true
    await port.createSession(input)
    expect(createOptions?.llmConnection).toBe('approved-connection')
  })
})

describe('CraftHostAgentRunSessionPort', () => {
  it('waits for the SessionManager provider-admission acknowledgement', async () => {
    let admit!: () => void
    const admission = new Promise<void>((resolve) => { admit = resolve })
    const manager = {
      sendModuleAgentMessage: () => admission,
      onModuleAgentRuntimeEvent: () => () => undefined,
      onSessionComplete: () => () => undefined,
    } as unknown as ISessionManager
    const port = new CraftHostAgentRunSessionPort(manager, new MemoryModuleAgentPathAuthority())
    let settled = false
    const send = port.sendTurn('raw-v2', 'prompt').finally(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    admit()
    await send
    expect(settled).toBe(true)
  })

  it('reports provider-admission rejection without leaking its details', async () => {
    const manager = {
      sendModuleAgentMessage: async () => { throw new Error('secret provider path') },
      onModuleAgentRuntimeEvent: () => () => undefined,
      onSessionComplete: () => () => undefined,
    } as unknown as ISessionManager
    const port = new CraftHostAgentRunSessionPort(manager, new MemoryModuleAgentPathAuthority())
    const events: HostAgentSessionEvent[] = []
    port.subscribe('raw-v2', (event) => events.push(event))
    await expect(port.sendTurn('raw-v2', 'prompt')).rejects.toThrow('Host provider admission failed')
    expect(events).toEqual([{ type: 'turn.failed', sessionId: 'raw-v2', code: 'RUNTIME_UNAVAILABLE' }])
    expect(JSON.stringify(events)).not.toContain('secret provider path')
  })

  it('pins the approved Connection for create and recovery and reasserts it before send', async () => {
    const container = await mkdtemp(join(tmpdir(), 'module-agent-v2-connection-'))
    temporaryRoots.push(container)
    const workspaceRoot = join(container, 'workspace')
    const projectRoot = join(container, 'project')
    await Promise.all([mkdir(workspaceRoot), mkdir(projectRoot)])
    let createOptions: Record<string, unknown> | undefined
    let providerAssertions = 0
    let sendAssertion: (() => Promise<void>) | undefined
    const session = {
      id: 'v2-pinned', workspaceId: 'workspace', hidden: true, workingDirectory: projectRoot,
      llmConnection: 'approved-connection',
    } as Session
    const manager = {
      getWorkspaces: () => [{ id: 'workspace', rootPath: workspaceRoot }],
      createSession: async (_workspaceId: string, options: Record<string, unknown>) => {
        createOptions = options
        return session
      },
      recoverModuleAgentSession: async () => session,
      sendModuleAgentMessage: async (_sessionId: string, _prompt: string, assertion?: () => Promise<void>) => {
        sendAssertion = assertion
        await assertion?.()
      },
      deleteSession: async () => undefined,
      onModuleAgentRuntimeEvent: () => () => undefined,
      onSessionComplete: () => () => undefined,
    } as unknown as ISessionManager
    const admission = {
      admit: async () => ({ llmConnection: 'approved-connection' }),
      assertConnection: async () => { providerAssertions++ },
    }
    const port = new CraftHostAgentRunSessionPort(manager, new MemoryModuleAgentPathAuthority(), admission)
    const ownership = {
      transient: true as const,
      contractVersion: 2 as const,
      moduleId: 'org.simulator.open-design',
      runHandle: `run_${'a'.repeat(32)}`,
      idempotencyKeyDigest: 'b'.repeat(64),
      requestDigest: 'c'.repeat(64),
      workerEpoch: 'epoch_connection_pin',
      state: 'accepted' as const,
    }
    const input = {
      workspaceId: 'workspace', workspaceRoot, authorizedWorkingRoot: projectRoot, workingDirectory: projectRoot, ownership,
    }
    await port.createSession(input)
    expect(createOptions?.llmConnection).toBe('approved-connection')
    await port.sendTurn(session.id, 'prompt')
    expect(sendAssertion).toBeFunction()
    expect(providerAssertions).toBeGreaterThanOrEqual(3)
    await port.recoverSession(input)
    expect(providerAssertions).toBeGreaterThanOrEqual(4)
  })

  it('persists RunCore ownership unchanged and advances state through the internal seam', async () => {
    const container = await mkdtemp(join(tmpdir(), 'host-agent-v2-adapter-'))
    temporaryRoots.push(container)
    const workspaceRoot = join(container, 'workspace')
    const projectRoot = join(container, 'module-data', 'open-design', 'project')
    await Promise.all([mkdir(workspaceRoot, { recursive: true }), mkdir(projectRoot, { recursive: true })])
    let internalOptions: Record<string, unknown> | undefined
    const stateUpdates: Array<{ sessionId: string; state: string }> = []
    const manager = {
      getWorkspaces: () => [{ id: 'workspace', rootPath: workspaceRoot }],
      createSession: async (_workspaceId: string, _options: Record<string, unknown>, internal: Record<string, unknown>) => {
        internalOptions = internal
        return {
          id: 'raw-v2', workspaceId: 'workspace', workspaceName: 'Workspace', lastMessageAt: 0,
          messages: [], isProcessing: false, hidden: true, workingDirectory: projectRoot,
        } as Session
      },
      updateModuleAgentRunState: async (sessionId: string, state: string) => { stateUpdates.push({ sessionId, state }) },
      deleteSession: async () => undefined,
      awaitSessionStopped: async () => undefined,
      disposeSessionAndReap: async () => undefined,
      sendMessage: async () => undefined,
      cancelProcessing: async () => undefined,
      onModuleAgentRuntimeEvent: () => () => undefined,
      onSessionComplete: () => () => undefined,
    } as unknown as ISessionManager
    const port = new CraftHostAgentRunSessionPort(manager, new MemoryModuleAgentPathAuthority())
    const ownership = {
      transient: true as const,
      contractVersion: 2 as const,
      moduleId: 'org.simulator.open-design',
      runHandle: `run_${'1'.repeat(32)}`,
      idempotencyKeyDigest: '2'.repeat(64),
      requestDigest: '3'.repeat(64),
      workerEpoch: 'epoch_1234',
      state: 'accepted' as const,
    }
    await port.createSession({
      workspaceId: 'workspace',
      workspaceRoot,
      authorizedWorkingRoot: projectRoot,
      workingDirectory: projectRoot,
      ownership,
    })
    expect(parseModuleAgentRunMetadata(internalOptions?.moduleAgentRun)).toEqual(ownership)
    await port.updateRunState('raw-v2', 'starting')
    expect(stateUpdates).toEqual([{ sessionId: 'raw-v2', state: 'starting' }])
    await port.disposeAndReap('raw-v2')
    expect(checkModuleAgentToolBoundary('raw-v2', 'Bash', { command: 'pwd' }).allowed).toBe(true)
  })

  it('maps completion errors without leaking provider details', async () => {
    let complete: ((event: { sessionId: string; reason: 'error'; finalText: string }) => void) | undefined
    const manager = {
      sendMessage: async () => undefined,
      onModuleAgentRuntimeEvent: () => () => undefined,
      onSessionComplete: (listener: typeof complete) => { complete = listener; return () => undefined },
    } as unknown as ISessionManager
    const port = new CraftHostAgentRunSessionPort(manager, new MemoryModuleAgentPathAuthority())
    const events: HostAgentSessionEvent[] = []
    port.subscribe('raw-v2', (event) => events.push(event))
    complete!({ sessionId: 'raw-v2', reason: 'error', finalText: 'secret provider detail' })
    expect(events).toEqual([{ type: 'turn.failed', sessionId: 'raw-v2', code: 'INTERNAL_ERROR' }])
    expect(JSON.stringify(events)).not.toContain('secret provider detail')
  })

  it('recovers the same durable Session when post-create canonicalization loses the response', async () => {
    const container = await mkdtemp(join(tmpdir(), 'host-agent-v2-response-loss-'))
    temporaryRoots.push(container)
    const workspaceRoot = join(container, 'workspace')
    const projectRoot = join(container, 'module-data', 'open-design', 'project')
    await Promise.all([mkdir(workspaceRoot, { recursive: true }), mkdir(projectRoot, { recursive: true })])

    let createdSession: Session | undefined
    let createdOwnership: unknown
    const manager = {
      getWorkspaces: () => [{ id: 'workspace', rootPath: workspaceRoot }],
      createSession: async (_workspaceId: string, _options: unknown, internal: Record<string, unknown>) => {
        createdOwnership = internal.moduleAgentRun
        createdSession = {
          id: 'response-lost-v2', workspaceId: 'workspace', workspaceName: 'Workspace', lastMessageAt: 0,
          messages: [], isProcessing: false, hidden: true, workingDirectory: projectRoot,
        } as Session
        return createdSession
      },
      recoverModuleAgentSession: async (input: { ownership: unknown }) => {
        expect(input.ownership).toEqual(createdOwnership)
        return createdSession ?? null
      },
      disposeSessionAndReap: async () => undefined,
      deleteSession: async () => undefined,
      onModuleAgentRuntimeEvent: () => () => undefined,
      onSessionComplete: () => () => undefined,
    } as unknown as ISessionManager

    let canonicalizeCalls = 0
    let loseCreateResponse = true
    const paths: ModuleAgentPathAuthority = {
      canonicalize: async (path: string) => {
        canonicalizeCalls++
        // actual workspace, expected workspace, grant root, request cwd,
        // then the cwd in SessionManager's response.
        if (loseCreateResponse && canonicalizeCalls === 5) {
          throw new Error('simulated response loss after durable creation')
        }
        return path
      },
      isEqualOrWithin: async () => true,
    }
    const port = new CraftHostAgentRunSessionPort(manager, paths)
    const ownership = {
      transient: true as const,
      contractVersion: 2 as const,
      moduleId: 'org.simulator.open-design',
      runHandle: `run_${'d'.repeat(32)}`,
      idempotencyKeyDigest: 'e'.repeat(64),
      requestDigest: 'f'.repeat(64),
      workerEpoch: 'epoch_response_loss',
      state: 'accepted' as const,
    }
    const input = {
      workspaceId: 'workspace',
      workspaceRoot,
      authorizedWorkingRoot: projectRoot,
      workingDirectory: projectRoot,
      ownership,
    }

    await expect(port.createSession(input)).rejects.toThrow('simulated response loss')
    loseCreateResponse = false
    canonicalizeCalls = 0
    const recovered = await port.recoverSession(input)
    expect(recovered?.sessionId).toBe('response-lost-v2')
    expect(checkModuleAgentToolBoundary('response-lost-v2', 'Write', {
      file_path: join(projectRoot, 'index.ts'),
    }).allowed).toBe(true)
    await port.disposeAndReap('response-lost-v2')
  })

  it('does not erase the fail-closed boundary when strict provider reap rejects', async () => {
    const container = await mkdtemp(join(tmpdir(), 'host-agent-v2-reap-failure-'))
    temporaryRoots.push(container)
    const workspaceRoot = join(container, 'workspace')
    const projectRoot = join(container, 'project')
    await Promise.all([mkdir(workspaceRoot, { recursive: true }), mkdir(projectRoot, { recursive: true })])
    let rejectReap = true
    const manager = {
      getWorkspaces: () => [{ id: 'workspace', rootPath: workspaceRoot }],
      createSession: async () => ({
        id: 'strict-reap-v2', workspaceId: 'workspace', workspaceName: 'Workspace', lastMessageAt: 0,
        messages: [], isProcessing: false, hidden: true, workingDirectory: projectRoot,
      } as Session),
      deleteSession: async () => undefined,
      disposeSessionAndReap: async () => {
        if (rejectReap) throw new Error('provider tree still alive')
      },
      onModuleAgentRuntimeEvent: () => () => undefined,
      onSessionComplete: () => () => undefined,
    } as unknown as ISessionManager
    const port = new CraftHostAgentRunSessionPort(manager, new MemoryModuleAgentPathAuthority())
    await port.createSession({
      workspaceId: 'workspace',
      workspaceRoot,
      authorizedWorkingRoot: projectRoot,
      workingDirectory: projectRoot,
      ownership: {
        transient: true,
        contractVersion: 2,
        moduleId: 'org.simulator.open-design',
        runHandle: `run_${'0'.repeat(32)}`,
        idempotencyKeyDigest: '1'.repeat(64),
        requestDigest: '2'.repeat(64),
        workerEpoch: 'epoch_reap_failure',
        state: 'accepted',
      },
    })

    await expect(port.disposeAndReap('strict-reap-v2')).rejects.toThrow('provider tree still alive')
    expect(checkModuleAgentToolBoundary('strict-reap-v2', 'Bash', { command: 'pwd' }).allowed).toBe(false)
    rejectReap = false
    await port.disposeAndReap('strict-reap-v2')
    expect(checkModuleAgentToolBoundary('strict-reap-v2', 'Bash', { command: 'pwd' }).allowed).toBe(true)
  })
})

describe('toModuleAgentPortEvent', () => {
  it('drops tool payloads, paths, credentials, auth, and permission events', () => {
    const tool = toModuleAgentPortEvent({
      type: 'tool_start', sessionId: 'raw', toolName: 'write_file', toolUseId: 'tool',
      toolInput: { path: '/private/secret', token: 'secret-token' },
    })
    expect(tool).toEqual({ type: 'activity', sessionId: 'raw', phase: 'started', kind: 'tool', label: 'write_file' })
    expect(JSON.stringify(tool)).not.toContain('/private/secret')
    expect(toModuleAgentPortEvent({
      type: 'credential_request', sessionId: 'raw', request: {} as never,
    })).toBeUndefined()
    expect(toModuleAgentPortEvent({
      type: 'permission_request', sessionId: 'raw', request: {} as never,
    })).toBeUndefined()
    expect(toModuleAgentPortEvent({
      type: 'auth_request', sessionId: 'raw', message: {} as never, request: {} as never,
    })).toBeUndefined()
  })
})
