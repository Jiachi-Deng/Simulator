#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'

const host = process.env.SIMULATOR_MODULE_HEALTH_HOST
const port = Number(process.env.SIMULATOR_MODULE_HEALTH_PORT)
const childPidFile = process.env.SIMULATOR_FIXTURE_CHILD_PID_FILE
const childStopFile = process.env.SIMULATOR_FIXTURE_CHILD_STOP_FILE
const runtime = process.env.SIMULATOR_FIXTURE_RUNTIME
const statusFile = process.env.SIMULATOR_FIXTURE_STATUS_FILE
const exitAfterReady = process.env.SIMULATOR_FIXTURE_EXIT_AFTER_READY === '1'

if (host !== '127.0.0.1' || !Number.isSafeInteger(port) || !childPidFile || !childStopFile || !runtime) process.exit(64)

function recordStatus(status: string): void {
  if (!statusFile) return
  appendFileSync(statusFile, `${Date.now()} ${status}\n`)
}

recordStatus(`boot pid=${process.pid} host=${host} port=${port}`)

const childProgram = `
  import { writeFileSync } from 'node:fs';
  process.on('SIGTERM', () => {
    writeFileSync(${JSON.stringify(childStopFile)}, 'graceful');
    process.exit(0);
  });
  writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));
  setInterval(() => {}, 1000);
`
const child = Bun.spawn([runtime, '-e', childProgram], {
  stdin: 'ignore',
  stdout: 'ignore',
  stderr: 'ignore',
})
recordStatus(`child-spawned pid=${child.pid}`)

const childReady = (async () => {
  while (!await Bun.file(childPidFile).exists()) await Bun.sleep(1)
  recordStatus('child-ready')
})()
let exitScheduled = false

const server = Bun.serve({
  hostname: host,
  port,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== '/health') return new Response('not found', { status: 404 })
    recordStatus('health-request')
    if (exitAfterReady && !exitScheduled) {
      exitScheduled = true
      void childReady.then(() => setTimeout(() => process.exit(17), 10))
    }
    return Response.json({ status: 'healthy' })
  },
})
recordStatus('health-listening')

function stop(): void {
  recordStatus('stopping')
  server.stop(true)
  process.exit(0)
}

process.on('SIGTERM', stop)
process.on('SIGINT', stop)
