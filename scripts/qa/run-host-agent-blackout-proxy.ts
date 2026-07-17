#!/usr/bin/env bun
import { lstat, readFile, realpath } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import {
  HOST_AGENT_BLACKOUT_HEARTBEAT_MS,
  HOST_AGENT_BLACKOUT_MS,
  HostAgentBlackoutProxy,
} from './host-agent-blackout-proxy'

const MAX_CONTROL_LINE_BYTES = 32 * 1024
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
type JsonRecord = Record<string, unknown>

function exactRecord(value: unknown, fields: readonly string[]): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('INVALID_CONTROL')
  const actual = Object.keys(value as JsonRecord).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new TypeError('INVALID_CONTROL')
  }
  return value as JsonRecord
}

function requestId(record: JsonRecord): string {
  if (typeof record.requestId !== 'string' || !REQUEST_ID.test(record.requestId)) {
    throw new TypeError('INVALID_REQUEST_ID')
  }
  return record.requestId
}

async function readOwnerOnlyToken(path: string): Promise<string> {
  if (!path.startsWith('/') || await realpath(path) !== path) throw new TypeError('TOKEN_FILE_INVALID')
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new TypeError('TOKEN_FILE_INVALID')
  }
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new TypeError('TOKEN_FILE_INVALID')
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new TypeError('TOKEN_FILE_INVALID')
  }
  return (await readFile(path, 'utf8')).replace(/\n$/u, '')
}

function write(value: JsonRecord): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message : 'BLACKOUT_PROXY_FAILED'
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new TypeError('ARGV_FORBIDDEN')
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })
  let proxy: HostAgentBlackoutProxy | undefined
  let initialized = false
  let stopping = false

  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    input.close()
    await proxy?.stop()
  }
  process.once('SIGINT', () => void stop())
  process.once('SIGTERM', () => void stop())

  try {
    for await (const line of input) {
      if (Buffer.byteLength(line, 'utf8') > MAX_CONTROL_LINE_BYTES || line.length === 0) {
        write({ schemaVersion: 1, type: 'error', requestId: 'invalid', code: 'INVALID_CONTROL' })
        continue
      }
      let raw: unknown
      try { raw = JSON.parse(line) } catch {
        write({ schemaVersion: 1, type: 'error', requestId: 'invalid', code: 'INVALID_CONTROL' })
        continue
      }
      let id = 'invalid'
      try {
        if (!initialized) {
          const command = exactRecord(raw, [
            'blackoutMs', 'command', 'heartbeatMs', 'requestId', 'schemaVersion', 'tokenFile', 'upstreamBaseUrl',
          ])
          id = requestId(command)
          if (command.schemaVersion !== 1 || command.command !== 'initialize'
            || command.blackoutMs !== HOST_AGENT_BLACKOUT_MS
            || command.heartbeatMs !== HOST_AGENT_BLACKOUT_HEARTBEAT_MS
            || typeof command.upstreamBaseUrl !== 'string' || typeof command.tokenFile !== 'string') {
            throw new TypeError('INITIALIZE_INVALID')
          }
          proxy = new HostAgentBlackoutProxy({
            upstreamBaseUrl: command.upstreamBaseUrl,
            bearerToken: await readOwnerOnlyToken(command.tokenFile),
            blackoutMs: HOST_AGENT_BLACKOUT_MS,
            heartbeatMs: HOST_AGENT_BLACKOUT_HEARTBEAT_MS,
          })
          const address = await proxy.start()
          initialized = true
          write({
            schemaVersion: 1,
            type: 'ready',
            requestId: id,
            producer: 'external-host-agent-sse-proxy',
            port: address.port,
            blackoutMs: HOST_AGENT_BLACKOUT_MS,
            heartbeatMs: HOST_AGENT_BLACKOUT_HEARTBEAT_MS,
          })
          continue
        }

        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)
          || Object.getPrototypeOf(raw) !== Object.prototype) throw new TypeError('INVALID_CONTROL')
        const base = exactRecord(raw, Object.hasOwn(raw, 'evidenceId')
          ? ['caseId', 'command', 'evidenceId', 'requestId', 'schemaVersion', 'turnOrdinal']
          : Object.hasOwn(raw, 'caseId')
            ? ['caseId', 'command', 'requestId', 'schemaVersion', 'stack', 'turnOrdinal']
            : ['command', 'requestId', 'schemaVersion'])
        id = requestId(base)
        if (base.schemaVersion !== 1 || !proxy) throw new TypeError('CONTROL_STATE_INVALID')
        if (base.command === 'arm') {
          const result = proxy.armNextBlackout({
            caseId: base.caseId as string,
            stack: base.stack as 'new',
            turnOrdinal: base.turnOrdinal as number,
          })
          write({ schemaVersion: 1, type: 'armed', requestId: id, result })
        } else if (base.command === 'take') {
          const result = proxy.takeBlackoutEvidence({
            evidenceId: base.evidenceId as string,
            caseId: base.caseId as string,
            turnOrdinal: base.turnOrdinal as number,
          })
          write({ schemaVersion: 1, type: 'evidence', requestId: id, result })
        } else if (base.command === 'shutdown') {
          await stop()
          write({ schemaVersion: 1, type: 'stopped', requestId: id })
          break
        } else {
          throw new TypeError('CONTROL_COMMAND_INVALID')
        }
      } catch (error) {
        write({ schemaVersion: 1, type: 'error', requestId: id, code: errorCode(error) })
      }
    }
  } finally {
    await stop()
  }
}

void main().catch(() => {
  process.stderr.write('[host-agent-blackout-proxy] FAILED\n')
  process.exitCode = 1
})
