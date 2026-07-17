import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs"
import { join, resolve } from "node:path"

const EXPECTED_PACKAGE_NAME = "@craft-agent/electron"
const EXPECTED_MAIN = "dist/main.cjs"

export interface PackagedElectronIdentity {
  readonly name: typeof EXPECTED_PACKAGE_NAME
  readonly version: string
  readonly main: typeof EXPECTED_MAIN
  readonly manifestPath: string
  readonly mainPath: string
}

function requireRealDirectory(path: string, label: string): void {
  const metadata = lstatSync(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error(`${label} must be a real directory: ${path}`)
  }
}

function readStableRegularFile(path: string, label: string): Buffer {
  const pathBefore = lstatSync(path)
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error(`${label} must be a real regular file: ${path}`)
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
      throw new Error(`${label} changed during verification: ${path}`)
    }
    return contents
  } finally {
    closeSync(descriptor)
  }
}

export function verifyPackagedElectronIdentity(
  appPath: string,
  expectedVersion: string,
): PackagedElectronIdentity {
  if (!expectedVersion || expectedVersion.trim() !== expectedVersion) {
    throw new Error("Expected Host version must be a non-empty canonical string")
  }

  const requestedApp = resolve(appPath)
  const requestedMetadata = lstatSync(requestedApp)
  if (!requestedMetadata.isDirectory() || requestedMetadata.isSymbolicLink()) {
    throw new Error(`App bundle root must be a real directory: ${requestedApp}`)
  }
  // macOS commonly exposes /var through /private/var. Canonicalize the trusted
  // root after rejecting a symlink at the caller-controlled leaf path.
  const app = realpathSync(requestedApp)
  requireRealDirectory(app, "App bundle root")
  const packageRoot = join(app, "Contents", "Resources", "app")
  requireRealDirectory(packageRoot, "Packaged Electron application root")

  const manifestPath = join(packageRoot, "package.json")
  let manifest: unknown
  try {
    manifest = JSON.parse(readStableRegularFile(manifestPath, "Packaged Electron manifest").toString("utf8"))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Packaged Electron manifest must contain valid JSON: ${manifestPath}`)
    }
    throw error
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`Packaged Electron manifest must contain an object: ${manifestPath}`)
  }

  const values = manifest as Record<string, unknown>
  if (values.name !== EXPECTED_PACKAGE_NAME) {
    throw new Error(`Packaged Electron name mismatch: expected ${EXPECTED_PACKAGE_NAME}`)
  }
  if (values.version !== expectedVersion) {
    throw new Error(`Packaged Electron version mismatch: expected ${expectedVersion}`)
  }
  if (values.main !== EXPECTED_MAIN) {
    throw new Error(`Packaged Electron main mismatch: expected ${EXPECTED_MAIN}`)
  }

  const distRoot = join(packageRoot, "dist")
  requireRealDirectory(distRoot, "Packaged Electron dist root")
  const mainPath = join(packageRoot, EXPECTED_MAIN)
  if (readStableRegularFile(mainPath, "Packaged Electron main").byteLength === 0) {
    throw new Error(`Packaged Electron main must not be empty: ${mainPath}`)
  }

  return {
    name: EXPECTED_PACKAGE_NAME,
    version: expectedVersion,
    main: EXPECTED_MAIN,
    manifestPath,
    mainPath,
  }
}

if (import.meta.main) {
  const [appPath, expectedVersion] = process.argv.slice(2)
  if (!appPath || !expectedVersion) {
    throw new Error("Usage: verify-packaged-electron-identity.ts APP_PATH EXPECTED_VERSION")
  }
  console.log(JSON.stringify({ ok: true, ...verifyPackagedElectronIdentity(appPath, expectedVersion) }, null, 2))
}
