import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types'
import type { HandlerDeps } from '../handler-deps'
import { registerFilesHandlers } from './files'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function isWithin(rootPath: string, candidatePath: string): boolean {
  const root = resolve(rootPath)
  const candidate = resolve(candidatePath)
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

function createHarness(protectedRoot: string) {
  const handlers = new Map<string, HandlerFn>()
  const imageInputs: unknown[] = []
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  const deps = {
    sessionManager: {
      async assertRendererPathAccess(filePath: string) {
        const { realpath } = await import('node:fs/promises')
        const canonical = await realpath(filePath).catch(() => resolve(filePath))
        const canonicalRoot = await realpath(protectedRoot).catch(() => resolve(protectedRoot))
        const blocked = isWithin(canonicalRoot, canonical)
        if (blocked) throw new Error('Path is unavailable')
      },
      assertRendererSessionAccess() {},
    },
    platform: {
      appRootPath: '/',
      resourcesPath: '/',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      imageProcessor: {
        async getMetadata() { return null },
        async process(input: unknown) {
          imageInputs.push(input)
          return Buffer.from('preview')
        },
      },
    },
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerFilesHandlers(server, deps)
  return { handlers, imageInputs }
}

const ctx: RequestContext = {
  clientId: 'renderer-client',
  workspaceId: null,
  webContentsId: 1,
}

describe('renderer transient Session filesystem isolation', () => {
  it('filters enumeration and rejects every read alias for a real Module Session tree', async () => {
    const workspaceRoot = await mkdtemp(join(homedir(), '.renderer-path-isolation-'))
    temporaryRoots.push(workspaceRoot)
    const sessionsRoot = join(workspaceRoot, 'sessions')
    const moduleRoot = join(sessionsRoot, 'module-secret')
    const ordinaryRoot = join(sessionsRoot, 'ordinary-session')
    await mkdir(moduleRoot, { recursive: true })
    await mkdir(ordinaryRoot, { recursive: true })
    await writeFile(join(moduleRoot, 'session.jsonl'), '{"prompt":"private"}\n')
    await writeFile(join(ordinaryRoot, 'session.jsonl'), '{"prompt":"ordinary"}\n')
    const aliasRoot = join(workspaceRoot, 'module-alias')
    await symlink(moduleRoot, aliasRoot)

    const { handlers, imageInputs } = createHarness(moduleRoot)
    const invoke = async (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`Handler not registered: ${channel}`)
      return await handler(ctx, ...args)
    }

    const listing = await invoke(RPC_CHANNELS.fs.LIST_DIRECTORY, sessionsRoot) as {
      entries: Array<{ name: string }>
    }
    expect(listing.entries.map((entry) => entry.name)).toEqual(['ordinary-session'])
    await expect(invoke(RPC_CHANNELS.fs.LIST_DIRECTORY, moduleRoot)).rejects.toThrow('Path is unavailable')

    const search = await invoke(RPC_CHANNELS.fs.SEARCH, workspaceRoot, 'module') as Array<{ path: string }>
    expect(search).toEqual([])

    const directFile = join(moduleRoot, 'session.jsonl')
    const aliasFile = join(aliasRoot, 'session.jsonl')
    for (const channel of [
      RPC_CHANNELS.file.READ,
      RPC_CHANNELS.file.READ_DATA_URL,
      RPC_CHANNELS.file.READ_PREVIEW_DATA_URL,
      RPC_CHANNELS.file.READ_BINARY,
    ]) {
      await expect(invoke(channel, directFile)).rejects.toThrow('Path is unavailable')
      await expect(invoke(channel, aliasFile)).rejects.toThrow('Path is unavailable')
    }
    await expect(invoke(RPC_CHANNELS.file.READ_ATTACHMENT, directFile)).resolves.toBeNull()
    await expect(invoke(RPC_CHANNELS.file.READ_USER_ATTACHMENT, directFile)).resolves.toBeNull()
    expect(imageInputs).toEqual([])
  })
})
