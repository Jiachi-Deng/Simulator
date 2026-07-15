import { afterEach, describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ISessionManager } from '@craft-agent/server-core/handlers'
import type { ModuleAgentPortEvent } from '@simulator/module-agent-gateway'
import type { ModuleDaemonLaunchContext } from '@simulator/module-daemon'
import { createHostModuleAgentRuntime } from './module-agent-runtime'

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function fakeSessions(workspaceRoot: string) {
  const moduleListeners = new Set<(event: ModuleAgentPortEvent) => void>()
  const completionListeners = new Set<(event: {
    sessionId: string
    reason: 'complete'
    finalText: string
  }) => void>()
  const created: Array<Record<string, unknown>> = []
  const deleted: string[] = []
  const prompts: string[] = []
  const sessions = {
    getWorkspaces: () => [{
      id: 'workspace-1',
      name: 'Workspace',
      slug: 'workspace',
      rootPath: workspaceRoot,
      createdAt: 1,
    }],
    async createSession(workspaceId: string, options: Record<string, unknown>) {
      created.push({ workspaceId, ...options })
      return {
        id: 'raw-craft-session',
        workspaceId,
        workingDirectory: options.workingDirectory,
        hidden: options.hidden,
      }
    },
    onModuleAgentRuntimeEvent(listener: (event: ModuleAgentPortEvent) => void) {
      moduleListeners.add(listener)
      return () => moduleListeners.delete(listener)
    },
    onSessionComplete(listener: (event: { sessionId: string; reason: 'complete'; finalText: string }) => void) {
      completionListeners.add(listener)
      return () => completionListeners.delete(listener)
    },
    async sendMessage(sessionId: string, prompt: string) {
      prompts.push(prompt)
      for (const listener of moduleListeners) {
        listener({ type: 'message.delta', sessionId, delta: 'host runtime ' })
        listener({ type: 'message.completed', sessionId, text: 'host runtime reply' })
      }
      for (const listener of completionListeners) {
        listener({ sessionId, reason: 'complete', finalText: 'host runtime reply' })
      }
    },
    async cancelProcessing() {},
    async deleteSession(sessionId: string) { deleted.push(sessionId) },
  } as unknown as ISessionManager
  return { sessions, created, deleted, prompts }
}

function launchContext(signal: AbortSignal): ModuleDaemonLaunchContext {
  return {
    id: 'open-design',
    version: '0.14.1',
    activatedRoot: '/activated/open-design',
    executable: '/activated/open-design/bin/open-design',
    endpoint: { host: '127.0.0.1', port: 31_337 },
    restartCount: 0,
    signal,
  } as ModuleDaemonLaunchContext
}

describe('Host Module Agent runtime', () => {
  it('binds an active Craft workspace to an owner-only launch grant and revokes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'electron-module-agent-'))
    temporaryRoots.push(root)
    const workspaceRoot = join(root, 'workspace')
    await mkdir(workspaceRoot)
    const fake = fakeSessions(workspaceRoot)
    let grantedWorkingRoot = ''
    const runtime = await createHostModuleAgentRuntime({
      storageRoot: root,
      sessions: fake.sessions,
      resolveWorkspaceId: () => 'workspace-1',
      createServer: (gateway) => {
        const tokens = new Set<string>()
        return {
          async start() { return 'http://127.0.0.1:31337' },
          async prepareLaunch(spec, tokenDirectory) {
            grantedWorkingRoot = spec.authorizedWorkingRoot
            const grant = await gateway.issueGrant(spec)
            tokens.add(grant.grantToken)
            const tokenFile = join(tokenDirectory, `${grant.grantToken}.token`)
            await writeFile(tokenFile, `${grant.grantToken}\n`, { mode: 0o600 })
            await chmod(tokenFile, 0o600)
            return {
              grantToken: grant.grantToken,
              tokenFile,
              authorization: gateway.authorizationForGrant(grant.grantToken),
              environment: {
                SIMULATOR_HOST_AGENT_URL: 'http://127.0.0.1:31337',
                SIMULATOR_HOST_AGENT_TOKEN_FILE: tokenFile,
              },
              async dispose() {
                await gateway.revokeGrant(grant.grantToken)
                await rm(tokenFile, { force: true })
                tokens.delete(grant.grantToken)
              },
            }
          },
          async stop() {
            for (const token of tokens) await gateway.revokeGrant(token)
            tokens.clear()
          },
        }
      },
    })
    const controller = new AbortController()
    const lease = await runtime.prepareLaunch(launchContext(controller.signal))
    const url = lease.environment?.SIMULATOR_HOST_AGENT_URL
    const tokenFile = lease.environment?.SIMULATOR_HOST_AGENT_TOKEN_FILE
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(tokenFile).toBeString()
    expect((await readFile(tokenFile!, 'utf8')).trim()).toMatch(/^[0-9a-f]{64}$/)
    expect(grantedWorkingRoot).toBe(join(await realpath(root), 'module-data', 'open-design'))
    expect(runtime.debugSnapshot()).toMatchObject({ activeGrants: 1, activeSessions: 0, activeTurns: 0 })

    await lease.cleanup('stop')
    expect(fake.deleted).toEqual([])
    expect(runtime.debugSnapshot()).toEqual({
      activeGrants: 0,
      activeSessions: 0,
      activeTurns: 0,
      activeSubscribers: 0,
    })
    await expect(readFile(tokenFile!, 'utf8')).rejects.toBeTruthy()
    await runtime.dispose()
  })
})
