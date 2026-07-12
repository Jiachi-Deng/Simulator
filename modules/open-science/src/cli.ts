#!/usr/bin/env node
import { readFile } from "node:fs/promises"
import { validateArtifact } from "./validator.js"

const [root, inventoryPath] = process.argv.slice(2)
if (!root || !inventoryPath) {
  console.error("usage: validate-open-science-artifact <artifact-root> <inventory.json>")
  process.exitCode = 2
} else {
  await validateArtifact(root, JSON.parse(await readFile(inventoryPath, "utf8")))
  console.log("OpenScience artifact inventory valid")
}
