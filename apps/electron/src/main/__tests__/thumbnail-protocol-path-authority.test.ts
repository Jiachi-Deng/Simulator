import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

type ThumbnailHandler = (request: Request) => Promise<Response>

let registeredHandler: ThumbnailHandler | undefined
const createThumbnailFromPath = mock(async () => ({
  isEmpty: () => false,
  toPNG: () => Buffer.from('thumbnail-png'),
}))
const createFromPath = mock(() => {
  const image = {
    isEmpty: () => false,
    resize: () => image,
    toPNG: () => Buffer.from('thumbnail-png'),
  }
  return image
})

mock.module('electron', () => ({
  protocol: {
    registerSchemesAsPrivileged: () => {},
    handle: (_scheme: string, handler: ThumbnailHandler) => {
      registeredHandler = handler
    },
  },
  nativeImage: {
    createThumbnailFromPath,
    createFromPath,
  },
}))

mock.module('electron-log/main', () => {
  const scopedLog = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }
  return {
    default: {
      transports: {
        file: {},
        console: {},
      },
      scope: () => scopedLog,
    },
  }
})

const { registerThumbnailHandler } = await import('../thumbnail-protocol')

const tempRoots: string[] = []

function containsPath(rootPath: string, candidatePath: string): boolean {
  const root = resolve(rootPath)
  const candidate = resolve(candidatePath)
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

async function makePreviewableFile(...segments: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'simulator-thumbnail-authority-'))
  tempRoots.push(root)
  const filePath = join(root, ...segments)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, Buffer.from('image'))
  return filePath
}

function thumbnailRequest(filePath: string): Request {
  return new Request(`thumbnail://thumb/${encodeURIComponent(filePath)}`)
}

function getHandler(): ThumbnailHandler {
  if (!registeredHandler) throw new Error('thumbnail handler was not registered')
  return registeredHandler
}

beforeEach(() => {
  registeredHandler = undefined
  createThumbnailFromPath.mockClear()
  createFromPath.mockClear()
})

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

describe('thumbnail protocol renderer path authority', () => {
  it('rejects a live transient Module session path before thumbnail generation', async () => {
    const filePath = await makePreviewableFile('sessions', 'module-live', 'preview.png')
    const transientRoot = dirname(filePath)
    const assertRendererPathAccess = mock(async (candidate: string) => {
      if (containsPath(transientRoot, candidate)) throw new Error('Path is unavailable')
    })
    registerThumbnailHandler(assertRendererPathAccess)

    const response = await getHandler()(thumbnailRequest(filePath))

    expect(response.status).toBe(404)
    expect(assertRendererPathAccess).toHaveBeenCalledTimes(1)
    expect(createThumbnailFromPath).not.toHaveBeenCalled()
    expect(createFromPath).not.toHaveBeenCalled()
  })

  it('rejects a Module quarantine path before thumbnail generation', async () => {
    const filePath = await makePreviewableFile(
      'sessions',
      '.module-agent-quarantine',
      'recovered',
      'preview.png',
    )
    const quarantineRoot = dirname(dirname(filePath))
    const assertRendererPathAccess = mock(async (candidate: string) => {
      if (containsPath(quarantineRoot, candidate)) throw new Error('Path is unavailable')
    })
    registerThumbnailHandler(assertRendererPathAccess)

    const response = await getHandler()(thumbnailRequest(filePath))

    expect(response.status).toBe(404)
    expect(assertRendererPathAccess).toHaveBeenCalledTimes(1)
    expect(createThumbnailFromPath).not.toHaveBeenCalled()
    expect(createFromPath).not.toHaveBeenCalled()
  })

  it('rechecks path authority before serving a previously cached thumbnail', async () => {
    const filePath = await makePreviewableFile('ordinary', 'preview.png')
    let denied = false
    const assertRendererPathAccess = mock(async () => {
      if (denied) throw new Error('Path is unavailable')
    })
    registerThumbnailHandler(assertRendererPathAccess)

    const firstResponse = await getHandler()(thumbnailRequest(filePath))
    expect(firstResponse.status).toBe(200)
    expect((await firstResponse.arrayBuffer()).byteLength).toBeGreaterThan(0)
    const generationCount = createThumbnailFromPath.mock.calls.length + createFromPath.mock.calls.length
    expect(generationCount).toBe(1)

    denied = true
    const cachedResponse = await getHandler()(thumbnailRequest(filePath))

    expect(cachedResponse.status).toBe(404)
    expect(assertRendererPathAccess).toHaveBeenCalledTimes(2)
    expect(createThumbnailFromPath.mock.calls.length + createFromPath.mock.calls.length).toBe(1)
  })
})
