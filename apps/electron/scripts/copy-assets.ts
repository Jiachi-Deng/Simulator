/**
 * Cross-platform asset staging. The Host Agent shim is rebuilt from its
 * TypeScript entrypoint on every invocation; the tracked generated artifact is
 * only a reviewed build output, never an authoritative build input.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  constants,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

export const HOST_AGENT_SHIM_RELATIVE_PATH = join('host-agent', 'simulator-host-agent.mjs')

export interface HostAgentArtifactEvidence {
  path: string
  sha256: string
  mode: number
  size: number
}

interface InspectOptions {
  executable: boolean
  allowRootOwner?: boolean
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined
}

function isSameCanonicalPath(left: string, right: string): boolean {
  return process.platform === 'win32' ? relative(left, right) === '' : left === right
}

function assertRealDirectory(path: string, label: string): void {
  const normalized = resolve(path)
  const metadata = lstatSync(normalized)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${normalized}`)
  }
  if (!isSameCanonicalPath(realpathSync(normalized), normalized)) {
    throw new Error(`${label} must not traverse symbolic links: ${normalized}`)
  }
}

export function inspectHostAgentArtifact(
  path: string,
  label: string,
  options: InspectOptions,
): HostAgentArtifactEvidence {
  const normalized = resolve(path)
  const metadata = lstatSync(normalized)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular file, not a symbolic link: ${normalized}`)
  }
  if (metadata.nlink !== 1) {
    throw new Error(`${label} must not be a hardlink: ${normalized}`)
  }
  if (!isSameCanonicalPath(realpathSync(normalized), normalized)) {
    throw new Error(`${label} path must not traverse symbolic links: ${normalized}`)
  }
  const uid = currentUid()
  if (uid !== undefined && metadata.uid !== uid && !(options.allowRootOwner && metadata.uid === 0)) {
    throw new Error(`${label} has an untrusted owner: ${normalized}`)
  }
  const mode = metadata.mode & 0o777
  if (process.platform !== 'win32') {
    if ((mode & 0o022) !== 0) throw new Error(`${label} must not be group/world writable: ${normalized}`)
    if (options.executable && mode !== 0o755) {
      throw new Error(`${label} must use executable mode 0755: ${normalized}`)
    }
  }
  if (metadata.size === 0) throw new Error(`${label} must not be empty: ${normalized}`)
  return {
    path: normalized,
    sha256: createHash('sha256').update(readFileSync(normalized)).digest('hex'),
    mode,
    size: metadata.size,
  }
}

export function assertHostAgentArtifactsMatch(
  expected: HostAgentArtifactEvidence,
  actual: HostAgentArtifactEvidence,
  label: string,
): void {
  if (actual.sha256 !== expected.sha256 || actual.mode !== expected.mode || actual.size !== expected.size) {
    throw new Error(
      `${label} differs from its build source: expected sha256=${expected.sha256} mode=${expected.mode.toString(8)} size=${expected.size}, `
      + `got sha256=${actual.sha256} mode=${actual.mode.toString(8)} size=${actual.size}`,
    )
  }
}

export function rebuildHostAgentShim(repositoryRoot: string): HostAgentArtifactEvidence {
  const root = resolve(repositoryRoot)
  const outputDirectory = join(root, 'apps/electron/resources/host-agent')
  const outputPath = join(outputDirectory, 'simulator-host-agent.mjs')
  assertRealDirectory(outputDirectory, 'Host Agent generated resource directory')

  // Refuse to let the bundler overwrite an alias, hardlink, foreign-owned file,
  // or a checkout that lost its executable bit.
  if (existsSync(outputPath)) {
    inspectHostAgentArtifact(outputPath, 'Existing Host Agent generated shim', { executable: true })
  }

  const bunExecutable = (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun
    ? process.execPath
    : (process.env.BUN_EXEC_PATH || 'bun')
  const result = spawnSync(bunExecutable, ['run', 'build'], {
    cwd: join(root, 'packages/host-agent-shim'),
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Host Agent shim build failed with exit code ${result.status ?? 'unknown'}`)

  return inspectHostAgentArtifact(outputPath, 'Fresh Host Agent generated shim', { executable: true })
}

export function copyHostAgentShim(
  sourcePath: string,
  destinationPath: string,
): { source: HostAgentArtifactEvidence; destination: HostAgentArtifactEvidence } {
  const source = inspectHostAgentArtifact(sourcePath, 'Host Agent generated shim', { executable: true })
  const destination = resolve(destinationPath)
  const destinationDirectory = dirname(destination)
  mkdirSync(destinationDirectory, { recursive: true, mode: 0o755 })
  assertRealDirectory(destinationDirectory, 'Host Agent dist resource directory')
  if (existsSync(destination)) {
    inspectHostAgentArtifact(destination, 'Existing Host Agent dist shim', { executable: true })
    rmSync(destination)
  }
  copyFileSync(source.path, destination, constants.COPYFILE_EXCL)
  if (process.platform !== 'win32') chmodSync(destination, source.mode)
  const copied = inspectHostAgentArtifact(destination, 'Host Agent dist shim', { executable: true })
  assertHostAgentArtifactsMatch(source, copied, 'Host Agent dist shim')
  return { source, destination: copied }
}

export function rebuildAndCopyHostAgentShim(
  repositoryRoot: string,
  distResourcesDirectory = join(resolve(repositoryRoot), 'apps/electron/dist/resources'),
): { source: HostAgentArtifactEvidence; destination: HostAgentArtifactEvidence } {
  const source = rebuildHostAgentShim(repositoryRoot)
  return copyHostAgentShim(source.path, join(distResourcesDirectory, HOST_AGENT_SHIM_RELATIVE_PATH))
}

export function copyElectronAssets(repositoryRoot: string): void {
  const root = resolve(repositoryRoot)
  const electronDirectory = join(root, 'apps/electron')
  const resourcesDirectory = join(electronDirectory, 'resources')
  const distResourcesDirectory = join(electronDirectory, 'dist/resources')
  const sourceShim = rebuildHostAgentShim(root)
  const distShimPath = join(distResourcesDirectory, HOST_AGENT_SHIM_RELATIVE_PATH)
  assertRealDirectory(resourcesDirectory, 'Electron source resource directory')
  mkdirSync(distResourcesDirectory, { recursive: true, mode: 0o755 })
  assertRealDirectory(distResourcesDirectory, 'Electron dist resource directory')

  if (existsSync(distShimPath)) {
    inspectHostAgentArtifact(distShimPath, 'Existing Host Agent dist shim', { executable: true })
  }

  // Do not allow a removed server from resources/ to survive in dist/resources/.
  for (const server of ['session-mcp-server', 'pi-agent-server']) {
    rmSync(join(distResourcesDirectory, server), { recursive: true, force: true })
  }

  // Do not let the recursive copy choose the handling semantics for the
  // security-sensitive executable. It is copied once with COPYFILE_EXCL below.
  cpSync(resourcesDirectory, distResourcesDirectory, {
    recursive: true,
    filter: (source) => resolve(source) !== sourceShim.path,
  })
  const copied = copyHostAgentShim(sourceShim.path, distShimPath)
  assertHostAgentArtifactsMatch(sourceShim, copied.destination, 'Host Agent dist shim')

  console.log('✓ Rebuilt Host Agent shim and copied resources/ → dist/resources/')

  const psParserSource = join(root, 'packages/shared/src/agent/powershell-parser.ps1')
  const psParserDestination = join(distResourcesDirectory, 'powershell-parser.ps1')
  try {
    copyFileSync(psParserSource, psParserDestination)
    console.log('✓ Copied powershell-parser.ps1 → dist/resources/')
  } catch {
    console.log('⚠ powershell-parser.ps1 copy skipped (not critical on non-Windows)')
  }
}

if (import.meta.main) {
  copyElectronAssets(resolve(import.meta.dir, '../../..'))
}
