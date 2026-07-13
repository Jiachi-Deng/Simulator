import assert from "node:assert/strict"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { invokeVerifier } from "../src/cli.js"

test("CLI verifier invocation accepts a strict trusted identity result", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "openscience-cli-"))
  const executable = path.join(directory, "verifier.mjs")
  try {
    await writeFile(executable, `#!/usr/bin/env node
let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => { input += chunk })
process.stdin.on("end", () => {
  const { evidence, expected } = JSON.parse(input)
  if (evidence.kind !== "test" || expected.binding !== "expected") process.exit(3)
  process.stdout.write(JSON.stringify({ trusted: true, subject: "subject", source: "source", evidence: "evidence" }))
})
`)
    await chmod(executable, 0o755)
    const result = await invokeVerifier(executable, { kind: "test" }, { binding: "expected" })
    assert.deepEqual(result, { trusted: true, subject: "subject", source: "source", evidence: "evidence" })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
