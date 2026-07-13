import { dirname, join } from 'node:path'

const host = process.env.SIMULATOR_MODULE_HEALTH_HOST
const port = Number(process.env.SIMULATOR_MODULE_HEALTH_PORT)
const mode = process.env.SIMULATOR_PACKAGED_FAKE_MODE ?? 'healthy'

if (host !== '127.0.0.1' || !Number.isSafeInteger(port) || port < 1 || port > 65_535) process.exit(64)

let exitScheduled = false
const moduleRoot = join(dirname(process.execPath), '..')
const server = Bun.serve({
  hostname: host,
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/health') {
      if (mode === 'readiness-failure') return Response.json({ status: 'unhealthy' }, { status: 503 })
      if (mode === 'crash-after-ready' && !exitScheduled) {
        exitScheduled = true
        setTimeout(() => process.exit(17), 100)
      }
      return Response.json({ status: 'healthy' })
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(Bun.file(join(moduleRoot, 'frontend', 'index.html')), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
    if (url.pathname === '/resource/data.txt') return new Response(Bun.file(join(moduleRoot, 'data.txt')))
    if (url.pathname === '/crash') {
      setTimeout(() => process.exit(23), 5)
      return new Response('crashing')
    }
    return new Response('not found', { status: 404 })
  },
})

function stop(): void {
  server.stop(true)
  process.exit(0)
}

process.on('SIGTERM', stop)
process.on('SIGINT', stop)
