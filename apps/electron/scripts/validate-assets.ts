import { existsSync, readdirSync } from "node:fs"

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

if (failures.length > 0) {
  console.error("Bundled asset validation failed:")
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log("All required bundled asset directories are present and non-empty.")
