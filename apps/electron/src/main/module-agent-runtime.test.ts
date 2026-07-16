import { afterEach, describe, expect, it } from 'bun:test'
import { chmod, link, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ISessionManager } from '@craft-agent/server-core/handlers'
import type { ModuleAgentPortEvent } from '@simulator/module-agent-gateway'
import type { ModuleDaemonLaunchContext } from '@simulator/module-daemon'
import {
  createHostModuleAgentRuntime,
  createIsolatedHostModuleAgentRuntime,
  selectHostAgentProtocolForModule,
} from './module-agent-runtime'
import { OPEN_DESIGN_MODULE_ID } from '../shared/open-design-module-ipc'

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
  it('fails closed on symlinked, hardlinked, or non-executable Host Agent shims', async () => {
    if (process.platform === 'win32') return
    const temporary = await mkdtemp(join(tmpdir(), 'electron-module-agent-resources-'))
    temporaryRoots.push(temporary)
    const root = await realpath(temporary)
    const worker = join(root, 'worker.cjs')
    const target = join(root, 'shim-target.mjs')
    await writeFile(worker, 'module.exports = {}\n', { mode: 0o644 })
    await writeFile(target, '#!/usr/bin/env node\n', { mode: 0o755 })
    await chmod(worker, 0o644)
    await chmod(target, 0o755)
    const fake = fakeSessions(root)
    const options = (shimPath: string) => ({
      storageRoot: join(root, 'storage'),
      sessions: fake.sessions,
      resolveWorkspaceId: () => 'workspace-1',
      workerEntryPath: worker,
      shimPath,
    })

    const symlinkPath = join(root, 'symlink-shim.mjs')
    await symlink(target, symlinkPath)
    await expect(createIsolatedHostModuleAgentRuntime(options(symlinkPath))).rejects.toThrow(
      'unique Host-owned regular file',
    )

    const hardlinkPath = join(root, 'hardlink-shim.mjs')
    await link(target, hardlinkPath)
    await expect(createIsolatedHostModuleAgentRuntime(options(hardlinkPath))).rejects.toThrow(
      'unique Host-owned regular file',
    )

    const nonExecutablePath = join(root, 'non-executable-shim.mjs')
    await writeFile(nonExecutablePath, '#!/usr/bin/env node\n', { mode: 0o644 })
    await chmod(nonExecutablePath, 0o644)
    await expect(createIsolatedHostModuleAgentRuntime(options(nonExecutablePath))).rejects.toThrow(
      'not executable by the current user',
    )
  })

  it('routes only the declared OpenDesign versions to their exact protocol', () => {
    expect(selectHostAgentProtocolForModule({ id: OPEN_DESIGN_MODULE_ID, version: '0.14.5' })).toBe('v1')
    expect(selectHostAgentProtocolForModule({ id: OPEN_DESIGN_MODULE_ID, version: '0.14.6-rc.1' })).toBe('v2')
    expect(selectHostAgentProtocolForModule({ id: OPEN_DESIGN_MODULE_ID, version: '0.14.6' })).toBe('v2')
    expect(() => selectHostAgentProtocolForModule({
      id: OPEN_DESIGN_MODULE_ID,
      version: '0.14.6-rc.2',
    })).toThrow('does not declare a supported Host Agent contract')
    expect(selectHostAgentProtocolForModule({ id: 'packaged-smoke', version: '1.0.0' })).toBe('v1')
  })

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
