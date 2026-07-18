import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types'
import type { HandlerDeps } from '../handler-deps'
import { registerSessionsHandlers } from './sessions'

function createHarness() {
  const handlers = new Map<string, HandlerFn>()
  const sensitiveCalls: string[] = []
  const assertedIds: string[] = []
  const sessionManager = new Proxy({
    assertRendererSessionAccess(sessionId: string) {
      assertedIds.push(sessionId)
      if (sessionId === 'module-session') throw new Error('Session is unavailable')
    },
  } as Record<string, unknown>, {
    get(target, property) {
      if (property in target) return target[property as string]
      return (..._args: unknown[]) => {
        sensitiveCalls.push(String(property))
        throw new Error(`Sensitive Session method reached: ${String(property)}`)
      }
    },
  })
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  const deps = {
    sessionManager,
    oauthFlowStore: {},
    platform: {
      appRootPath: '/',
      resourcesPath: '/',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      imageProcessor: {
        async getMetadata() { return null },
        async process() { return Buffer.from('') },
      },
    },
  } as unknown as HandlerDeps
  registerSessionsHandlers(server, deps)
  return { handlers, sensitiveCalls, assertedIds }
}

const ctx: RequestContext = {
  clientId: 'renderer-client',
  workspaceId: 'workspace-1',
  webContentsId: 1,
}

describe('renderer transient Session RPC isolation', () => {
  it('fails closed before every exact-ID Session RPC can reach a sensitive method', async () => {
    const { handlers, sensitiveCalls, assertedIds } = createHarness()
    const cases: Array<{ channel: string; args: unknown[] }> = [
      { channel: RPC_CHANNELS.sessions.GET_MESSAGES, args: ['module-session'] },
      { channel: RPC_CHANNELS.sessions.DELETE, args: ['module-session'] },
      { channel: RPC_CHANNELS.sessions.SEND_MESSAGE, args: ['module-session', 'private prompt'] },
      { channel: RPC_CHANNELS.sessions.CANCEL, args: ['module-session'] },
      { channel: RPC_CHANNELS.sessions.KILL_SHELL, args: ['module-session', 'shell-1'] },
      { channel: RPC_CHANNELS.sessions.RESPOND_TO_PERMISSION, args: ['module-session', 'request-1', true, false] },
      { channel: RPC_CHANNELS.sessions.RESPOND_TO_CREDENTIAL, args: ['module-session', 'request-1', { cancelled: true }] },
      { channel: RPC_CHANNELS.sessions.COMMAND, args: ['module-session', { type: 'refreshTitle' }] },
      { channel: RPC_CHANNELS.sessions.COMMAND, args: ['module-session', { type: 'shareToViewer' }] },
      { channel: RPC_CHANNELS.sessions.GET_PENDING_PLAN_EXECUTION, args: ['module-session'] },
      { channel: RPC_CHANNELS.sessions.GET_PERMISSION_MODE_STATE, args: ['module-session'] },
      { channel: RPC_CHANNELS.sessions.GET_FILES, args: ['module-session'] },
      { channel: RPC_CHANNELS.sessions.WATCH_FILES, args: ['module-session'] },
      { channel: RPC_CHANNELS.sessions.GET_NOTES, args: ['module-session'] },
      { channel: RPC_CHANNELS.sessions.SET_NOTES, args: ['module-session', 'attacker note'] },
      { channel: RPC_CHANNELS.sessions.EXPORT, args: ['module-session'] },
      { channel: RPC_CHANNELS.sessions.EXPORT_REMOTE_TRANSFER, args: ['module-session'] },
      {
        channel: RPC_CHANNELS.sessions.CREATE,
        args: ['workspace-1', { branchFromSessionId: 'module-session', branchFromMessageId: 'message-1' }],
      },
      {
        channel: RPC_CHANNELS.sessions.CREATE,
        args: ['workspace-1', { parentSessionId: 'module-session' }],
      },
    ]

    for (const testCase of cases) {
      const handler = handlers.get(testCase.channel)
      if (!handler) throw new Error(`Handler not registered: ${testCase.channel}`)
      await expect(Promise.resolve(handler(ctx, ...testCase.args))).rejects.toThrow('Session is unavailable')
    }

    expect(assertedIds).toEqual(cases.map(() => 'module-session'))
    expect(sensitiveCalls).toEqual([])
  })

  it('keeps every secondary exact-ID renderer surface behind the same choke point', () => {
    const sources = {
      settings: readFileSync(new URL('./settings.ts', import.meta.url), 'utf8'),
      files: readFileSync(new URL('./files.ts', import.meta.url), 'utf8'),
      messaging: readFileSync(new URL('./messaging.ts', import.meta.url), 'utf8'),
      oauth: readFileSync(new URL('./oauth.ts', import.meta.url), 'utf8'),
      tasks: readFileSync(new URL('./tasks.ts', import.meta.url), 'utf8'),
      system: readFileSync(new URL('./system.ts', import.meta.url), 'utf8'),
      workspace: readFileSync(new URL('./workspace.ts', import.meta.url), 'utf8'),
      skills: readFileSync(new URL('./skills.ts', import.meta.url), 'utf8'),
      sources: readFileSync(new URL('./sources.ts', import.meta.url), 'utf8'),
      projects: readFileSync(new URL('./projects.ts', import.meta.url), 'utf8'),
      resources: readFileSync(new URL('./resources.ts', import.meta.url), 'utf8'),
      automations: readFileSync(new URL('./automations.ts', import.meta.url), 'utf8'),
      electronSystem: readFileSync(new URL('../../../../../apps/electron/src/main/handlers/system.ts', import.meta.url), 'utf8'),
      electronWorkspace: readFileSync(new URL('../../../../../apps/electron/src/main/handlers/workspace.ts', import.meta.url), 'utf8'),
      browser: readFileSync(new URL('../../../../../apps/electron/src/main/handlers/browser.ts', import.meta.url), 'utf8'),
      electronMain: readFileSync(new URL('../../../../../apps/electron/src/main/index.ts', import.meta.url), 'utf8'),
    }

    expect(sources.settings).toMatch(/sessions\.GET_MODEL[\s\S]*?assertRendererSessionAccess\(sessionId\)[\s\S]*?getSession\(sessionId\)/)
    expect(sources.settings).toMatch(/sessions\.SET_MODEL[\s\S]*?assertRendererSessionAccess\(sessionId\)[\s\S]*?updateSessionModel\(sessionId/)
    for (const channel of ['GET', 'SET', 'DELETE']) {
      expect(sources.settings).toMatch(new RegExp(
        `server\\.handle\\(RPC_CHANNELS\\.drafts\\.${channel},[\\s\\S]*?assertRendererSessionAccess\\(sessionId\\)`,
      ))
    }
    expect(sources.files).toMatch(/file\.STORE_ATTACHMENT[\s\S]*?assertRendererSessionAccess\(sessionId\)/)
    for (const channel of ['GENERATE_CODE', 'UNBIND']) {
      expect(sources.messaging).toMatch(new RegExp(
        `server\\.handle\\(RPC_CHANNELS\\.messaging\\.${channel},[\\s\\S]*?assertRendererSessionAccess\\(sessionId\\)`,
      ))
    }
    expect(sources.oauth).toMatch(/const \{ sourceSlug, callbackPort, callbackUrl, sessionId, authRequestId \} = args\s+if \(sessionId\) deps\.sessionManager\.assertRendererSessionAccess\(sessionId\)/)
    expect(sources.tasks).toMatch(/if \(req\.attachToExistingSession\)[\s\S]*?assertRendererSessionAccess\(req\.attachToExistingSession\)/)
    expect(sources.tasks.match(/if \(req\.orchestratorSessionId\)[\s\S]*?assertRendererSessionAccess\(req\.orchestratorSessionId\)/g)).toHaveLength(2)
    for (const source of [sources.system, sources.electronSystem]) {
      expect(source).toMatch(/shell\.OPEN_FILE[\s\S]*?validateFilePath[\s\S]*?assertRendererPathAccess\(safePath\)[\s\S]*?requestClientOpenPath/)
      expect(source).toMatch(/shell\.SHOW_IN_FOLDER[\s\S]*?validateFilePath[\s\S]*?assertRendererPathAccess\(safePath\)[\s\S]*?requestClientShowInFolder/)
    }
    expect(sources.browser).toMatch(/if \(input\?\.bindToSessionId\)[\s\S]*?assertRendererSessionAccess\(input\.bindToSessionId\)[\s\S]*?createForSession/)
    expect(sources.browser).toMatch(/browserPane\.LIST[\s\S]*?rendererVisibleInstances\(\)/)
    expect(sources.browser).toMatch(/onStateChange[\s\S]*?isHiddenBrowserInfo\(info\)[\s\S]*?return/)
    expect(sources.electronMain).toMatch(/if \(!sourceWorkspace\.remoteServer\) \{\s*sessionManager\.assertRendererSessionAccess\(sessionId\)\s*\}[\s\S]*?exportSession\(sessionId/)
    expect(sources.electronWorkspace).toMatch(/OPEN_SESSION_IN_NEW_WINDOW[\s\S]*?assertRendererSessionAccess\(sessionId\)[\s\S]*?createWindow/)
    expect(sources.electronSystem).toMatch(/notification\.SHOW[\s\S]*?assertRendererSessionAccess\(sessionId\)[\s\S]*?showNotification/)
    expect(sources.workspace.match(/workspace\.(?:READ_IMAGE|WRITE_IMAGE)[\s\S]*?assertRendererPathAccess\(absolutePath\)/g)).toHaveLength(2)
    for (const channel of ['GET_FILES', 'DELETE', 'OPEN_EDITOR', 'OPEN_FINDER']) {
      expect(sources.skills).toMatch(new RegExp(
        `skills\\.${channel}[\\s\\S]*?validateSkillSlug\\(skillSlug\\)[\\s\\S]*?assertRendererPathAccess`,
      ))
    }
    expect(sources.sources).toMatch(/sources\.DELETE[\s\S]*?validateSourceSlug\(sourceSlug\)[\s\S]*?assertRendererPathAccess/)
    expect(sources.sources).toMatch(/sources\.GET_PERMISSIONS[\s\S]*?validateSourceSlug\(sourceSlug\)[\s\S]*?assertRendererPathAccess\(path\)/)
    expect(sources.sources).toMatch(/sources\.GET[\s\S]*?loadRendererVisibleSources\(workspace\.rootPath, deps\)/)
    expect(sources.sources).toMatch(/sources\.CREATE[\s\S]*?config\.local\?\.path[\s\S]*?assertRendererPathAccess\(config\.local\.path\)/)
    expect(sources.sources).toMatch(/sources\.SAVE_CREDENTIALS[\s\S]*?assertRendererPathAccess\(path\)[\s\S]*?loadSource/)
    expect(sources.sources).toMatch(/sources\.GET_MCP_TOOLS[\s\S]*?loadRendererVisibleSources\(workspace\.rootPath, deps\)/)
    for (const channel of ['DELETE', 'UPLOAD_ASSET']) {
      expect(sources.projects).toMatch(new RegExp(
        `projects\\.${channel}[\\s\\S]*?validateProjectSlug\\(projectSlug\\)[\\s\\S]*?assertRendererPathAccess`,
      ))
    }
    expect(sources.projects).toMatch(/if \(input\.sourcePath\) await deps\.sessionManager\.assertRendererPathAccess\(input\.sourcePath\)/)
    expect(sources.projects).toMatch(/projects\.GET[\s\S]*?loadRendererVisibleProjects\(workspace\.rootPath\)/)
    expect(sources.projects).toMatch(/projects\.GET_ONE[\s\S]*?isRendererVisibleProject\(project\)/)
    expect(sources.skills).toMatch(/skills\.GET[\s\S]*?assertRendererPathAccess\(workingDirectory\)[\s\S]*?assertRendererPathAccess\(skill\.path\)/)
    expect(sources.resources).toMatch(/resources\.EXPORT[\s\S]*?validateSourceSlug\(slug\)[\s\S]*?assertRendererPathAccess\(sourcePath\)/)
    expect(sources.resources).toMatch(/resources\.EXPORT[\s\S]*?validateSkillSlug\(slug\)[\s\S]*?assertRendererPathAccess\(skillPath\)/)
    expect(sources.resources).toMatch(/resources\.IMPORT[\s\S]*?validateResourceBundle\(bundle\)[\s\S]*?assertRendererPathAccess/)
    expect(sources.settings).toMatch(/drafts\.GET_ALL[\s\S]*?isRendererSessionHidden\(sessionId\)/)
    expect(sources.messaging).toMatch(/messaging\.GET_BINDINGS[\s\S]*?isRendererSessionHidden\(binding\.sessionId\)/)
    expect(sources.messaging).toMatch(/messaging\.GET_PENDING_SENDERS[\s\S]*?isRendererSessionHidden\(sender\.sessionId\)/)
    expect(sources.automations).toMatch(/automations\.GET_HISTORY[\s\S]*?isRendererSessionHidden\(e\.sessionId\)/)
    expect(sources.tasks).toMatch(/tasks\.GET[\s\S]*?runContainsHiddenSession[\s\S]*?isRendererSessionHidden/)
    expect(sources.tasks).toMatch(/tasks\.GET_RESULTS[\s\S]*?isRendererSessionHidden\(entry\.sessionId\)/)
  })
})
