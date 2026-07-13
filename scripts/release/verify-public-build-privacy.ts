import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs"
import { basename, join, resolve } from "node:path"

interface BuildPolicy {
  readonly schemaVersion: 1
  readonly updatesDisabled: boolean
}

interface ForbiddenNeedle {
  readonly text: string
  readonly bytes: Buffer
}

export interface PublicBuildPrivacyVerification {
  readonly scannedFiles: number
  readonly forbiddenMatches: readonly string[]
  readonly updatesDisabled: true
}

function readStableRegularFile(path: string): Buffer {
  const pathBefore = lstatSync(path)
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
    throw new Error(`Packaged privacy input must be a regular file: ${path}`)
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(descriptor)
    const contents = readFileSync(descriptor)
    const after = fstatSync(descriptor)
    const pathAfter = lstatSync(path)
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || pathBefore.dev !== pathAfter.dev
      || pathBefore.ino !== pathAfter.ino
      || pathAfter.dev !== after.dev
      || pathAfter.ino !== after.ino
    ) {
      throw new Error(`Packaged privacy input changed during verification: ${path}`)
    }
    return contents
  } finally {
    closeSync(descriptor)
  }
}

function forbiddenMatchesIn(path: string, contents: Buffer, needles: readonly ForbiddenNeedle[]): string[] {
  return needles
    .filter((needle) => contents.indexOf(needle.bytes) !== -1)
    .map((needle) => `${path}: ${needle.text}`)
}

function parseBuildPolicy(contentRoot: string, needles: readonly ForbiddenNeedle[]): BuildPolicy {
  const path = join(contentRoot, "resources", "build-policy.json")
  const contents = readStableRegularFile(path)
  const forbiddenMatches = forbiddenMatchesIn(path, contents, needles)
  if (forbiddenMatches.length > 0) {
    throw new Error(`Public build contains forbidden embedded values:\n${forbiddenMatches.join("\n")}`)
  }
  const value = JSON.parse(contents.toString("utf8")) as Partial<BuildPolicy>
  const keys = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : []
  if (
    keys.length !== 2
    || keys[0] !== "schemaVersion"
    || keys[1] !== "updatesDisabled"
    || value.schemaVersion !== 1
    || value.updatesDisabled !== true
  ) {
    throw new Error(`Public build must carry an updates-disabled build policy: ${path}`)
  }
  return { schemaVersion: 1, updatesDisabled: true }
}

export function verifyPublicBuildPrivacy(
  appRoot: string,
  forbiddenValues: readonly string[],
): PublicBuildPrivacyVerification {
  const requestedRoot = resolve(appRoot)
  const rootStat = lstatSync(requestedRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`App root must be a real directory: ${requestedRoot}`)
  }
  const trustedRoot = realpathSync(requestedRoot)
  const contentRoot = join(trustedRoot, "Contents", "Resources", "app", "dist")
  const contentStat = lstatSync(contentRoot)
  if (!contentStat.isDirectory() || contentStat.isSymbolicLink() || realpathSync(contentRoot) !== contentRoot) {
    throw new Error(`Packaged dist root must be a real directory: ${contentRoot}`)
  }
  const needles = [...new Set(forbiddenValues.filter((value) => value.length > 0))].map((value) => ({
    text: value,
    bytes: Buffer.from(value),
  }))
  const forbiddenMatches: string[] = []
  let scannedFiles = 0
  parseBuildPolicy(contentRoot, needles)

  const visit = (directory: string): void => {
    const before = lstatSync(directory)
    const beforeRealPath = realpathSync(directory)
    if (!before.isDirectory() || before.isSymbolicLink() || beforeRealPath !== directory) {
      throw new Error(`Packaged dist directory changed during verification: ${directory}`)
    }
    const entries = readdirSync(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) {
        throw new Error(`Packaged dist must not contain symlinks: ${path}`)
      }
      if (stat.isDirectory()) {
        if (realpathSync(path) !== path) throw new Error(`Packaged dist directory changed during verification: ${path}`)
        visit(path)
        continue
      }
      if (!stat.isFile()) continue
      scannedFiles += 1
      const contents = readStableRegularFile(path)
      forbiddenMatches.push(...forbiddenMatchesIn(path, contents, needles))
    }
    const after = lstatSync(directory)
    if (
      !after.isDirectory()
      || after.isSymbolicLink()
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.mtimeMs !== after.mtimeMs
      || realpathSync(directory) !== beforeRealPath
    ) {
      throw new Error(`Packaged dist directory changed during verification: ${directory}`)
    }
  }
  visit(contentRoot)

  forbiddenMatches.sort()
  if (forbiddenMatches.length > 0) {
    throw new Error(`Public build contains forbidden embedded values:\n${forbiddenMatches.join("\n")}`)
  }
  return { scannedFiles, forbiddenMatches, updatesDisabled: true }
}

if (import.meta.main) {
  const [appRoot, ...forbiddenValues] = process.argv.slice(2)
  if (!appRoot || forbiddenValues.length === 0) {
    throw new Error(`Usage: ${basename(process.argv[1])} APP_ROOT FORBIDDEN_VALUE [...]`)
  }
  console.log(JSON.stringify(verifyPublicBuildPrivacy(appRoot, forbiddenValues), null, 2))
}
