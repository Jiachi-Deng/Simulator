import { existsSync, readdirSync, statSync } from "node:fs"
import { validatePackagedServerResources } from "../../../scripts/packaged-server-resources"

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
]

for (const asset of requiredBuildFiles) {
  if (!existsSync(asset.path)) {
    failures.push(`${asset.path} is missing (${asset.description})`)
  } else if (statSync(asset.path).size === 0) {
    failures.push(`${asset.path} is empty (${asset.description})`)
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
