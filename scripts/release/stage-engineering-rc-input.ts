import { createHash } from "node:crypto"
import {
  chmodSync,
  constants,
  copyFileSync,
  createReadStream,
  lstatSync,
  readdirSync,
} from "node:fs"
import { basename, join, resolve } from "node:path"

export const ENGINEERING_RC_ARTIFACTS = ["Simulator-arm64.dmg", "Simulator-arm64.zip"] as const

export interface StagedArtifactEvidence {
  name: (typeof ENGINEERING_RC_ARTIFACTS)[number]
  size: number
  sha256: string
}

export interface EngineeringRcInputEvidence {
  schemaVersion: 1
  files: StagedArtifactEvidence[]
}

function assertDirectory(path: string, label: string): void {
  const metadata = lstatSync(path)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a symlink: ${path}`)
  }
}

function assertRegularFile(path: string, label: string): number {
  const metadata = lstatSync(path)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular file, not a symlink: ${path}`)
  }
  if (metadata.size === 0) throw new Error(`${label} must not be empty: ${path}`)
  return metadata.size
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

export async function stageEngineeringRcInput(
  releaseDirectory: string,
  destinationDirectory: string,
): Promise<EngineeringRcInputEvidence> {
  const releaseRoot = resolve(releaseDirectory)
  const destinationRoot = resolve(destinationDirectory)
  assertDirectory(releaseRoot, "Release input")
  assertDirectory(destinationRoot, "Clean verification input")

  const existing = readdirSync(destinationRoot).sort()
  if (existing.length > 0) {
    throw new Error(`Clean verification input must start empty: ${existing.join(", ")}`)
  }

  chmodSync(destinationRoot, 0o700)
  const sourceSizes = new Map<string, number>()
  for (const name of ENGINEERING_RC_ARTIFACTS) {
    const source = join(releaseRoot, name)
    sourceSizes.set(name, assertRegularFile(source, `Release artifact ${name}`))
    const destination = join(destinationRoot, name)
    copyFileSync(source, destination, constants.COPYFILE_EXCL)
    chmodSync(destination, 0o600)
  }

  const stagedNames = readdirSync(destinationRoot).sort()
  const expectedNames = [...ENGINEERING_RC_ARTIFACTS].sort()
  if (JSON.stringify(stagedNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`Clean verification input contains unexpected entries: ${stagedNames.join(", ")}`)
  }

  const directoryMode = lstatSync(destinationRoot).mode & 0o777
  if (directoryMode !== 0o700) {
    throw new Error(`Clean verification input mode must be 0700, got ${directoryMode.toString(8)}`)
  }

  const files: StagedArtifactEvidence[] = []
  for (const name of ENGINEERING_RC_ARTIFACTS) {
    const path = join(destinationRoot, name)
    const stagedSize = assertRegularFile(path, `Staged artifact ${name}`)
    if (stagedSize !== sourceSizes.get(name)) {
      throw new Error(`Staged artifact changed size during copy: ${name}`)
    }
    const mode = lstatSync(path).mode & 0o777
    if (mode !== 0o600) throw new Error(`Staged artifact mode must be 0600: ${name} is ${mode.toString(8)}`)
    files.push({ name, size: stagedSize, sha256: await sha256(path) })
  }

  return { schemaVersion: 1, files }
}

if (import.meta.main) {
  try {
    const [releaseDirectory, destinationDirectory, ...extra] = process.argv.slice(2)
    if (!releaseDirectory || !destinationDirectory || extra.length > 0) {
      throw new Error(`Usage: ${basename(import.meta.path)} RELEASE_DIR EMPTY_DESTINATION_DIR`)
    }
    console.log(JSON.stringify(await stageEngineeringRcInput(releaseDirectory, destinationDirectory), null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
