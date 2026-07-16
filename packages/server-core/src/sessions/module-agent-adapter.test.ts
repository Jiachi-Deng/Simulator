import { afterEach, describe, expect, it } from 'bun:test'
import { MemoryModuleAgentPathAuthority } from '@simulator/module-agent-gateway/testing'
import type { ModuleAgentPortEvent } from '@simulator/module-agent-gateway'
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
})

describe('CraftHostAgentRunSessionPort', () => {
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
