import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const electronAppFlagIndex = process.argv.indexOf('--app')
const packagedApp = electronAppFlagIndex >= 0 ? process.argv[electronAppFlagIndex + 1] : undefined
if (electronAppFlagIndex >= 0 && !packagedApp) {
  throw new Error('--app requires a path to a packaged Electron app or executable')
}

const electronRoot = resolve(import.meta.dir, '..')
const repoRoot = resolve(electronRoot, '..', '..')
const fixturePath = join(electronRoot, 'test', 'fixtures', 'module-view', 'fake-local-frontend.html')
const fixture = readFileSync(fixturePath)
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'simulator-module-view-smoke-'))
const resultPath = join(temporaryDirectory, 'result.json')

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== '/index.html') return new Response('Not found', { status: 404 })
    return new Response(fixture, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      },
    })
  },
})

function resolveExecutable(appPath: string): string {
  const absolute = resolve(appPath)
  if (!absolute.endsWith('.app')) return absolute
  const productName = basename(absolute, '.app')
  return join(absolute, 'Contents', 'MacOS', productName)
}

const executable = packagedApp
  ? resolveExecutable(packagedApp)
  : join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')
const applicationArguments = packagedApp ? [] : [electronRoot]
if (!existsSync(executable)) throw new Error(`Electron executable not found: ${executable}`)

const frontendUrl = `http://127.0.0.1:${server.port}/index.html`
const processHandle = Bun.spawn([
  executable,
  ...applicationArguments,
  `--module-view-smoke-url=${frontendUrl}`,
  `--module-view-smoke-result=${resultPath}`,
], {
  cwd: repoRoot,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  stdout: 'pipe',
  stderr: 'pipe',
})

const timeout = setTimeout(() => processHandle.kill(), 25_000)
const [exitCode, stdout, stderr] = await Promise.all([
  processHandle.exited,
  new Response(processHandle.stdout).text(),
  new Response(processHandle.stderr).text(),
])
clearTimeout(timeout)
server.stop(true)

try {
  if (!existsSync(resultPath)) {
    throw new Error(`Module view smoke did not write a result (exit ${exitCode})\n${stdout}\n${stderr}`)
  }
  const result = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>
  if (exitCode !== 0 || result.ok !== true) {
    throw new Error(`Module view smoke failed (exit ${exitCode}): ${JSON.stringify(result)}\n${stdout}\n${stderr}`)
  }
  if (packagedApp && result.packaged !== true) {
    throw new Error(`Expected packaged smoke but app reported packaged=${String(result.packaged)}`)
  }
  if (!packagedApp && result.packaged !== false) {
    throw new Error(`Expected source smoke but app reported packaged=${String(result.packaged)}`)
  }
  console.log(`Module view smoke passed (${packagedApp ? 'packaged' : 'source'}): ${JSON.stringify(result)}`)
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
