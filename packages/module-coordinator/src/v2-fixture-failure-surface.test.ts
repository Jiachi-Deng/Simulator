import { afterEach, describe, expect, it } from 'bun:test'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const fixturePath = resolve(
  import.meta.dir,
  '..',
  'fixtures',
  'packaged-fake-module',
  'bin',
  'module-v2.ts',
)
const temporaryRoots: string[] = []
const children = new Set<ReturnType<typeof Bun.spawn>>()

afterEach(async () => {
  for (const child of children) {
    child.kill('SIGKILL')
    await child.exited.catch(() => undefined)
  }
  children.clear()
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test port unavailable')
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()))
  return address.port
}

async function makeRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'simulator-v2-fixture-failure-')))
  temporaryRoots.push(root)
  return root
}

async function compileShim(root: string, body: string): Promise<string> {
  const source = join(root, 'shim.ts')
  const executable = join(root, process.platform === 'win32' ? 'shim.exe' : 'shim')
  await writeFile(source, body)
  const build = Bun.spawnSync([
    process.execPath,
    'build',
    '--compile',
    source,
    '--outfile',
    executable,
  ], { stdout: 'ignore', stderr: 'ignore' })
  if (build.exitCode !== 0) throw new Error('test shim compilation failed')
  if (process.platform !== 'win32') await chmod(executable, 0o700)
  return executable
}

async function invokeFixture(overrides: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const port = await freePort()
  const environment: Record<string, string> = Object.fromEntries(
    Object.entries({
      ...process.env,
      SIMULATOR_MODULE_HEALTH_HOST: '127.0.0.1',
      SIMULATOR_MODULE_HEALTH_PORT: String(port),
      SIMULATOR_HOST_AGENT_CONTRACT_VERSION: '2',
      SIMULATOR_HOST_AGENT_URL: 'http://127.0.0.1:45991/',
      ...overrides,
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  const child = Bun.spawn([process.execPath, fixturePath], {
    env: environment,
    stdout: 'ignore',
    stderr: 'ignore',
  })
  children.add(child)

  let response: Response | undefined
  const deadline = Date.now() + 5_000
  while (!response && Date.now() < deadline) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/host-agent-smoke`)
    } catch {
      await Bun.sleep(20)
    }
  }
  if (!response) throw new Error('fixture did not become ready')
  const result = await response.json() as Record<string, unknown>
  child.kill('SIGTERM')
  await child.exited
  children.delete(child)
  return result
}

function expectClosedFailure(
  result: Record<string, unknown>,
  expected: { code: string; bytes?: number; status?: number },
  forbidden: readonly string[],
): void {
  expect(Object.keys(result).sort()).toEqual([
    'acceptanceScope',
    'failure',
    'ok',
    'protocolFixture',
  ])
  expect(result.ok).toBe(false)
  expect(result.failure).toEqual(expected)
  expect(Object.keys(result.failure as Record<string, unknown>).every((key) => (
    key === 'code' || key === 'bytes' || key === 'status'
  ))).toBe(true)
  const serialized = JSON.stringify(result)
  for (const value of forbidden) expect(serialized).not.toContain(value)
}

describe('packaged v2 fixture failure surface', () => {
  it('maps missing and unreadable token files to one fixed code without returning the path', async () => {
    const root = await makeRoot()
    const shim = await compileShim(root, 'process.exit(0)')
    const dataRoot = join(root, 'data')
    const missingToken = join(root, 'missing-secret-token')
    const missing = await invokeFixture({
      SIMULATOR_HOST_AGENT_TOKEN_FILE: missingToken,
      SIMULATOR_HOST_AGENT_SHIM_PATH: shim,
      SIMULATOR_MODULE_DATA_ROOT: dataRoot,
    })
    expectClosedFailure(missing, { code: 'TOKEN_FILE_UNAVAILABLE' }, [missingToken, shim, dataRoot])

    const unreadableToken = join(root, 'unreadable-secret-token')
    if (process.platform === 'win32') {
      await mkdir(unreadableToken)
    } else {
      await writeFile(unreadableToken, 'owner-only-secret')
      await chmod(unreadableToken, 0o000)
    }
    const unreadable = await invokeFixture({
      SIMULATOR_HOST_AGENT_TOKEN_FILE: unreadableToken,
      SIMULATOR_HOST_AGENT_SHIM_PATH: shim,
      SIMULATOR_MODULE_DATA_ROOT: dataRoot,
    })
    expectClosedFailure(unreadable, { code: 'TOKEN_FILE_UNAVAILABLE' }, [unreadableToken, 'owner-only-secret'])
  })

  it('maps missing and non-executable Shim files to one fixed code without returning the path', async () => {
    const root = await makeRoot()
    const token = join(root, 'token')
    await writeFile(token, 'x'.repeat(64), { mode: 0o600 })
    if (process.platform !== 'win32') await chmod(token, 0o600)
    const missingShim = join(root, 'missing-shim')
    const dataRoot = join(root, 'data')
    const missing = await invokeFixture({
      SIMULATOR_HOST_AGENT_TOKEN_FILE: token,
      SIMULATOR_HOST_AGENT_SHIM_PATH: missingShim,
      SIMULATOR_MODULE_DATA_ROOT: dataRoot,
    })
    expectClosedFailure(missing, { code: 'SHIM_UNAVAILABLE' }, [token, missingShim, dataRoot])

    const unreadableShim = process.platform === 'win32'
      ? join(root, 'shim-directory')
      : await compileShim(root, 'process.exit(0)')
    if (process.platform === 'win32') await mkdir(unreadableShim)
    else await chmod(unreadableShim, 0o600)
    const unreadable = await invokeFixture({
      SIMULATOR_HOST_AGENT_TOKEN_FILE: token,
      SIMULATOR_HOST_AGENT_SHIM_PATH: unreadableShim,
      SIMULATOR_MODULE_DATA_ROOT: dataRoot,
    })
    expectClosedFailure(unreadable, { code: 'SHIM_UNAVAILABLE' }, [token, unreadableShim])
  })

  it('maps unusable data roots to a fixed code without returning filesystem diagnostics', async () => {
    const root = await makeRoot()
    const token = join(root, 'token')
    await writeFile(token, 'x'.repeat(64), { mode: 0o600 })
    if (process.platform !== 'win32') await chmod(token, 0o600)
    const shim = await compileShim(root, 'process.exit(0)')
    const blockingFile = join(root, 'not-a-directory')
    await writeFile(blockingFile, 'private-data-root-marker')
    const dataRoot = join(blockingFile, 'child')
    const result = await invokeFixture({
      SIMULATOR_HOST_AGENT_TOKEN_FILE: token,
      SIMULATOR_HOST_AGENT_SHIM_PATH: shim,
      SIMULATOR_MODULE_DATA_ROOT: dataRoot,
    })
    expectClosedFailure(result, { code: 'DATA_ROOT_UNAVAILABLE' }, [token, shim, dataRoot, 'private-data-root-marker'])
  })

  it('reduces malicious prompt-reflecting stderr to code, byte length, and status', async () => {
    const root = await makeRoot()
    const token = join(root, 'token')
    await writeFile(token, 'x'.repeat(64), { mode: 0o600 })
    if (process.platform !== 'win32') await chmod(token, 0o600)
    const shim = await compileShim(root, [
      'const prompt = await Bun.stdin.text()',
      'process.stderr.write(prompt)',
      'process.exit(23)',
    ].join('\n'))
    const result = await invokeFixture({
      SIMULATOR_HOST_AGENT_TOKEN_FILE: token,
      SIMULATOR_HOST_AGENT_SHIM_PATH: shim,
      SIMULATOR_MODULE_DATA_ROOT: join(root, 'data'),
    })
    const prompt = 'OpenDesign packaged Shim one-Turn Session one'
    expectClosedFailure(result, {
      code: 'INTERNAL_ERROR',
      bytes: Buffer.byteLength(prompt),
      status: 23,
    }, [token, shim, prompt])
  })
})
