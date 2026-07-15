import { createReadStream } from 'node:fs'
import { constants as fsConstants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { posix } from 'node:path'
import { createGunzip } from 'node:zlib'
import type { ReadEntry } from 'tar'
import {
  ModuleInstallerError,
  type InstallLimits,
  type InstallProgress,
} from './types.ts'

const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i
const DRIVE_OR_UNC = /^(?:[A-Za-z]:|[/\\]{2})/
const SAFE_ARCHIVE_PAYLOAD_SEGMENT = /^[A-Za-z0-9._$@+~\x5b\x5d-]+$/
const TAR_BLOCK_SIZE = 512
const TAR_METADATA_TYPES = new Set(['g', 'x', 'X', 'L', 'K', 'N'])

let tarModule: Promise<typeof import('tar')> | undefined

async function loadTar(): Promise<typeof import('tar')> {
  if (!tarModule) {
    // Bun's Windows fs.open does not implement libuv's optional file-map flag.
    if (process.platform === 'win32' && process.versions.bun && fsConstants.UV_FS_O_FILEMAP) {
      (fsConstants as { UV_FS_O_FILEMAP: number }).UV_FS_O_FILEMAP = 0
    }
    tarModule = import('tar')
  }
  return tarModule
}

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

// Archive payloads may contain package-manager and framework-generated names.
// Manifest executable paths remain governed by the stricter module contract.
export function isPortableArchivePayloadSegment(segment: string): boolean {
  return segment !== ''
    && segment !== '.'
    && segment !== '..'
    && SAFE_ARCHIVE_PAYLOAD_SEGMENT.test(segment)
    && !segment.endsWith('.')
    && !WINDOWS_DEVICE.test(segment)
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
    if (!SAFE_ARCHIVE_PAYLOAD_SEGMENT.test(segment)) {
      invalidEntry(`Archive path is outside the safe ASCII segment contract: ${JSON.stringify(path)}`)
    }
    if (!isPortableArchivePayloadSegment(segment)) {
      invalidEntry(`Archive path has a platform-ambiguous component: ${JSON.stringify(path)}`)
    }
  }
  if (segments[0] !== 'module') invalidEntry('Archive must contain exactly one top-level directory named module')
  if (segments.length === 1) return ''
  return segments.slice(1).join('/')
}

function collisionKey(path: string): string {
  return path.toLowerCase()
}

function parseTarOctal(field: Buffer, label: string): number {
  if ((field[0]! & 0x80) !== 0) invalidEntry(`Base-256 tar ${label} is not supported`)
  const nul = field.indexOf(0)
  const text = field.subarray(0, nul === -1 ? field.length : nul).toString('ascii').trim()
  if (text === '') return 0
  if (!/^[0-7]+$/.test(text)) invalidEntry(`Tar ${label} is not canonical octal`)
  const value = Number.parseInt(text, 8)
  if (!Number.isSafeInteger(value) || value < 0) invalidEntry(`Tar ${label} is outside the safe integer range`)
  return value
}

function validateTarChecksum(header: Buffer): void {
  const expected = parseTarOctal(header.subarray(148, 156), 'checksum')
  let actual = 0
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index]!
  }
  if (actual !== expected) invalidEntry('Tar header checksum is invalid')
}

async function inspectRawTarHeaders(path: string, limits: InstallLimits, signal?: AbortSignal): Promise<void> {
  const stream = createReadStream(path).pipe(createGunzip())
  const compressedBytes = (await stat(path)).size
  const boundedEnvelope = limits.maxTotalBytes + limits.maxMetadataBytes + (limits.maxEntries * 1024) + 1024
  const ratioEnvelope = compressedBytes * limits.maxDecompressionRatio
  const maxRawBytes = Math.min(Number.MAX_SAFE_INTEGER, boundedEnvelope, ratioEnvelope)
  let buffer = Buffer.alloc(0)
  let dataBytesRemaining = 0
  let rawBytes = 0
  let headerCount = 0
  let metadataBytes = 0
  let zeroBlocks = 0
  let ended = false

  try {
    for await (const value of stream) {
      abortIfRequested(signal)
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      rawBytes += chunk.length
      if (!Number.isSafeInteger(rawBytes) || rawBytes > maxRawBytes) {
        limitExceeded('Raw tar stream exceeds the bounded production envelope')
      }
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      while (buffer.length > 0) {
        if (dataBytesRemaining > 0) {
          const consumed = Math.min(dataBytesRemaining, buffer.length)
          buffer = buffer.subarray(consumed)
          dataBytesRemaining -= consumed
          if (dataBytesRemaining > 0) break
          continue
        }
        if (buffer.length < TAR_BLOCK_SIZE) break
        const header = buffer.subarray(0, TAR_BLOCK_SIZE)
        buffer = buffer.subarray(TAR_BLOCK_SIZE)
        if (header.every((byte) => byte === 0)) {
          zeroBlocks += 1
          if (zeroBlocks >= 2) ended = true
          continue
        }
        if (ended) invalidEntry('Tar archive contains entries after its end marker')
        zeroBlocks = 0
        validateTarChecksum(header)
        headerCount += 1
        if (headerCount > limits.maxEntries) limitExceeded(`Tar archive exceeds ${limits.maxEntries} total headers`)
        const size = parseTarOctal(header.subarray(124, 136), 'size')
        const type = String.fromCharCode(header[156]!)
        if (TAR_METADATA_TYPES.has(type)) {
          metadataBytes += size
          if (!Number.isSafeInteger(metadataBytes) || metadataBytes > limits.maxMetadataBytes) {
            limitExceeded(`Tar metadata exceeds ${limits.maxMetadataBytes} bytes`)
          }
        }
        dataBytesRemaining = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
      }
    }
  } catch (error) {
    throw toInstallerError(error, 'Raw tar header inspection failed')
  }
  if (dataBytesRemaining !== 0 || buffer.length !== 0 || !ended) invalidEntry('Tar archive is truncated or lacks a canonical end marker')
}

function asPlan(entry: ReadEntry, limits: InstallLimits, executablePaths: ReadonlySet<string>): ArchiveEntryPlan {
  if (entry.type !== 'File' && entry.type !== 'Directory') {
    invalidEntry(`Archive entry type ${entry.type} is forbidden: ${JSON.stringify(entry.path)}`)
  }
  const archivePath = entry.type === 'Directory' && entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path
  const relativePath = validatePath(archivePath, limits)
  if (entry.linkpath) invalidEntry(`Archive links are forbidden: ${JSON.stringify(entry.path)}`)
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) invalidEntry('Archive entry has an invalid size')
  if (entry.type === 'Directory' && entry.size !== 0) invalidEntry('Archive directory has a non-zero size')
  const maxFileBytes = executablePaths.has(relativePath) ? limits.maxExecutableFileBytes : limits.maxFileBytes
  if (entry.size > maxFileBytes) {
    limitExceeded(`Archive file exceeds ${maxFileBytes} bytes: ${JSON.stringify(entry.path)}`)
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
  executablePaths: ReadonlySet<string>,
  signal: AbortSignal | undefined,
  report: ProgressReporter,
): Promise<ArchivePlan> {
  const entries = new Map<string, ArchiveEntryPlan>()
  const collisionKeys = new Map<string, string>()
  let totalBytes = 0
  let fileCount = 0
  let validationError: ModuleInstallerError | undefined

  try {
    await inspectRawTarHeaders(archivePath, limits, signal)
    const { list } = await loadTar()
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
          const planned = asPlan(entry, limits, executablePaths)
          if (entries.has(planned.archivePath)) invalidEntry(`Archive has a duplicate path: ${JSON.stringify(entry.path)}`)
          const key = collisionKey(planned.archivePath)
          const prior = collisionKeys.get(key)
          if (prior !== undefined) {
            invalidEntry(`Archive paths collide under ASCII case folding: ${JSON.stringify(prior)} and ${JSON.stringify(entry.path)}`)
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
  executablePaths: ReadonlySet<string>,
  signal: AbortSignal | undefined,
  report: ProgressReporter,
): Promise<void> {
  const seen = new Set<string>()
  let extractedBytes = 0
  let validationError: ModuleInstallerError | undefined
  try {
    const { extract } = await loadTar()
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
          const actual = asPlan(entry, limits, executablePaths)
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

export function validateEntrypointPlan(plan: ArchivePlan, executablePaths: ReadonlySet<string>): void {
  for (const path of executablePaths) {
    const planned = plan.entries.get(posix.join('module', path))
    if (!planned || planned.type !== 'file' || (planned.mode & 0o100) === 0) {
      throw new ModuleInstallerError('ENTRYPOINT_INVALID', `Declared executable must be an owner-executable regular file: ${JSON.stringify(path)}`)
    }
  }
  for (const entry of plan.entries.values()) {
    if (entry.type === 'file' && (entry.mode & 0o111) !== 0 && !executablePaths.has(entry.relativePath)) {
      throw new ModuleInstallerError('ENTRYPOINT_INVALID', `Executable file is not declared by the artifact allowlist: ${JSON.stringify(entry.relativePath)}`)
    }
  }
}
