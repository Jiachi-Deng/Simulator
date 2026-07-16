import { afterEach, describe, expect, it } from 'bun:test'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HOST_AGENT_CONTRACT_VERSION,
  parseHostAgentEvent,
  parseHostAgentRunSnapshot,
  type HostAgentEvent,
  type HostAgentRunState,
} from '@simulator/host-agent-contract'
import { runHostAgentShim } from './shim'

const RUN = 'run_00000000000000000000000000000001'
const TOKEN = 'fixture-token-0123456789-abcdefghijkl'
const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const temporaryRoots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

class Capture extends Writable {
  value = ''
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.value += chunk.toString()
    callback()
  }
}

function snapshot(state: HostAgentRunState) {
  const terminal = ['completed', 'failed', 'interrupted', 'closing', 'closed'].includes(state)
  return parseHostAgentRunSnapshot({
    contractVersion: HOST_AGENT_CONTRACT_VERSION,
    runHandle: RUN,
    state,
    createdAt: 1,
    updatedAt: state === 'closed' ? 3 : terminal ? 2 : 1,
    ...(terminal ? { terminalAt: 2 } : {}),
    ...(state === 'closed' ? { closedAt: 3 } : {}),
  })
}

function event(sequence: number, type: HostAgentEvent['type'], data: HostAgentEvent['data']): HostAgentEvent {
  return parseHostAgentEvent({
    contractVersion: HOST_AGENT_CONTRACT_VERSION,
    eventId: String(sequence),
    sequence,
    runHandle: RUN,
    occurredAt: sequence,
    type,
    data,
  })
}

const accepted = event(1, 'run.accepted', {})
const started = event(2, 'turn.started', {})
const delta = event(3, 'message.delta', { delta: 'hello' })
const completed = event(4, 'turn.completed', { finalText: 'hello' })
const closed = event(5, 'run.closed', {})

async function fixtureFiles(mode = 0o600) {
  const root = await mkdtemp(join(tmpdir(), 'host-agent-shim-'))
  temporaryRoots.push(root)
  const entryPath = join(root, 'simulator-host-agent.mjs')
  const tokenPath = join(root, 'grant.token')
  await writeFile(entryPath, '#!/usr/bin/env node\n', { mode: 0o755 })
  await writeFile(tokenPath, `${TOKEN}\n`, { mode })
  await chmod(tokenPath, mode)
  return { root, entryPath, tokenPath }
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: Server; url: string }> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture did not bind')
  return { server, url: `http://127.0.0.1:${address.port}` }
}

function writeSse(response: ServerResponse, item: HostAgentEvent): void {
  response.write(`id: ${item.eventId}\nevent: host-agent.event\ndata: ${JSON.stringify(item)}\n\n`)
}

function json(response: ServerResponse, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

describe('Host Agent shim', () => {
  it('ships a standalone executable artifact with a detection-only version path', async () => {
    const artifact = join(repositoryRoot, 'apps/electron/resources/host-agent/simulator-host-agent.mjs')
    const result = await execFileAsync(process.execPath, [artifact, '--version'], {
      env: {},
      timeout: 5_000,
    })
    expect(result.stdout).toBe('simulator-host-agent 2\n')
    expect(result.stderr).toBe('')
  })

  it('streams only canonical JSONL and waits for strict DELETE/run.closed', async () => {
    const files = await fixtureFiles()
    const requests: Array<{ method: string; path: string; authorization?: string; key?: string; body: string }> = []
    let stream: ServerResponse | undefined
    const { url } = await listen((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        requests.push({
          method: request.method ?? '',
          path: request.url ?? '',
          authorization: request.headers.authorization,
          key: request.headers['idempotency-key'] as string | undefined,
          body: Buffer.concat(chunks).toString('utf8'),
        })
        if (request.method === 'POST' && request.url === '/v2/runs') {
          json(response, snapshot('accepted'))
        } else if (request.method === 'GET' && request.url === `/v2/runs/${RUN}/events`) {
          stream = response
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
          response.flushHeaders()
          writeSse(response, accepted)
          response.write(': heartbeat\n\n')
          writeSse(response, started)
          writeSse(response, delta)
          writeSse(response, completed)
        } else if (request.method === 'DELETE' && request.url === `/v2/runs/${RUN}`) {
          writeSse(stream!, closed)
          stream!.end()
          json(response, snapshot('closed'))
        } else {
          response.writeHead(404).end()
        }
      })
    })
    const stdout = new Capture()
    const stderr = new Capture()
    const code = await runHostAgentShim({
      argv: [],
      entryPath: files.entryPath,
      cwd: files.root,
      env: {
        SIMULATOR_HOST_AGENT_URL: url,
        SIMULATOR_HOST_AGENT_TOKEN_FILE: files.tokenPath,
        SIMULATOR_HOST_AGENT_SHIM_PATH: files.entryPath,
        SIMULATOR_HOST_AGENT_CONTRACT_VERSION: '2',
      },
      stdin: Readable.from(['exact prompt']),
      stdout,
      stderr,
      signal: new AbortController().signal,
    })

    expect(code).toBe(0)
    expect(stdout.value.trim().split('\n').map((line) => parseHostAgentEvent(JSON.parse(line))))
      .toEqual([accepted, started, delta, completed, closed])
    expect(stdout.value).not.toContain('heartbeat')
    expect(stderr.value).toBe('')
    expect(requests.map((item) => `${item.method} ${item.path}`)).toEqual([
      'POST /v2/runs',
      `GET /v2/runs/${RUN}/events`,
      `DELETE /v2/runs/${RUN}`,
    ])
    expect(new Set(requests.map((item) => item.authorization))).toEqual(new Set([`Bearer ${TOKEN}`]))
    expect(requests[0]?.key).toMatch(/^shim-[0-9a-f]{48}$/)
    expect(JSON.parse(requests[0]!.body)).toEqual({
      contractVersion: 2,
      prompt: 'exact prompt',
      workingDirectory: files.root,
    })
  })

  it('reconnects the same Run with Last-Event-ID and never duplicates stdout', async () => {
    const files = await fixtureFiles()
    let eventRequest = 0
    const eventRequestCursors: Array<string | undefined> = []
    let stream: ServerResponse | undefined
    const { url } = await listen((request, response) => {
      if (request.method === 'GET' && request.url === `/v2/runs/${RUN}/events`) {
        eventRequestCursors.push(request.headers['last-event-id'] as string | undefined)
      }
      request.resume()
      request.on('end', () => {
        if (request.method === 'POST' && request.url === '/v2/runs') {
          json(response, snapshot('accepted'))
        } else if (request.method === 'GET' && request.url === `/v2/runs/${RUN}/events`) {
          eventRequest += 1
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
          response.flushHeaders()
          if (eventRequest === 1) {
            writeSse(response, accepted)
            writeSse(response, started)
            writeSse(response, delta)
            response.end()
          } else {
            stream = response
            writeSse(response, completed)
          }
        } else if (request.method === 'DELETE' && request.url === `/v2/runs/${RUN}`) {
          writeSse(stream!, closed)
          stream!.end()
          json(response, snapshot('closed'))
        } else response.writeHead(404).end()
      })
    })
    const stdout = new Capture()
    const stderr = new Capture()
    const code = await runHostAgentShim({
      argv: [], entryPath: files.entryPath, cwd: files.root,
      env: {
        SIMULATOR_HOST_AGENT_URL: url,
        SIMULATOR_HOST_AGENT_TOKEN_FILE: files.tokenPath,
        SIMULATOR_HOST_AGENT_SHIM_PATH: files.entryPath,
        SIMULATOR_HOST_AGENT_CONTRACT_VERSION: '2',
      },
      stdin: Readable.from(['prompt']), stdout, stderr,
      signal: new AbortController().signal,
    })
    expect(code).toBe(0)
    expect(eventRequestCursors).toEqual([undefined, '3'])
    expect(stdout.value.trim().split('\n').map((line) => JSON.parse(line).sequence)).toEqual([1, 2, 3, 4, 5])
    expect(stderr.value).toBe('')
  })

  it('fails within a deadline and withholds success when terminal cleanup never closes', async () => {
    const files = await fixtureFiles()
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const { url } = await listen((request, response) => {
      request.resume()
      request.on('end', () => {
        if (request.method === 'POST' && request.url === '/v2/runs') {
          json(response, snapshot('accepted'))
        } else if (request.method === 'GET' && request.url === `/v2/runs/${RUN}/events`) {
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
          response.flushHeaders()
          writeSse(response, accepted)
          writeSse(response, started)
          writeSse(response, delta)
          writeSse(response, completed)
          heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 5)
          response.once('close', () => {
            if (heartbeat) clearInterval(heartbeat)
          })
        } else if (request.method === 'DELETE' && request.url === `/v2/runs/${RUN}`) {
          // Keep the response open. The SSE heartbeat must not keep the Shim
          // alive past its terminal cleanup deadline.
        } else {
          response.writeHead(404).end()
        }
      })
    })
    const stdout = new Capture()
    const stderr = new Capture()
    const startedAt = Date.now()
    const code = await runHostAgentShim({
      argv: [], entryPath: files.entryPath, cwd: files.root,
      env: {
        SIMULATOR_HOST_AGENT_URL: url,
        SIMULATOR_HOST_AGENT_TOKEN_FILE: files.tokenPath,
        SIMULATOR_HOST_AGENT_SHIM_PATH: files.entryPath,
        SIMULATOR_HOST_AGENT_CONTRACT_VERSION: '2',
      },
      stdin: Readable.from(['prompt']), stdout, stderr,
      signal: new AbortController().signal,
      terminalCloseTimeoutMs: 50,
    })
    if (heartbeat) clearInterval(heartbeat)
    expect(code).toBe(1)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(stdout.value).toContain('run.accepted')
    expect(stdout.value).toContain('turn.started')
    expect(stdout.value).not.toContain('turn.completed')
    expect(stdout.value).not.toContain('run.closed')
    expect(stderr.value).toBe('[simulator-host-agent] CLEANUP_FAILED\n')
  })

  it('cancels and strictly closes on SIGTERM without fabricating success', async () => {
    const files = await fixtureFiles()
    const calls: string[] = []
    let connected!: () => void
    const connectedPromise = new Promise<void>((resolve) => { connected = resolve })
    const { url } = await listen((request, response) => {
      request.resume()
      request.on('end', () => {
        calls.push(`${request.method} ${request.url}`)
        if (request.method === 'POST' && request.url === '/v2/runs') json(response, snapshot('accepted'))
        else if (request.method === 'GET' && request.url === `/v2/runs/${RUN}/events`) {
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
          response.flushHeaders()
          writeSse(response, accepted)
          writeSse(response, started)
          connected()
        } else if (request.method === 'POST' && request.url === `/v2/runs/${RUN}/cancel`) {
          json(response, snapshot('interrupted'))
        } else if (request.method === 'DELETE' && request.url === `/v2/runs/${RUN}`) {
          json(response, snapshot('closed'))
        } else response.writeHead(404).end()
      })
    })
    const controller = new AbortController()
    const stdout = new Capture()
    const stderr = new Capture()
    const running = runHostAgentShim({
      argv: [], entryPath: files.entryPath, cwd: files.root,
      env: {
        SIMULATOR_HOST_AGENT_URL: url,
        SIMULATOR_HOST_AGENT_TOKEN_FILE: files.tokenPath,
        SIMULATOR_HOST_AGENT_SHIM_PATH: files.entryPath,
        SIMULATOR_HOST_AGENT_CONTRACT_VERSION: '2',
      },
      stdin: Readable.from(['prompt']), stdout, stderr, signal: controller.signal,
    })
    await connectedPromise
    controller.abort()
    expect(await running).toBe(143)
    expect(calls).toContain(`POST /v2/runs/${RUN}/cancel`)
    expect(calls).toContain(`DELETE /v2/runs/${RUN}`)
    expect(stdout.value).not.toContain('turn.completed')
    expect(stderr.value).toBe('[simulator-host-agent] CANCELLED\n')
    expect(stderr.value).not.toContain(TOKEN)
    expect(stderr.value).not.toContain('prompt')
  })

  it('fails before network access when the token file is not owner-only', async () => {
    const files = await fixtureFiles(0o644)
    let fetched = false
    const stdout = new Capture()
    const stderr = new Capture()
    const code = await runHostAgentShim({
      argv: [], entryPath: files.entryPath, cwd: files.root,
      env: {
        SIMULATOR_HOST_AGENT_URL: 'http://127.0.0.1:31337',
        SIMULATOR_HOST_AGENT_TOKEN_FILE: files.tokenPath,
        SIMULATOR_HOST_AGENT_SHIM_PATH: files.entryPath,
        SIMULATOR_HOST_AGENT_CONTRACT_VERSION: '2',
      },
      stdin: Readable.from(['private prompt']), stdout, stderr,
      signal: new AbortController().signal,
      fetch: (async () => { fetched = true; throw new Error('must not fetch') }) as unknown as typeof fetch,
    })
    expect(code).toBe(1)
    expect(fetched).toBe(false)
    expect(stdout.value).toBe('')
    expect(stderr.value).toBe('[simulator-host-agent] INVALID_TOKEN_FILE\n')
    expect(stderr.value).not.toContain(files.tokenPath)
    expect(stderr.value).not.toContain('private prompt')
  })
})
