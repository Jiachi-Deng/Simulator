import { open } from 'node:fs/promises'
import { posix } from 'node:path'
import { extract, list, type ReadEntry } from 'tar'
import {
  ModuleInstallerError,
  type InstallLimits,
  type InstallProgress,
} from './types.ts'

const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const DRIVE_OR_UNC = /^(?:[A-Za-z]:|[/\\]{2})/

export interface ArchiveEntryPlan {
  readonly archivePath: string
  readonly relativePath: string
  readonly type: 'file' | 'directory'
  readonly size: number
  readonly mode: number
}

export interface ArchivePlan {
  readonly entries: ReadonlyMap<string, ArchiveEntryPlan>
  readonly fileCount: number
  readonly totalBytes: number
}

type ProgressReporter = (progress: InstallProgress) => void

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ModuleInstallerError('ABORTED', 'Module installation was cancelled')
}

function invalidEntry(message: string): never {
  throw new ModuleInstallerError('ARCHIVE_INVALID', message)
}

function limitExceeded(message: string): never {
  throw new ModuleInstallerError('ARCHIVE_LIMIT_EXCEEDED', message)
}

function validatePath(path: string, limits: InstallLimits): string {
  if (path.length === 0 || path.includes('\0') || /[\u0000-\u001f\u007f]/.test(path)) {
    invalidEntry('Archive contains an empty path or control characters')
  }
  if (path.includes('\\') || path.startsWith('/') || DRIVE_OR_UNC.test(path) || path.includes(':')) {
    invalidEntry(`Archive path is not portable: ${JSON.stringify(path)}`)
  }
  if (Buffer.byteLength(path, 'utf8') > limits.maxPathBytes) {
    limitExceeded(`Archive path exceeds ${limits.maxPathBytes} UTF-8 bytes`)
  }

  const segments = path.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    invalidEntry(`Archive path is not canonical: ${JSON.stringify(path)}`)
  }
  if (segments.length > limits.maxDepth + 1) {
    limitExceeded(`Archive path exceeds maximum depth ${limits.maxDepth}`)
  }
  for (const segment of segments) {
    if (segment.endsWith('.') || segment.endsWith(' ') || WINDOWS_DEVICE.test(segment)) {
      invalidEntry(`Archive path has a platform-ambiguous component: ${JSON.stringify(path)}`)
    }
  }
  if (segments[0] !== 'module') invalidEntry('Archive must contain exactly one top-level directory named module')
  if (segments.length === 1) return ''
  return segments.slice(1).join('/')
}

function collisionKey(path: string): string {
  return path.normalize('NFKC').toLocaleLowerCase('en-US')
}

function asPlan(entry: ReadEntry, limits: InstallLimits): ArchiveEntryPlan {
  if (entry.type !== 'File' && entry.type !== 'Directory') {
    invalidEntry(`Archive entry type ${entry.type} is forbidden: ${JSON.stringify(entry.path)}`)
  }
  const archivePath = entry.type === 'Directory' && entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path
  const relativePath = validatePath(archivePath, limits)
  if (entry.linkpath) invalidEntry(`Archive links are forbidden: ${JSON.stringify(entry.path)}`)
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) invalidEntry('Archive entry has an invalid size')
  if (entry.type === 'Directory' && entry.size !== 0) invalidEntry('Archive directory has a non-zero size')
  if (entry.size > limits.maxFileBytes) {
    limitExceeded(`Archive file exceeds ${limits.maxFileBytes} bytes: ${JSON.stringify(entry.path)}`)
  }
  return {
    archivePath,
    relativePath,
    type: entry.type === 'File' ? 'file' : 'directory',
    size: entry.size,
    mode: (entry.mode ?? 0) & 0o777,
  }
}

function toInstallerError(error: unknown, context: string): ModuleInstallerError {
  if (error instanceof ModuleInstallerError) return error
  return new ModuleInstallerError('ARCHIVE_INVALID', `${context}: ${error instanceof Error ? error.message : String(error)}`, error)
}

export async function assertGzipFile(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    const magic = Buffer.alloc(2)
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0)
    if (bytesRead !== 2 || magic[0] !== 0x1f || magic[1] !== 0x8b) {
      throw new ModuleInstallerError('FORMAT_UNSUPPORTED', 'Only gzip-compressed tar archives are supported')
    }
  } finally {
    await handle.close()
  }
}

export async function inspectArchive(
  archivePath: string,
  limits: InstallLimits,
  signal: AbortSignal | undefined,
  report: ProgressReporter,
): Promise<ArchivePlan> {
  const entries = new Map<string, ArchiveEntryPlan>()
  const collisionKeys = new Map<string, string>()
  let totalBytes = 0
  let fileCount = 0
  let validationError: ModuleInstallerError | undefined

  try {
    await list({
      file: archivePath,
      gzip: true,
      strict: true,
      maxMetaEntrySize: limits.maxMetadataBytes,
      maxDecompressionRatio: limits.maxDecompressionRatio,
      onReadEntry(entry) {
        if (validationError) return
        try {
          abortIfRequested(signal)
          if (entries.size >= limits.maxEntries) limitExceeded(`Archive exceeds ${limits.maxEntries} entries`)
          const planned = asPlan(entry, limits)
          if (entries.has(planned.archivePath)) invalidEntry(`Archive has a duplicate path: ${JSON.stringify(entry.path)}`)
          const key = collisionKey(planned.archivePath)
          const prior = collisionKeys.get(key)
          if (prior !== undefined) {
            invalidEntry(`Archive paths collide after Unicode case folding: ${JSON.stringify(prior)} and ${JSON.stringify(entry.path)}`)
          }
          entries.set(planned.archivePath, planned)
          collisionKeys.set(key, planned.archivePath)
          if (planned.type === 'file') {
            fileCount += 1
            totalBytes += planned.size
            if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
              limitExceeded(`Archive exceeds ${limits.maxTotalBytes} extracted bytes`)
            }
          }
          report({ phase: 'inspecting-archive', completed: Math.min(39, 20 + Math.floor(entries.size / 16)), total: 100, entries: entries.size, bytes: totalBytes })
        } catch (error) {
          validationError = toInstallerError(error, 'Archive entry validation failed')
        }
      },
    })
  } catch (error) {
    throw toInstallerError(error, 'Archive inspection failed')
  }
  if (validationError) throw validationError

  if (fileCount === 0) invalidEntry('Archive does not contain any files')
  for (const planned of entries.values()) {
    if (planned.relativePath === '') {
      if (planned.type !== 'directory') invalidEntry('Top-level module entry must be a directory')
      continue
    }
    const segments = planned.relativePath.split('/')
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = `module/${segments.slice(0, index).join('/')}`
      const ancestorEntry = entries.get(ancestor)
      if (ancestorEntry?.type === 'file') invalidEntry(`Archive file is also a parent path: ${JSON.stringify(ancestor)}`)
    }
  }

  return { entries, fileCount, totalBytes }
}

export async function extractArchive(
  archivePath: string,
  destination: string,
  plan: ArchivePlan,
  limits: InstallLimits,
  signal: AbortSignal | undefined,
  report: ProgressReporter,
): Promise<void> {
  const seen = new Set<string>()
  let extractedBytes = 0
  let validationError: ModuleInstallerError | undefined
  try {
    await extract({
      file: archivePath,
      cwd: destination,
      gzip: true,
      strip: 1,
      strict: true,
      preservePaths: false,
      preserveOwner: false,
      unlink: true,
      noMtime: true,
      maxDepth: limits.maxDepth,
      maxMetaEntrySize: limits.maxMetadataBytes,
      maxDecompressionRatio: limits.maxDecompressionRatio,
      filter(path, rawEntry) {
        if (validationError) return false
        try {
          abortIfRequested(signal)
          const entry = rawEntry as ReadEntry
          const actual = asPlan(entry, limits)
          const expected = plan.entries.get(actual.archivePath)
          if (!expected || seen.has(actual.archivePath)) invalidEntry(`Archive changed between inspection and extraction: ${JSON.stringify(path)}`)
          if (actual.type !== expected.type || actual.size !== expected.size || actual.mode !== expected.mode) {
            invalidEntry(`Archive entry metadata changed between passes: ${JSON.stringify(path)}`)
          }
          seen.add(actual.archivePath)
          if (actual.type === 'file') extractedBytes += actual.size
          report({
            phase: 'extracting',
            completed: Math.min(69, 40 + Math.floor((seen.size / plan.entries.size) * 29)),
            total: 100,
            entries: seen.size,
            bytes: extractedBytes,
          })
          return true
        } catch (error) {
          validationError = toInstallerError(error, 'Archive extraction entry validation failed')
          return false
        }
      },
    })
  } catch (error) {
    throw toInstallerError(error, 'Archive extraction failed')
  }
  if (validationError) throw validationError
  if (seen.size !== plan.entries.size) invalidEntry('Archive extraction did not observe every inspected entry')

  // strip:1 intentionally omits the top-level directory itself.
  const expectedExtracted = [...plan.entries.values()].filter((entry) => entry.relativePath !== '').length
  const seenExtracted = [...seen].filter((path) => plan.entries.get(path)?.relativePath !== '').length
  if (seenExtracted !== expectedExtracted) invalidEntry('Archive extraction entry count mismatch')
}

export function validateEntrypointPlan(plan: ArchivePlan, entrypoint: string): void {
  const planned = plan.entries.get(posix.join('module', entrypoint))
  if (!planned || planned.type !== 'file' || (planned.mode & 0o111) === 0) {
    throw new ModuleInstallerError('ENTRYPOINT_INVALID', 'Declared entrypoint must be an executable regular file')
  }
  for (const entry of plan.entries.values()) {
    if (entry.type === 'file' && (entry.mode & 0o111) !== 0 && entry.relativePath !== entrypoint) {
      throw new ModuleInstallerError('ENTRYPOINT_INVALID', `Executable file is not the declared entrypoint: ${JSON.stringify(entry.relativePath)}`)
    }
  }
}
