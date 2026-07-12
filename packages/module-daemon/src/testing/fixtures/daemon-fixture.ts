#!/usr/bin/env bun
const host = process.env.SIMULATOR_MODULE_HEALTH_HOST
const port = Number(process.env.SIMULATOR_MODULE_HEALTH_PORT)
const childPidFile = process.env.SIMULATOR_FIXTURE_CHILD_PID_FILE
const childStopFile = process.env.SIMULATOR_FIXTURE_CHILD_STOP_FILE
const runtime = process.env.SIMULATOR_FIXTURE_RUNTIME
const exitAfterReady = process.env.SIMULATOR_FIXTURE_EXIT_AFTER_READY === '1'

if (host !== '127.0.0.1' || !Number.isSafeInteger(port) || !childPidFile || !childStopFile || !runtime) process.exit(64)

const childProgram = `
  import { writeFileSync } from 'node:fs';
  process.on('SIGTERM', () => {
    writeFileSync(${JSON.stringify(childStopFile)}, 'graceful');
    process.exit(0);
  });
  writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));
  setInterval(() => {}, 1000);
`
Bun.spawn([runtime, '-e', childProgram], {
  stdin: 'ignore',
  stdout: 'ignore',
  stderr: 'ignore',
})
while (!await Bun.file(childPidFile).exists()) await Bun.sleep(1)

const server = Bun.serve({
  hostname: host,
  port,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== '/health') return new Response('not found', { status: 404 })
    if (exitAfterReady) setTimeout(() => process.exit(17), 10)
    return Response.json({ status: 'healthy' })
  },
})

function stop(): void {
  server.stop(true)
  process.exit(0)
}

process.on('SIGTERM', stop)
process.on('SIGINT', stop)
