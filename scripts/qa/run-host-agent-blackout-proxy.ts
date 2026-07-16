#!/usr/bin/env bun
import { lstat, readFile } from 'node:fs/promises'
import { HostAgentBlackoutProxy } from './host-agent-blackout-proxy'

interface Arguments {
  upstreamBaseUrl: string
  tokenFile: string
  blackoutMs: number
  heartbeatMs: number
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  if (!value || !/^[1-9][0-9]*$/.test(value)) throw new TypeError(`${name} must be a positive integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`${name} is too large`)
  return parsed
}

function parseArguments(argv: readonly string[]): Arguments {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value || values.has(key)) throw new TypeError('Invalid arguments')
    values.set(key, value)
  }
  const allowed = new Set(['--upstream', '--token-file', '--blackout-ms', '--heartbeat-ms'])
  if ([...values.keys()].some((key) => !allowed.has(key))) throw new TypeError('Unknown argument')
  const upstreamBaseUrl = values.get('--upstream')
  const tokenFile = values.get('--token-file')
  if (!upstreamBaseUrl || !tokenFile || !tokenFile.startsWith('/')) throw new TypeError('Missing required arguments')
  return {
    upstreamBaseUrl,
    tokenFile,
    blackoutMs: values.has('--blackout-ms')
      ? parsePositiveInteger(values.get('--blackout-ms'), '--blackout-ms')
      : 65_000,
    heartbeatMs: values.has('--heartbeat-ms')
      ? parsePositiveInteger(values.get('--heartbeat-ms'), '--heartbeat-ms')
      : 10_000,
  }
}

async function readOwnerOnlyToken(path: string): Promise<string> {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new TypeError('Token file must be a regular file')
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new TypeError('Token file owner is invalid')
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new TypeError('Token file must be owner-only')
  }
  return (await readFile(path, 'utf8')).replace(/\n$/u, '')
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2))
  const proxy = new HostAgentBlackoutProxy({
    upstreamBaseUrl: args.upstreamBaseUrl,
    bearerToken: await readOwnerOnlyToken(args.tokenFile),
    blackoutMs: args.blackoutMs,
    heartbeatMs: args.heartbeatMs,
  })
  const address = await proxy.start()
  process.stdout.write(`${JSON.stringify({
    status: 'ready',
    pid: process.pid,
    url: address.url,
    blackoutMs: args.blackoutMs,
    heartbeatMs: args.heartbeatMs,
  })}\n`)

  await new Promise<void>((resolve) => {
    const stop = (): void => { resolve() }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  await proxy.stop()
}

void main().catch(() => {
  process.stderr.write('[host-agent-blackout-proxy] FAILED\n')
  process.exitCode = 1
})
