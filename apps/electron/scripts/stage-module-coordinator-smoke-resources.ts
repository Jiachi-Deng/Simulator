import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const electronRoot = resolve(import.meta.dir, '..')
const repoRoot = resolve(electronRoot, '..', '..')

function requirePath(path: string, label: string): string {
  if (!existsSync(path)) throw new Error(`Missing ${label}: ${path}`)
  return path
}

function replaceDirectory(source: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  cpSync(source, destination, { recursive: true })
}

const anthropicRoot = join(electronRoot, 'node_modules', '@anthropic-ai')
const vscodeRoot = join(electronRoot, 'node_modules', '@vscode')
mkdirSync(anthropicRoot, { recursive: true })
mkdirSync(vscodeRoot, { recursive: true })

replaceDirectory(
  requirePath(join(repoRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'), 'Claude SDK'),
  join(anthropicRoot, 'claude-agent-sdk'),
)
const binaryPackage = `claude-agent-sdk-${process.platform}-${process.arch}`
const binaryDestination = join(anthropicRoot, 'claude-agent-sdk-binary')
replaceDirectory(
  requirePath(join(repoRoot, 'node_modules', '@anthropic-ai', binaryPackage), 'Claude SDK native package'),
  binaryDestination,
)
const claudeBinary = join(binaryDestination, process.platform === 'win32' ? 'claude.exe' : 'claude')
if (process.platform !== 'win32') chmodSync(requirePath(claudeBinary, 'Claude executable'), 0o755)

replaceDirectory(
  requirePath(join(repoRoot, 'node_modules', '@vscode', 'ripgrep'), 'ripgrep package'),
  join(vscodeRoot, 'ripgrep'),
)

const bunRoot = join(electronRoot, 'vendor', 'bun')
rmSync(bunRoot, { recursive: true, force: true })
mkdirSync(bunRoot, { recursive: true })
const bunDestination = join(bunRoot, process.platform === 'win32' ? 'bun.exe' : 'bun')
cpSync(requirePath(process.execPath, 'Bun runtime'), bunDestination)
if (process.platform !== 'win32') chmodSync(bunDestination, 0o755)

const piDestination = join(electronRoot, 'resources', 'pi-agent-server')
rmSync(piDestination, { recursive: true, force: true })
mkdirSync(piDestination, { recursive: true })
cpSync(
  requirePath(join(repoRoot, 'packages', 'pi-agent-server', 'dist', 'index.js'), 'Pi Agent server bundle'),
  join(piDestination, 'index.js'),
)
replaceDirectory(
  requirePath(join(repoRoot, 'node_modules', 'koffi'), 'koffi package'),
  join(piDestination, 'node_modules', 'koffi'),
)

console.log(`Staged packaged Coordinator smoke resources for ${process.platform}-${process.arch}`)
