import { afterEach, describe, expect, it } from 'bun:test'
import { MemoryModuleAgentPathAuthority } from '@simulator/module-agent-gateway/testing'
import type { ModuleAgentPortEvent } from '@simulator/module-agent-gateway'
import type { Session } from '@craft-agent/shared/protocol'
import { checkModuleAgentToolBoundary } from '@craft-agent/shared/agent'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ISessionManager } from '../handlers/session-manager-interface'
import { CraftModuleAgentSessionPort } from './module-agent-adapter.ts'
import { toModuleAgentPortEvent } from './SessionManager.ts'

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('CraftModuleAgentSessionPort', () => {
  it('creates an invisible source-free session and leaves connection resolution to SessionManager', async () => {
    const container = await mkdtemp(join(tmpdir(), 'module-agent-adapter-'))
    temporaryRoots.push(container)
    const workspaceRoot = join(container, 'workspace')
    const projectRoot = join(container, 'projects', 'design')
    await Promise.all([mkdir(workspaceRoot, { recursive: true }), mkdir(projectRoot, { recursive: true })])
    let createOptions: Record<string, unknown> | undefined
    let internalOptions: Record<string, unknown> | undefined
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
      deleteSession: async () => undefined,
      sendMessage: async () => undefined,
      cancelProcessing: async () => undefined,
      onModuleAgentRuntimeEvent: () => () => undefined,
      onSessionComplete: () => () => undefined,
    } as unknown as ISessionManager
    const port = new CraftModuleAgentSessionPort(manager, new MemoryModuleAgentPathAuthority())
    const created = await port.createSession({
      workspaceId: 'workspace',
      workspaceRoot,
      authorizedWorkingRoot: projectRoot,
      workingDirectory: projectRoot,
    })

    expect(created).toMatchObject({ sessionId: 'raw', hidden: true, workingDirectory: projectRoot })
    expect(createOptions).toMatchObject({ hidden: true, enabledSourceSlugs: [], permissionMode: 'allow-all' })
    expect(createOptions).not.toHaveProperty('llmConnection')
    expect(internalOptions).toEqual({ emitCreatedEvent: false })
    expect(checkModuleAgentToolBoundary('raw', 'Bash', { command: 'pwd' }).allowed).toBe(false)
    await port.deleteSession('raw')
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
