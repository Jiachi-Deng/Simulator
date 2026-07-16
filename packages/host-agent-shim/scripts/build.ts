import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(packageRoot, '../..')
const outputDirectory = join(repositoryRoot, 'apps/electron/resources/host-agent')
const outputPath = join(outputDirectory, 'simulator-host-agent.mjs')
const BUNDLED_NODE_SHEBANG = '#!/usr/bin/env node\n'
export const HOST_AGENT_SHIM_BOOTSTRAP_PREFIX = [
  '#!/bin/sh',
  `':' //; shim_dir="\${0%/*}"; shim_bun="$shim_dir/../../../vendor/bun/bun"; if [ ! -x "$shim_bun" ]; then shim_bun="$shim_dir/../../vendor/bun/bun"; fi; if [ ! -x "$shim_bun" ] || ! "$shim_bun" --version >/dev/null 2>&1; then printf '%s\\n' '[simulator-host-agent] RUNTIME_UNAVAILABLE' >&2; exit 127; fi; exec "$shim_bun" "$0" "$@"; printf '%s\\n' '[simulator-host-agent] RUNTIME_UNAVAILABLE' >&2; exit 127`,
].join('\n') + '\n'

function isSameCanonicalPath(left: string, right: string): boolean {
  return process.platform === 'win32' ? relative(left, right) === '' : left === right
}

async function inspectGeneratedShim(path: string, label: string): Promise<Buffer> {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular file, not a symbolic link`)
  }
  if (metadata.nlink !== 1) throw new Error(`${label} must not be a hardlink`)
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user`)
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o755) {
    throw new Error(`${label} must use executable mode 0755`)
  }
  const bytes = await readFile(path)
  if (bytes.length === 0) throw new Error(`${label} must not be empty`)
  const bootstrap = Buffer.from(HOST_AGENT_SHIM_BOOTSTRAP_PREFIX)
  if (bytes.byteLength < bootstrap.byteLength || !bytes.subarray(0, bootstrap.byteLength).equals(bootstrap)) {
    throw new Error(`${label} must retain the Host-owned bundled Bun bootstrap`)
  }
  if (bytes.includes(Buffer.from('sourceMappingURL='))) {
    throw new Error(`${label} must not contain a source map reference`)
  }
  return bytes
}

export async function assertReplaceableGeneratedShim(path: string): Promise<void> {
  try {
    await inspectGeneratedShim(path, 'Existing Host Agent generated shim')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

async function assertOutputDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o755 })
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('Host Agent generated resource directory must be a real directory')
  }
  if (!isSameCanonicalPath(await realpath(path), path)) {
    throw new Error('Host Agent generated resource directory must not traverse symbolic links')
  }
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new Error('Host Agent generated resource directory must be owned by the current user')
  }
}

export async function buildHostAgentShim(): Promise<string> {
  await assertOutputDirectory(outputDirectory)
  await assertReplaceableGeneratedShim(outputPath)

  const temporaryDirectory = await mkdtemp(join(outputDirectory, '.simulator-host-agent-build-'))
  const temporaryOutput = join(temporaryDirectory, 'simulator-host-agent.mjs')
  try {
    const result = await Bun.build({
      entrypoints: [join(packageRoot, 'src/main.ts')],
      outdir: temporaryDirectory,
      naming: 'simulator-host-agent.mjs',
      target: 'node',
      format: 'esm',
      minify: false,
      sourcemap: 'none',
    })
    if (!result.success) {
      for (const log of result.logs) console.error(log)
      throw new Error('Host Agent shim bundle failed')
    }
    const bundledBytes = await readFile(temporaryOutput)
    const bundledShebang = Buffer.from(BUNDLED_NODE_SHEBANG)
    if (bundledBytes.byteLength < bundledShebang.byteLength
      || !bundledBytes.subarray(0, bundledShebang.byteLength).equals(bundledShebang)) {
      throw new Error('Host Agent shim bundle lost its deterministic Node build shebang')
    }
    await writeFile(temporaryOutput, Buffer.concat([
      Buffer.from(HOST_AGENT_SHIM_BOOTSTRAP_PREFIX),
      bundledBytes.subarray(bundledShebang.byteLength),
    ]), { mode: 0o755 })
    await chmod(temporaryOutput, 0o755)
    const bytes = await inspectGeneratedShim(temporaryOutput, 'Fresh Host Agent generated shim')

    // The temporary output lives beside the destination, so rename is an
    // atomic same-filesystem replacement. No build failure can truncate the
    // previously reviewed generated artifact.
    await rename(temporaryOutput, outputPath)
    const installedBytes = await inspectGeneratedShim(outputPath, 'Installed Host Agent generated shim')
    const digest = createHash('sha256').update(installedBytes).digest('hex')
    if (!installedBytes.equals(bytes)) throw new Error('Installed Host Agent shim changed during atomic replacement')
    return digest
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  try {
    const digest = await buildHostAgentShim()
    console.log(`simulator-host-agent.mjs sha256=${digest}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
