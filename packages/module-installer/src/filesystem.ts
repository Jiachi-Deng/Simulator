import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type { ModuleSha256 } from '@simulator/module-contract'
import {
  ModuleInstallerError,
  SimulatedInstallerCrash,
  type InstallLimits,
  type InstallProgress,
  type InstallerFaultInjector,
} from './types.ts'

export interface TreeManifestResult {
  readonly sha256: ModuleSha256
  readonly fileCount: number
  readonly totalBytes: number
  readonly files: ReadonlyMap<string, { readonly size: number; readonly executable: boolean; readonly sha256: string }>
}

interface TreeRecord {
  readonly path: string
  readonly value: string
}

type ProgressReporter = (progress: InstallProgress) => void

function filesystemError(message: string, cause: unknown): ModuleInstallerError {
  if (cause instanceof ModuleInstallerError) return cause
  return new ModuleInstallerError('FILESYSTEM_ERROR', `${message}: ${cause instanceof Error ? cause.message : String(cause)}`, cause)
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function copyAndHashArchive(
  sourcePath: string,
  destinationPath: string,
  limits: InstallLimits,
  signal: AbortSignal | undefined,
  report: ProgressReporter,
): Promise<ModuleSha256> {
  let source
  let destination
  try {
    const sourceInfo = await lstat(sourcePath)
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
      throw new ModuleInstallerError('ARCHIVE_INVALID', 'Local archive source must be a regular file, not a link')
    }
    if (sourceInfo.size > limits.maxArchiveBytes) {
      throw new ModuleInstallerError('ARCHIVE_LIMIT_EXCEEDED', `Archive exceeds ${limits.maxArchiveBytes} compressed bytes`)
    }
    source = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const openedInfo = await source.stat()
    if (!openedInfo.isFile()) throw new ModuleInstallerError('ARCHIVE_INVALID', 'Opened archive source is not a regular file')
    destination = await open(destinationPath, exclusiveWriteFlags(), 0o600)

    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(256 * 1024)
    let bytes = 0
    while (true) {
      if (signal?.aborted) throw new ModuleInstallerError('ABORTED', 'Module installation was cancelled')
      const read = await source.read(buffer, 0, buffer.length, null)
      if (read.bytesRead === 0) break
      bytes += read.bytesRead
      if (bytes > limits.maxArchiveBytes) {
        throw new ModuleInstallerError('ARCHIVE_LIMIT_EXCEEDED', `Archive exceeds ${limits.maxArchiveBytes} compressed bytes`)
      }
      const chunk = buffer.subarray(0, read.bytesRead)
      hash.update(chunk)
      await destination.writeFile(chunk)
      report({
        phase: 'verifying-archive',
        completed: Math.min(19, 1 + Math.floor((bytes / Math.max(openedInfo.size, 1)) * 18)),
        total: 100,
        bytes,
      })
    }
    await destination.sync()
    return hash.digest('hex') as ModuleSha256
  } catch (error) {
    throw filesystemError('Could not copy local archive into staging', error)
  } finally {
    await destination?.close().catch(() => undefined)
    await source?.close().catch(() => undefined)
  }
}

async function hashFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(256 * 1024)
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, null)
      if (read.bytesRead === 0) break
      hash.update(buffer.subarray(0, read.bytesRead))
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

function assertSafeExtractedPath(path: string): void {
  if (!path.split('/').every((segment) => SAFE_PATH_SEGMENT.test(segment))) {
    throw new ModuleInstallerError('ARCHIVE_INVALID', `Extracted path is outside the safe ASCII contract: ${JSON.stringify(path)}`)
  }
}

export async function hashExtractedTree(
  root: string,
  limits: InstallLimits,
  signal: AbortSignal | undefined,
  report: ProgressReporter,
): Promise<TreeManifestResult> {
  const records: TreeRecord[] = []
  const files = new Map<string, { size: number; executable: boolean; sha256: string }>()
  const collisionKeys = new Map<string, string>()
  let entries = 0
  let totalBytes = 0

  async function visit(directory: string): Promise<void> {
    if (signal?.aborted) throw new ModuleInstallerError('ABORTED', 'Module installation was cancelled')
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))
    for (const child of children) {
      if (signal?.aborted) throw new ModuleInstallerError('ABORTED', 'Module installation was cancelled')
      const absolute = join(directory, child.name)
      const path = portableRelative(root, absolute)
      assertSafeExtractedPath(path)
      const key = path.toLowerCase()
      const prior = collisionKeys.get(key)
      if (prior !== undefined) {
        throw new ModuleInstallerError('ARCHIVE_INVALID', `Extracted paths collide under ASCII case folding: ${JSON.stringify(prior)} and ${JSON.stringify(path)}`)
      }
      collisionKeys.set(key, path)
      entries += 1
      if (entries > limits.maxEntries) throw new ModuleInstallerError('ARCHIVE_LIMIT_EXCEEDED', 'Extracted tree exceeds entry limit')

      const info = await lstat(absolute)
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
        throw new ModuleInstallerError('ARCHIVE_INVALID', `Extracted tree contains a link or special file: ${JSON.stringify(path)}`)
      }
      if (info.isDirectory()) {
        records.push({ path, value: `D\t${JSON.stringify(path)}` })
        await visit(absolute)
        continue
      }

      totalBytes += info.size
      if (info.size > limits.maxFileBytes || totalBytes > limits.maxTotalBytes) {
        throw new ModuleInstallerError('ARCHIVE_LIMIT_EXCEEDED', 'Extracted tree exceeds byte limits')
      }
      const sha256 = await hashFile(absolute)
      const executable = (info.mode & 0o111) !== 0
      files.set(path, { size: info.size, executable, sha256 })
      records.push({ path, value: `F\t${JSON.stringify(path)}\t${info.size}\t${executable ? 1 : 0}\t${sha256}` })
      report({
        phase: 'verifying-files',
        completed: Math.min(89, 70 + Math.floor((totalBytes / Math.max(limits.maxTotalBytes, 1)) * 19)),
        total: 100,
        entries,
        bytes: totalBytes,
      })
    }
  }

  try {
    const rootInfo = await stat(root)
    if (!rootInfo.isDirectory()) throw new ModuleInstallerError('ARCHIVE_INVALID', 'Extracted payload is not a directory')
    await visit(root)
    records.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)))
    const digest = createHash('sha256').update(`${records.map((record) => record.value).join('\n')}\n`).digest('hex') as ModuleSha256
    return { sha256: digest, fileCount: files.size, totalBytes, files }
  } catch (error) {
    throw filesystemError('Could not verify extracted files', error)
  }
}

export async function normalizeAndVerifyModes(root: string, entrypoint: string): Promise<void> {
  async function visit(directory: string): Promise<void> {
    await chmod(directory, 0o700)
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, child.name)
      const relativePath = portableRelative(root, absolute)
      if (child.isDirectory()) {
        await visit(absolute)
      } else if (child.isFile()) {
        await chmod(absolute, relativePath === entrypoint ? 0o700 : 0o600)
      } else {
        throw new ModuleInstallerError('ARCHIVE_INVALID', `Cannot normalize mode for non-regular entry: ${JSON.stringify(relativePath)}`)
      }
    }
  }

  try {
    await visit(root)
    const entrypointPath = join(root, ...entrypoint.split('/'))
    const info = await lstat(entrypointPath)
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o100) === 0) {
      throw new ModuleInstallerError('ENTRYPOINT_INVALID', 'Extracted entrypoint is not an owner-executable regular file')
    }
    await access(entrypointPath, constants.X_OK)
  } catch (error) {
    throw filesystemError('Could not normalize or verify extracted file modes', error)
  }
}

export async function fsyncTree(root: string): Promise<void> {
  const directories: string[] = []
  async function visit(directory: string): Promise<void> {
    directories.push(directory)
    const children = await readdir(directory, { withFileTypes: true })
    for (const child of children) {
      const path = join(directory, child.name)
      if (child.isDirectory()) await visit(path)
      else {
        const handle = await open(path, 'r')
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
    }
  }

  try {
    await visit(root)
    for (const directory of directories.reverse()) await fsyncDirectory(directory)
  } catch (error) {
    throw filesystemError('Could not fsync staged content', error)
  }
}

export async function fsyncDirectory(directory: string): Promise<void> {
  let handle
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR' && code !== 'EPERM') throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  const handle = await open(temporary, exclusiveWriteFlags(), 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  await handle.close()
  try {
    await rename(temporary, path)
    await fsyncDirectory(directory)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function createJsonExclusive(
  path: string,
  claimPath: string,
  value: unknown,
  fault?: InstallerFaultInjector,
): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.transaction.${randomUUID()}.tmp`)
  let handle
  let claimed = false
  let published = false
  try {
    await fault?.('before-journal-temp-write')
    handle = await open(temporary, exclusiveWriteFlags(), 0o600)
    const serialized = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
    const midpoint = Math.max(1, Math.floor(serialized.length / 2))
    await handle.writeFile(serialized.subarray(0, midpoint))
    await fault?.('during-journal-temp-write')
    await handle.writeFile(serialized.subarray(midpoint))
    await handle.sync()
    await handle.close()
    handle = undefined
    await fault?.('after-journal-temp-fsync')
    await mkdir(claimPath, { mode: 0o700 })
    claimed = true
    await fault?.('after-journal-claim')
    if (await pathExists(path)) {
      const error = new Error('Journal already exists') as NodeJS.ErrnoException
      error.code = 'EEXIST'
      throw error
    }
    await rename(temporary, path)
    published = true
    await fault?.('after-journal-rename')
    await fsyncDirectory(directory)
    await rm(claimPath, { recursive: true })
    claimed = false
    await fsyncDirectory(directory)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    if (error instanceof SimulatedInstallerCrash) throw error
    await rm(temporary, { force: true }).catch(() => undefined)
    if (published) await rm(path, { force: true }).catch(() => undefined)
    if (claimed) await rm(claimPath, { recursive: true, force: true }).catch(() => undefined)
    await fsyncDirectory(directory).catch(() => undefined)
    throw error
  }
}

function exclusiveWriteFlags(): 'wx' | number {
  return process.platform === 'win32'
    ? 'wx'
    : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0)
}
