import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { validatePackagedServerResources } from "../../../scripts/packaged-server-resources"
import {
  assertHostAgentArtifactsMatch,
  inspectHostAgentArtifact,
} from "./copy-assets"

// Every caller (workspace scripts, DMG packaging, Windows packaging, and
// direct CI invocation) must validate the same Electron tree regardless of
// its inherited shell working directory.
process.chdir(resolve(import.meta.dir, ".."))

function packagedResourcesRoot(appOrUnpackedRoot: string): string {
  const root = resolve(appOrUnpackedRoot)
  return basename(root).endsWith(".app")
    ? join(root, "Contents/Resources/app/dist/resources")
    : join(root, "resources/app/dist/resources")
}

function parsePackagedRoot(): string | undefined {
  const args = process.argv.slice(2)
  if (args.length === 0) return undefined
  if (args.length !== 2 || args[0] !== "--packaged-app") {
    throw new Error("Usage: validate-assets.ts [--packaged-app APP_OR_UNPACKED_ROOT]")
  }
  return packagedResourcesRoot(args[1]!)
}

const packagedRoot = parsePackagedRoot()

const requiredAssetDirectories = [
  { path: "dist/resources/themes", description: "preset themes" },
  { path: "dist/resources/docs", description: "documentation" },
  { path: "dist/resources/permissions", description: "default permissions" },
  { path: "dist/resources/tool-icons", description: "tool icons" },
]

const failures: string[] = []
for (const asset of requiredAssetDirectories) {
  if (!existsSync(asset.path)) {
    failures.push(`${asset.path} is missing (${asset.description})`)
  } else if (readdirSync(asset.path).length === 0) {
    failures.push(`${asset.path} is empty (${asset.description})`)
  }
}

const requiredBuildFiles = [
  { path: "dist/module-view-preload.cjs", description: "isolated module view preload" },
  { path: "resources/host-agent/simulator-host-agent.mjs", description: "fresh Host Agent v2 CLI shim source artifact" },
  { path: "dist/resources/host-agent/simulator-host-agent.mjs", description: "Host Agent v2 CLI shim" },
  { path: "dist/resources/host-agent/worker.cjs", description: "isolated Host Agent Utility Process" },
]

for (const asset of requiredBuildFiles) {
  if (!existsSync(asset.path)) {
    failures.push(`${asset.path} is missing (${asset.description})`)
  } else if (statSync(asset.path).size === 0) {
    failures.push(`${asset.path} is empty (${asset.description})`)
  }
}

const sourceHostAgentShimPath = "resources/host-agent/simulator-host-agent.mjs"
const hostAgentShimPath = "dist/resources/host-agent/simulator-host-agent.mjs"
if (existsSync(sourceHostAgentShimPath) && existsSync(hostAgentShimPath)) {
  const bytes = readFileSync(hostAgentShimPath)
  if (!bytes.subarray(0, 20).toString("utf8").startsWith("#!/usr/bin/env node")) {
    failures.push(`${hostAgentShimPath} does not have the required Node shebang`)
  }
  if (bytes.includes(Buffer.from("sourceMappingURL="))) {
    failures.push(`${hostAgentShimPath} unexpectedly contains a source map reference`)
  }
  try {
    const source = inspectHostAgentArtifact(sourceHostAgentShimPath, "Host Agent generated shim", {
      executable: true,
    })
    const dist = inspectHostAgentArtifact(hostAgentShimPath, "Host Agent dist shim", { executable: true })
    assertHostAgentArtifactsMatch(source, dist, "Host Agent source/dist shim")
    if (packagedRoot) {
      const packaged = inspectHostAgentArtifact(
        join(packagedRoot, "host-agent/simulator-host-agent.mjs"),
        "Packaged Host Agent shim",
        { executable: true, allowRootOwner: true },
      )
      assertHostAgentArtifactsMatch(source, packaged, "Packaged Host Agent shim")
    }
    console.log(`Host Agent shim sha256=${source.sha256}`)
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }
}

const hostAgentWorkerPath = "dist/resources/host-agent/worker.cjs"
if (existsSync(hostAgentWorkerPath)) {
  const bytes = readFileSync(hostAgentWorkerPath)
  if (bytes.includes(Buffer.from("sourceMappingURL="))) {
    failures.push(`${hostAgentWorkerPath} unexpectedly contains a source map reference`)
  }
  try {
    const dist = inspectHostAgentArtifact(hostAgentWorkerPath, "Host Agent dist worker", { executable: false })
    if (packagedRoot) {
      const packaged = inspectHostAgentArtifact(
        join(packagedRoot, "host-agent/worker.cjs"),
        "Packaged Host Agent worker",
        { executable: false, allowRootOwner: true },
      )
      assertHostAgentArtifactsMatch(dist, packaged, "Packaged Host Agent worker")
    }
    console.log(`Host Agent worker sha256=${dist.sha256}`)
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }
}

if (failures.length > 0) {
  console.error("Bundled asset validation failed:")
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

try {
  validatePackagedServerResources("dist/resources")
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

console.log("All required bundled assets and packaged server dependencies are present.")
