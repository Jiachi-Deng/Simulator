/**
 * Tests for browser handler broadcast + LIST.
 *
 * Workspace isolation contract: enforced renderer-side via
 * filterInstancesForWorkspace (which handles both the local and remote-mirror
 * workspace ids). The server-side handler broadcasts every event to all
 * locally-connected renderers and returns the full instance list from LIST.
 *
 * The reason: a renderer's transport-level workspaceId is always the *local*
 * Simulator window's id (set by updateClientWorkspace), but remote-bridged
 * tabs are stamped with the *remote* server's workspaceId. A workspace-scoped
 * broadcast or LIST filter would silently drop those events because the two
 * ids never match. The renderer knows both ids and filters correctly.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { RPC_CHANNELS, type BrowserInstanceInfo } from '@craft-agent/shared/protocol'

mock.module('electron', () => ({
  ipcMain: { handle: () => {}, on: () => {} },
}))

type HandlerFn = (...args: unknown[]) => unknown
type Push = { channel: string; target: unknown; args: unknown[] }

interface Recorder {
  server: RpcServer
  handlers: Map<string, HandlerFn>
  pushes: Push[]
}

function makeServer(): Recorder {
  const handlers = new Map<string, HandlerFn>()
  const pushes: Push[] = []
  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler as HandlerFn)
    },
    push(channel, target, ...args) {
      pushes.push({ channel, target, args })
    },
    async invokeClient() {},
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  return { server, handlers, pushes }
}

function makeInstance(id: string, overrides?: Partial<BrowserInstanceInfo>): BrowserInstanceInfo {
  return {
    id,
    url: 'https://example.com',
    title: 'Example',
    favicon: null,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    boundSessionId: null,
    ownerType: 'manual',
    ownerSessionId: null,
    isVisible: true,
    agentControlActive: false,
    themeColor: null,
    workspaceId: null,
    ...overrides,
  }
}

function makeDeps(opts: {
  instances: BrowserInstanceInfo[]
  captureStateCb?: (cb: (info: BrowserInstanceInfo) => void) => void
  captureRemovedCb?: (cb: (id: string) => void) => void
  captureInteractedCb?: (cb: (id: string) => void) => void
  createForSession?: (sessionId: string) => unknown
  assertSession?: (sessionId: string) => void
  isHiddenSession?: (sessionId: string) => boolean
  navigate?: (id: string, url: string) => unknown
}): HandlerDeps {
  return {
    sessionManager: {
      assertRendererSessionAccess: opts.assertSession ?? (() => {}),
      isRendererSessionHidden: opts.isHiddenSession ?? (() => false),
    } as HandlerDeps['sessionManager'],
    platform: {
      appRootPath: '',
      resourcesPath: '',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: false,
      logger: console,
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
    },
    windowManager: {} as HandlerDeps['windowManager'],
    browserPaneManager: {
      listInstances: () => opts.instances,
      onStateChange: (cb: (info: BrowserInstanceInfo) => void) => opts.captureStateCb?.(cb),
      onRemoved: (cb: (id: string) => void) => opts.captureRemovedCb?.(cb),
      onInteracted: (cb: (id: string) => void) => opts.captureInteractedCb?.(cb),
      createForSession: (sessionId: string) => opts.createForSession?.(sessionId),
      navigate: (id: string, url: string) => opts.navigate?.(id, url),
    } as unknown as NonNullable<HandlerDeps['browserPaneManager']>,
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
  }
}

describe('browser handler — workspace filtering', () => {
  let recorder: Recorder

  beforeEach(() => {
    recorder = makeServer()
  })

  describe('STATE_CHANGED broadcast target', () => {
    it('always broadcasts to all renderers (workspace-aware-filtering happens in the renderer)', async () => {
      let captured: ((info: BrowserInstanceInfo) => void) | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(
        recorder.server,
        makeDeps({
          instances: [],
          captureStateCb: (cb) => { captured = cb },
        }),
      )

      expect(captured).not.toBeNull()
      // Workspace-stamped instance broadcasts to all (renderer will filter).
      captured!(makeInstance('b-ws', { workspaceId: 'ws-1' }))
      expect(recorder.pushes).toHaveLength(1)
      expect(recorder.pushes[0].target).toEqual({ to: 'all' })

      // Unbound instance also broadcasts to all.
      captured!(makeInstance('b-unbound', { workspaceId: null }))
      expect(recorder.pushes).toHaveLength(2)
      expect(recorder.pushes[1].target).toEqual({ to: 'all' })
    })
  })

  describe('REMOVED / INTERACTED stay broadcast-to-all', () => {
    it('REMOVED uses { to: "all" } even when the entry was workspace-scoped', async () => {
      let captured: ((id: string) => void) | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(
        recorder.server,
        makeDeps({
          instances: [],
          captureRemovedCb: (cb) => { captured = cb },
        }),
      )

      captured!('b-removed')

      expect(recorder.pushes).toHaveLength(1)
      expect(recorder.pushes[0].target).toEqual({ to: 'all' })
      // Payload is id-only — workspaces that never saw the entry simply no-op.
      expect(recorder.pushes[0].args).toEqual(['b-removed'])
    })

    it('INTERACTED uses { to: "all" }', async () => {
      let captured: ((id: string) => void) | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(
        recorder.server,
        makeDeps({
          instances: [],
          captureInteractedCb: (cb) => { captured = cb },
        }),
      )

      captured!('b-interacted')

      expect(recorder.pushes).toHaveLength(1)
      expect(recorder.pushes[0].target).toEqual({ to: 'all' })
    })
  })

  describe('LIST handler', () => {
    function callListHandler(workspaceId: string | null): BrowserInstanceInfo[] {
      const listChannel = Array.from(recorder.handlers.keys())
        .find((ch) => ch.endsWith(':list') && ch.includes('browser'))
      if (!listChannel) throw new Error('LIST handler not registered')
      const handler = recorder.handlers.get(listChannel)!
      return handler({ clientId: 'c1', workspaceId, webContentsId: null }) as BrowserInstanceInfo[]
    }

    it('returns ALL instances regardless of ctx.workspaceId (renderer filters)', async () => {
      // The server-side filter is intentionally absent: ctx.workspaceId is the
      // local Simulator window's workspace id, but remote-bridged tabs are
      // stamped with the remote server's workspace id. Filtering here would
      // hide those tabs. The renderer applies filterInstancesForWorkspace,
      // which accepts both ids.
      const instances = [
        makeInstance('local-tab', { workspaceId: 'local-ws' }),
        makeInstance('remote-tab', { workspaceId: 'remote-ws' }),
        makeInstance('unbound', { workspaceId: null }),
      ]
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(recorder.server, makeDeps({ instances }))

      expect(callListHandler('local-ws').map((i) => i.id).sort()).toEqual([
        'local-tab',
        'remote-tab',
        'unbound',
      ])
      expect(callListHandler(null).map((i) => i.id).sort()).toEqual([
        'local-tab',
        'remote-tab',
        'unbound',
      ])
    })
  })

  describe('CREATE handler', () => {
    it('rejects a transient Session binding before creating a BrowserPane', async () => {
      const created: string[] = []
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(recorder.server, makeDeps({
        instances: [],
        createForSession: (sessionId) => { created.push(sessionId) },
        assertSession: (sessionId) => {
          if (sessionId === 'module-session') throw new Error('Session is unavailable')
        },
      }))

      const handler = recorder.handlers.get(RPC_CHANNELS.browserPane.CREATE)
      if (!handler) throw new Error('CREATE handler not registered')
      expect(() => handler(
        { clientId: 'c1', workspaceId: 'workspace-1', webContentsId: 1 },
        { bindToSessionId: 'module-session' },
      )).toThrow('Session is unavailable')
      expect(created).toEqual([])
    })
  })

  describe('transient Module browser egress', () => {
    it('filters LIST/events and rejects control by an already-known instance id', async () => {
      let capturedState: ((info: BrowserInstanceInfo) => void) | null = null
      const navigated: string[] = []
      const instances = [
        makeInstance('module-browser', { ownerSessionId: 'module-session' }),
        makeInstance('ordinary-browser', { ownerSessionId: 'ordinary-session' }),
      ]
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(recorder.server, makeDeps({
        instances,
        captureStateCb: (cb) => { capturedState = cb },
        isHiddenSession: (sessionId) => sessionId === 'module-session',
        navigate: (id) => { navigated.push(id) },
      }))

      const list = recorder.handlers.get(RPC_CHANNELS.browserPane.LIST)
      if (!list) throw new Error('LIST handler not registered')
      expect((list({ clientId: 'c1' }) as BrowserInstanceInfo[]).map((entry) => entry.id))
        .toEqual(['ordinary-browser'])

      capturedState!(makeInstance('module-browser', { ownerSessionId: 'module-session' }))
      expect(recorder.pushes).toEqual([])

      const navigate = recorder.handlers.get(RPC_CHANNELS.browserPane.NAVIGATE)
      if (!navigate) throw new Error('NAVIGATE handler not registered')
      await expect(Promise.resolve(navigate(
        { clientId: 'c1', workspaceId: 'workspace-1', webContentsId: 1 },
        'module-browser',
        'https://example.com',
      ))).rejects.toThrow('Browser instance is unavailable')
      expect(navigated).toEqual([])
    })

    it('propagates BrowserPane file-URL rejection through renderer NAVIGATE RPC', async () => {
      const attempted: string[] = []
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(recorder.server, makeDeps({
        instances: [makeInstance('ordinary-browser')],
        navigate: (_id, url) => {
          attempted.push(url)
          if (url.startsWith('file:')) throw new Error('Unsupported browser navigation URL')
          return { url, title: 'Allowed' }
        },
      }))

      const navigate = recorder.handlers.get(RPC_CHANNELS.browserPane.NAVIGATE)
      if (!navigate) throw new Error('NAVIGATE handler not registered')
      const protectedUrls = [
        'file:///tmp/workspace/sessions/transient-run/session.jsonl',
        'file:///tmp/workspace/sessions/.module-agent-quarantine/recovered/session.jsonl',
      ]
      for (const protectedUrl of protectedUrls) {
        await expect(Promise.resolve(navigate(
          { clientId: 'c1', workspaceId: 'workspace-1', webContentsId: 1 },
          'ordinary-browser',
          protectedUrl,
        ))).rejects.toThrow('Unsupported browser navigation URL')
      }
      expect(attempted).toEqual(protectedUrls)
    })
  })
})
