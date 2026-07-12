#!/usr/bin/env bun
const host = process.env.SIMULATOR_MODULE_HEALTH_HOST
const port = Number(process.env.SIMULATOR_MODULE_HEALTH_PORT)
const childPidFile = process.env.SIMULATOR_FIXTURE_CHILD_PID_FILE

if (host !== '127.0.0.1' || !Number.isSafeInteger(port) || !childPidFile) process.exit(64)

const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
  stdin: 'ignore',
  stdout: 'ignore',
  stderr: 'ignore',
})
await Bun.write(childPidFile, String(child.pid))

const server = Bun.serve({
  hostname: host,
  port,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== '/health') return new Response('not found', { status: 404 })
    return Response.json({ status: 'healthy' })
  },
})

function stop(): void {
  server.stop(true)
  process.exit(0)
}

process.on('SIGTERM', stop)
process.on('SIGINT', stop)
