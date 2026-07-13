#!/usr/bin/env node
import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type {
  BuildBindings, RuntimeBindings, TrustedProvenanceVerifier, TrustedRuntimeConformanceVerifier, TrustDecision,
} from "./types.js"
import { parseTrustDecision } from "./trust-decision.js"
import { validateArtifact } from "./validator.js"

export async function invokeVerifier(executable: string, evidence: unknown, expected: object): Promise<TrustDecision> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""; let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0) { reject(new Error(`verifier exited ${code}: ${stderr.trim()}`)); return }
      try {
        resolve(parseTrustDecision(JSON.parse(stdout), "verifier result"))
      } catch (error) { reject(error) }
    })
    child.stdin.end(JSON.stringify({ evidence, expected }))
  })
}

export async function main(args: string[]): Promise<void> {
  const [root, inventoryPath, provenanceExecutable, runtimeExecutable] = args
  if (!root || !inventoryPath || !provenanceExecutable || !runtimeExecutable) {
    throw new Error("usage: validate-open-science-artifact <artifact-root> <inventory.json> <trusted-provenance-verifier> <trusted-runtime-verifier>")
  }
  const provenanceVerifier: TrustedProvenanceVerifier = {
    verifierKind: `external:${provenanceExecutable}`,
    verify: (evidence: unknown, expected: BuildBindings) => invokeVerifier(provenanceExecutable, evidence, expected),
  }
  const runtimeVerifier: TrustedRuntimeConformanceVerifier = {
    verifierKind: `external:${runtimeExecutable}`,
    verify: (evidence: unknown, expected: RuntimeBindings) => invokeVerifier(runtimeExecutable, evidence, expected),
  }
  await validateArtifact(root, JSON.parse(await readFile(inventoryPath, "utf8")), { provenanceVerifier, runtimeVerifier })
  console.log("OpenScience artifact and trusted evidence valid")
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 2
  }
}
