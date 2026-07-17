import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type JsonObject = Record<string, unknown>

export const SHA256_PATTERN = /^[0-9a-f]{64}$/
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/
export const ISO_TIMESTAMP_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/

export function evidenceFailure(kind: string, path: string, message = 'is invalid'): never {
  throw new TypeError(`${kind} ${message}: ${path}`)
}

export function objectAt(value: unknown, path: string, kind: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    evidenceFailure(kind, path)
  }
  return value as JsonObject
}

export function exactKeys(value: JsonObject, keys: readonly string[], path: string, kind: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    evidenceFailure(kind, path, 'has unknown, missing, or duplicate fields')
  }
}

export function stringAt(value: JsonObject, key: string, path: string, kind: string): string {
  if (typeof value[key] !== 'string') evidenceFailure(kind, `${path}.${key}`)
  return value[key] as string
}

export function integerAt(value: JsonObject, key: string, path: string, kind: string): number {
  if (!Number.isSafeInteger(value[key])) evidenceFailure(kind, `${path}.${key}`)
  return value[key] as number
}

export function hashAt(value: JsonObject, key: string, path: string, kind: string): string {
  const result = stringAt(value, key, path, kind)
  if (!SHA256_PATTERN.test(result)) evidenceFailure(kind, `${path}.${key}`)
  return result
}

export function commitAt(value: JsonObject, key: string, path: string, kind: string): string {
  const result = stringAt(value, key, path, kind)
  if (!COMMIT_SHA_PATTERN.test(result)) evidenceFailure(kind, `${path}.${key}`)
  return result
}

export function positiveIntegerAt(value: JsonObject, key: string, path: string, kind: string): number {
  const result = integerAt(value, key, path, kind)
  if (result < 1) evidenceFailure(kind, `${path}.${key}`)
  return result
}

export function canonicalTimestamp(value: string, path: string, kind: string): number {
  if (!ISO_TIMESTAMP_PATTERN.test(value)) evidenceFailure(kind, path)
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    evidenceFailure(kind, path)
  }
  return milliseconds
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

export function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function expectedUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined
}

export async function requireOwnerOnlyDirectory(pathInput: string, kind: string, pathLabel: string): Promise<string> {
  if (!isAbsolute(pathInput)) evidenceFailure(kind, pathLabel, 'must be absolute')
  const requested = resolve(pathInput)
  const canonical = await realpath(requested)
  const metadata = await lstat(requested)
  const uid = expectedUid()
  if (canonical !== requested || !metadata.isDirectory() || metadata.isSymbolicLink()
    || (metadata.mode & 0o777) !== 0o700 || (uid !== undefined && metadata.uid !== uid)) {
    evidenceFailure(kind, pathLabel, 'must be one canonical owner-only directory')
  }
  return canonical
}

export async function requireCanonicalDirectory(pathInput: string, kind: string, pathLabel: string): Promise<string> {
  if (!isAbsolute(pathInput)) evidenceFailure(kind, pathLabel, 'must be absolute')
  const requested = resolve(pathInput)
  const canonical = await realpath(requested)
  const metadata = await lstat(requested)
  if (canonical !== requested || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    evidenceFailure(kind, pathLabel, 'must be one real canonical directory')
  }
  return canonical
}

export async function requireCanonicalRegularFile(
  pathInput: string,
  kind: string,
  pathLabel: string,
  options: { executable?: boolean; ownerOnly?: boolean } = {},
): Promise<string> {
  if (!isAbsolute(pathInput)) evidenceFailure(kind, pathLabel, 'must be absolute')
  const requested = resolve(pathInput)
  const canonical = await realpath(requested)
  const metadata = await lstat(requested)
  const uid = expectedUid()
  if (canonical !== requested || !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || (options.executable && (metadata.mode & 0o111) === 0)
    || (options.ownerOnly && (metadata.mode & 0o777) !== 0o600)
    || (options.ownerOnly && uid !== undefined && metadata.uid !== uid)) {
    evidenceFailure(kind, pathLabel, 'must be one real canonical regular file')
  }
  return canonical
}

export async function readOwnerOnlyCanonicalJson(
  pathInput: string,
  maximumBytes: number,
  kind: string,
  pathLabel: string,
): Promise<unknown> {
  const bytes = await readOwnerOnlyBoundedFile(pathInput, maximumBytes, kind, pathLabel)
  const source = bytes.toString('utf8')
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    return evidenceFailure(kind, pathLabel, 'is not JSON')
  }
  if (source !== canonicalJson(value)) evidenceFailure(kind, pathLabel, 'is not canonical compact JSON')
  return value
}

export async function readOwnerOnlyBoundedFile(
  pathInput: string,
  maximumBytes: number,
  kind: string,
  pathLabel: string,
): Promise<Buffer> {
  const path = await requireCanonicalRegularFile(pathInput, kind, pathLabel, { ownerOnly: true })
  const before = await lstat(path)
  if (before.size < 1 || before.size > maximumBytes) {
    evidenceFailure(kind, pathLabel, 'violates file size constraints')
  }
  const bytes = await readFile(path)
  const after = await lstat(path)
  if (bytes.byteLength !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
    || after.ino !== before.ino) {
    evidenceFailure(kind, pathLabel, 'changed while being read')
  }
  return bytes
}

export async function inventoryOwnerOnlyFiles(
  rootInput: string,
  expectedPaths: readonly string[],
  kind: string,
): Promise<string> {
  const root = await requireOwnerOnlyDirectory(rootInput, kind, 'artifact root')
  const actual: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name)
    const path = relative(root, absolute).split(sep).join('/')
    const metadata = await lstat(absolute)
    const uid = expectedUid()
    if (!entry.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== 0o600 || (uid !== undefined && metadata.uid !== uid)) {
      evidenceFailure(kind, path, 'is not an owner-only regular file')
    }
    actual.push(path)
  }
  actual.sort()
  const expected = [...expectedPaths].sort()
  if (actual.join('\n') !== expected.join('\n')) evidenceFailure(kind, 'artifact inventory')
  return root
}

export async function publishOwnerOnlyDirectory<T>(
  destinationInput: string,
  kind: string,
  populateAndValidate: (temporaryRoot: string) => Promise<T>,
): Promise<T> {
  if (!isAbsolute(destinationInput)) evidenceFailure(kind, 'output root', 'must be absolute')
  const destination = resolve(destinationInput)
  const parent = await requireOwnerOnlyDirectory(dirname(destination), kind, 'output parent')
  if (destination !== join(parent, basename(destination)) || destination === parent) {
    evidenceFailure(kind, 'output root', 'is not canonical')
  }
  try {
    await lstat(destination)
    evidenceFailure(kind, 'output root', 'already exists')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporaryRoot = join(parent, `.${basename(destination)}.tmp-${randomUUID()}`)
  await mkdir(temporaryRoot, { mode: 0o700 })
  let published = false
  try {
    await chmod(temporaryRoot, 0o700)
    const result = await populateAndValidate(temporaryRoot)
    await rename(temporaryRoot, destination)
    published = true
    return result
  } finally {
    if (!published) await rm(temporaryRoot, { recursive: true, force: true })
  }
}

export async function writeOwnerOnlyNewFile(path: string, source: string | Uint8Array): Promise<void> {
  await writeFile(path, source, { mode: 0o600, flag: 'wx' })
  await chmod(path, 0o600)
}
