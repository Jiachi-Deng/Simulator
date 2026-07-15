#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'

const CDP_PORT = Number.parseInt(process.env.APP_CDP_PORT ?? '9345', 10)
const AGENT_WORKSPACE = process.env.AGENT_WORKSPACE
const DISPOSABLE_ROOT = process.env.AGENT_DISPOSABLE_ROOT
const ACCEPTANCE_OPT_IN = process.env.SIMULATOR_M1_AGENT_ACCEPTANCE
const REQUIRED_ACCEPTANCE_OPT_IN = 'disposable-profile-confirmed'
const MODEL_ID = 'simulator-m1-file-task'
const CONNECTION_SLUG = 'simulator-m1-loopback-file-task'
const FILE_NAME = 'm1-launch-checklist.md'
const INITIAL_CONTENT = [
  '# M1 Launch Checklist',
  '',
  '- [x] Packaged Agent created this file',
  '- [ ] Packaged Agent amended this file',
  '',
].join('\n')
const FINAL_CONTENT = INITIAL_CONTENT.replace(
  '- [ ] Packaged Agent amended this file',
  '- [x] Packaged Agent amended this file',
)
const FIRST_MARKER = 'M1_FIRST_TURN_COMPLETE'
const SECOND_MARKER = 'M1_SECOND_TURN_COMPLETE'
const TIMEOUT_MS = Number.parseInt(process.env.AGENT_TASK_TIMEOUT_MS ?? '90000', 10)

let disposableRootPath
let workspacePath
let outputPath

export function pathContains(parent, candidate) {
  const relation = relative(parent, candidate)
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
}

export async function canonicalPath(path) {
  const unresolved = []
  let current = resolve(path)
  while (true) {
    try {
      return resolve(await realpath(current), ...unresolved)
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
      const parent = dirname(current)
      if (parent === current) return resolve(current, ...unresolved)
      unresolved.unshift(basename(current))
      current = parent
    }
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sleep(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
}

async function waitFor(description, probe) {
  const deadline = Date.now() + TIMEOUT_MS
  let lastError
  while (Date.now() < deadline) {
    try {
      const result = await probe()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await sleep(250)
  }
  const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : ''
  throw new Error(`Timed out waiting for ${description}.${suffix}`)
}

async function readRequestJson(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > 8 * 1024 * 1024) throw new Error('Provider request exceeded 8 MiB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function completionBase() {
  return {
    id: `chatcmpl-simulator-m1-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
  }
}

function writeSse(response, chunks) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'close',
  })
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`)
  response.end('data: [DONE]\n\n')
}

function writeJsonCompletion(response, message, finishReason) {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({
    id: `chatcmpl-simulator-m1-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 16, completion_tokens: 8, total_tokens: 24 },
  }))
}

function createLoopbackProvider(evidence) {
  return createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url?.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ object: 'list', data: [{ id: MODEL_ID, object: 'model' }] }))
        return
      }
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'Not found' } }))
        return
      }

      const body = await readRequestJson(request)
      const messages = Array.isArray(body.messages) ? body.messages : []
      const lastUserIndex = messages.findLastIndex(message => message?.role === 'user')
      const userTurnCount = messages.filter(message => message?.role === 'user').length
      const hasToolResultAfterLastUser = lastUserIndex >= 0 && messages
        .slice(lastUserIndex + 1)
        .some(message => message?.role === 'tool')
      const offeredTools = Array.isArray(body.tools)
        ? body.tools.map(tool => tool?.function?.name).filter(Boolean)
        : []

      let message
      let finishReason
      let action
      if (!hasToolResultAfterLastUser && userTurnCount === 1) {
        action = 'write'
        finishReason = 'tool_calls'
        message = {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_simulator_m1_write',
            type: 'function',
            function: {
              name: 'write',
              arguments: JSON.stringify({ path: FILE_NAME, content: INITIAL_CONTENT }),
            },
          }],
        }
      } else if (hasToolResultAfterLastUser && userTurnCount === 1) {
        action = 'first-complete'
        finishReason = 'stop'
        message = { role: 'assistant', content: FIRST_MARKER }
      } else if (!hasToolResultAfterLastUser && userTurnCount >= 2) {
        action = 'edit'
        finishReason = 'tool_calls'
        message = {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_simulator_m1_edit',
            type: 'function',
            function: {
              name: 'edit',
              arguments: JSON.stringify({
                path: FILE_NAME,
                edits: [{
                  oldText: '- [ ] Packaged Agent amended this file',
                  newText: '- [x] Packaged Agent amended this file',
                }],
              }),
            },
          }],
        }
      } else {
        action = 'second-complete'
        finishReason = 'stop'
        message = { role: 'assistant', content: SECOND_MARKER }
      }

      evidence.requests.push({
        action,
        userTurnCount,
        roles: messages.map(item => item?.role ?? 'unknown'),
        offeredWrite: offeredTools.includes('write'),
        offeredEdit: offeredTools.includes('edit'),
        stream: body.stream === true,
      })

      if (body.stream !== true) {
        writeJsonCompletion(response, message, finishReason)
        return
      }

      const base = completionBase()
      if (message.tool_calls) {
        writeSse(response, [
          {
            ...base,
            choices: [{
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: message.tool_calls.map((toolCall, index) => ({ index, ...toolCall })),
              },
              finish_reason: null,
            }],
          },
          {
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 16, completion_tokens: 8, total_tokens: 24 },
          },
        ])
      } else {
        writeSse(response, [
          {
            ...base,
            choices: [{
              index: 0,
              delta: { role: 'assistant', content: message.content },
              finish_reason: null,
            }],
          },
          {
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 16, completion_tokens: 8, total_tokens: 24 },
          },
        ])
      }
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }))
    }
  })
}

async function listenLoopback(server) {
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
    throw new Error(`Provider did not bind to 127.0.0.1: ${JSON.stringify(address)}`)
  }
  return address.port
}

async function closeServer(server) {
  if (!server.listening) return
  await new Promise((resolvePromise, reject) => {
    server.close(error => error ? reject(error) : resolvePromise())
    server.closeAllConnections?.()
  })
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url)
    this.nextId = 1
    this.pending = new Map()
  }

  async connect() {
    await new Promise((resolvePromise, reject) => {
      this.socket.once('open', resolvePromise)
      this.socket.once('error', reject)
    })
    this.socket.on('message', data => {
      const message = JSON.parse(data.toString())
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    this.socket.on('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('CDP connection closed'))
      this.pending.clear()
    })
    await this.send('Runtime.enable')
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject })
      this.socket.send(JSON.stringify({ id, method, params }), error => {
        if (!error) return
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? 'Unknown renderer exception'
      throw new Error(detail)
    }
    return result.result?.value
  }

  close() {
    this.socket.close()
  }
}

async function findRendererTarget() {
  const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
  if (!response.ok) throw new Error(`CDP target discovery failed: HTTP ${response.status}`)
  const targets = await response.json()
  const target = targets.find(item =>
    item.type === 'page'
    && typeof item.url === 'string'
    && item.url.includes('/dist/renderer/index.html'),
  )
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`Could not find the Simulator renderer target on port ${CDP_PORT}`)
  }
  return target
}

function apiCall(method, ...args) {
  return `(async () => {
    const api = window.electronAPI;
    if (!api || typeof api[${JSON.stringify(method)}] !== 'function') {
      throw new Error(${JSON.stringify(`Renderer API method is unavailable: ${method}`)});
    }
    return await api[${JSON.stringify(method)}](...${JSON.stringify(args)});
  })()`
}

function sessionProbeExpression(sessionId, marker) {
  return `(async () => {
    const session = await window.electronAPI.getSessionMessages(${JSON.stringify(sessionId)});
    const serializedMessages = JSON.stringify(session?.messages ?? []);
    return {
      found: Boolean(session),
      isProcessing: session?.isProcessing ?? null,
      markerFound: serializedMessages.includes(${JSON.stringify(marker)}),
      roles: (session?.messages ?? []).map(message => message.role),
      messageCount: session?.messages?.length ?? 0,
      workingDirectory: session?.workingDirectory ?? null,
      llmConnection: session?.llmConnection ?? null,
      model: session?.model ?? null,
    };
  })()`
}

async function waitForFileContent(expected) {
  return waitFor(`file ${outputPath} to match expected content`, async () => {
    const content = await readFile(outputPath, 'utf8')
    return content === expected ? content : false
  })
}

async function waitForTurn(cdp, sessionId, marker) {
  return waitFor(`Agent turn marker ${marker}`, async () => {
    const snapshot = await cdp.evaluate(sessionProbeExpression(sessionId, marker))
    return snapshot?.found && snapshot.markerFound && snapshot.isProcessing === false
      ? snapshot
      : false
  })
}

async function main() {
  if (!Number.isInteger(CDP_PORT) || CDP_PORT < 1 || CDP_PORT > 65535) {
    throw new Error(`APP_CDP_PORT must be a valid TCP port, received ${process.env.APP_CDP_PORT ?? ''}`)
  }
  if (ACCEPTANCE_OPT_IN !== REQUIRED_ACCEPTANCE_OPT_IN) {
    throw new Error(`SIMULATOR_M1_AGENT_ACCEPTANCE must equal ${REQUIRED_ACCEPTANCE_OPT_IN}`)
  }
  if (!DISPOSABLE_ROOT || !isAbsolute(DISPOSABLE_ROOT)) {
    throw new Error('AGENT_DISPOSABLE_ROOT must be an absolute path')
  }
  if (!AGENT_WORKSPACE || !isAbsolute(AGENT_WORKSPACE)) {
    throw new Error('AGENT_WORKSPACE must be an absolute path')
  }

  disposableRootPath = await canonicalPath(DISPOSABLE_ROOT)
  workspacePath = await canonicalPath(AGENT_WORKSPACE)
  outputPath = resolve(workspacePath, FILE_NAME)
  if (!pathContains(disposableRootPath, workspacePath)) {
    throw new Error('AGENT_WORKSPACE must be canonically inside AGENT_DISPOSABLE_ROOT')
  }
  if (outputPath === workspacePath || !pathContains(workspacePath, outputPath)) {
    throw new Error('Acceptance output escaped AGENT_WORKSPACE')
  }

  await mkdir(workspacePath, { recursive: true, mode: 0o700 })
  await rm(outputPath, { force: true })

  const evidence = { requests: [] }
  const provider = createLoopbackProvider(evidence)
  let cdp
  let previousDefaultSlug
  let defaultRestored = false
  try {
    const providerPort = await listenLoopback(provider)
    const target = await findRendererTarget()
    cdp = new CdpClient(target.webSocketDebuggerUrl)
    await cdp.connect()

    const debugMode = await cdp.evaluate(apiCall('isDebugMode'))
    const workspaces = await cdp.evaluate(apiCall('getWorkspaces'))
    if (!Array.isArray(workspaces) || workspaces.length === 0) throw new Error('Packaged app returned no workspaces')
    let outsideDisposableRoot
    for (const item of workspaces) {
      if (typeof item?.rootPath !== 'string'
        || !pathContains(disposableRootPath, await canonicalPath(item.rootPath))) {
        outsideDisposableRoot = item
        break
      }
    }
    if (outsideDisposableRoot) {
      throw new Error(`Refusing non-disposable Simulator profile: ${JSON.stringify({
        workspaceId: outsideDisposableRoot.id,
        rootPath: outsideDisposableRoot.rootPath,
      })}`)
    }

    const existingConnections = await cdp.evaluate(apiCall('listLlmConnectionsWithStatus'))
    if (!Array.isArray(existingConnections)) throw new Error('Could not inspect existing LLM connections')
    previousDefaultSlug = existingConnections.find(item => item?.isDefault === true)?.slug

    const connection = {
      slug: CONNECTION_SLUG,
      name: 'Simulator M1 Loopback File Task',
      providerType: 'pi_compat',
      authType: 'none',
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      defaultModel: MODEL_ID,
      piAuthProvider: 'openai',
      customEndpoint: { api: 'openai-completions', supportsImages: false },
      models: [MODEL_ID],
      modelSelectionMode: 'userDefined3Tier',
      createdAt: Date.now(),
    }
    const saveResult = await cdp.evaluate(apiCall('saveLlmConnection', connection))
    if (!saveResult?.success) throw new Error(`Could not save loopback connection: ${saveResult?.error ?? 'unknown error'}`)
    const defaultResult = await cdp.evaluate(apiCall('setDefaultLlmConnection', CONNECTION_SLUG))
    if (!defaultResult?.success) throw new Error(`Could not select loopback connection: ${defaultResult?.error ?? 'unknown error'}`)

    const urlWorkspaceId = new URL(target.url).searchParams.get('workspaceId')
    const workspace = workspaces.find(item => item.id === urlWorkspaceId) ?? workspaces[0]
    const session = await cdp.evaluate(apiCall('createSession', workspace.id, {
      name: 'M1 packaged Agent real file task',
      permissionMode: 'allow-all',
      workingDirectory: workspacePath,
      model: MODEL_ID,
      llmConnection: CONNECTION_SLUG,
      systemPromptPreset: 'mini',
    }))
    if (!session?.id) throw new Error(`Session creation returned no id: ${JSON.stringify(session)}`)

    await cdp.evaluate(apiCall(
      'sendMessage',
      session.id,
      `Use the write tool to create ${FILE_NAME} as the M1 launch checklist.`,
    ))
    const initialFile = await waitForFileContent(INITIAL_CONTENT)
    const firstTurn = await waitForTurn(cdp, session.id, FIRST_MARKER)

    await cdp.evaluate(apiCall(
      'sendMessage',
      session.id,
      `Use the edit tool to mark the amended item complete in ${FILE_NAME}.`,
    ))
    const finalFile = await waitForFileContent(FINAL_CONTENT)
    const secondTurn = await waitForTurn(cdp, session.id, SECOND_MARKER)
    const fileStat = await stat(outputPath)

    if (previousDefaultSlug && previousDefaultSlug !== CONNECTION_SLUG) {
      const restoreResult = await cdp.evaluate(apiCall('setDefaultLlmConnection', previousDefaultSlug))
      if (!restoreResult?.success) throw new Error(`Could not restore prior default connection: ${restoreResult?.error ?? 'unknown error'}`)
      defaultRestored = true
    } else {
      defaultRestored = true
    }

    const requiredActions = ['write', 'first-complete', 'edit', 'second-complete']
    const actualActions = evidence.requests.map(request => request.action)
    if (JSON.stringify(actualActions.slice(0, 4)) !== JSON.stringify(requiredActions)) {
      throw new Error(`Unexpected provider request sequence: ${JSON.stringify(actualActions)}`)
    }
    if (!evidence.requests.every(request => request.offeredWrite && request.offeredEdit)) {
      throw new Error(`Packaged Agent did not offer both write and edit tools: ${JSON.stringify(evidence.requests)}`)
    }

    console.log(JSON.stringify({
      ok: true,
      cdp: { port: CDP_PORT, targetId: target.id, title: target.title },
      safety: {
        explicitAcceptanceOptIn: true,
        disposableRoot: disposableRootPath,
        allWorkspaceRootsDisposable: true,
        debugMode,
        previousDefaultSlug: previousDefaultSlug ?? null,
        priorDefaultRestored: defaultRestored,
      },
      provider: {
        host: '127.0.0.1',
        port: providerPort,
        requestCount: evidence.requests.length,
        requests: evidence.requests,
      },
      workspace: { id: workspace.id, acceptancePath: workspacePath },
      session: {
        id: session.id,
        permissionMode: session.permissionMode,
        workingDirectory: secondTurn.workingDirectory,
        llmConnection: secondTurn.llmConnection,
        model: secondTurn.model,
        firstTurnMessageCount: firstTurn.messageCount,
        finalMessageCount: secondTurn.messageCount,
        finalRoles: secondTurn.roles,
      },
      file: {
        path: outputPath,
        bytes: fileStat.size,
        initialSha256: sha256(initialFile),
        finalSha256: sha256(finalFile),
        finalContent: finalFile,
      },
    }, null, 2))
  } finally {
    if (cdp && !defaultRestored && previousDefaultSlug && previousDefaultSlug !== CONNECTION_SLUG) {
      await cdp.evaluate(apiCall('setDefaultLlmConnection', previousDefaultSlug)).catch(() => undefined)
    }
    cdp?.close()
    await closeServer(provider)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack : error)
    process.exitCode = 1
  })
}
