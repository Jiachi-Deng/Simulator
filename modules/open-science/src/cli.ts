#!/usr/bin/env node
import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import type {
  BuildBindings, RuntimeBindings, TrustedProvenanceVerifier, TrustedRuntimeConformanceVerifier, TrustDecision,
} from "./types.js"
import { validateArtifact } from "./validator.js"

async function invokeVerifier(executable: string, evidence: unknown, expected: object): Promise<TrustDecision> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""; let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0) { reject(new Error(`verifier exited ${code}: ${stderr.trim()}`)); return }
      try {
        const result = JSON.parse(stdout) as Record<string, unknown>
        const keys = Object.keys(result)
        if (keys.some((key) => key !== "trusted" && key !== "reason") || typeof result.trusted !== "boolean" ||
            (result.reason !== undefined && typeof result.reason !== "string")) throw new Error("invalid verifier result schema")
        resolve(result as unknown as TrustDecision)
      } catch (error) { reject(error) }
    })
    child.stdin.end(JSON.stringify({ evidence, expected }))
  })
}

const [root, inventoryPath, provenanceExecutable, runtimeExecutable] = process.argv.slice(2)
if (!root || !inventoryPath || !provenanceExecutable || !runtimeExecutable) {
  console.error("usage: validate-open-science-artifact <artifact-root> <inventory.json> <trusted-provenance-verifier> <trusted-runtime-verifier>")
  process.exitCode = 2
} else {
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
