import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

let root: string | undefined
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

function fixture(mode: "success" | "exit" | "empty" | "wrong-predicate") {
  root = mkdtempSync(join(tmpdir(), "engineering-rc-attestation-verifier-"))
  const bundle = join(root, "bundle")
  const bin = join(root, "bin")
  const output = join(root, "output")
  const log = join(root, "gh.log")
  mkdirSync(join(bundle, "attestations"), { recursive: true })
  mkdirSync(bin)
  for (const name of [
    "Simulator-arm64.dmg",
    "Simulator-arm64.zip",
    "attestations/provenance.sigstore.json",
    "attestations/sbom.sigstore.json",
  ]) writeFileSync(join(bundle, name), "evidence")
  writeFileSync(join(bundle, "sbom.spdx.json"), '{"spdxVersion":"SPDX-2.3","name":"Simulator-0.12.0"}\n')
  const gh = join(bin, "gh")
  writeFileSync(gh, `#!/bin/bash
set -euo pipefail
printf '%s ' "$@" >> "$STUB_LOG"
printf '\n' >> "$STUB_LOG"
[[ "$STUB_MODE" != exit ]] || exit 42
[[ "$STUB_MODE" != empty ]] || { printf '[]\n'; exit 0; }
predicate=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --predicate-type ]]; then predicate=$2; break; fi
  shift
done
if [[ "$predicate" == https://spdx.dev/Document/v2.3 ]]; then
  if [[ "$STUB_MODE" == wrong-predicate ]]; then
    printf '[{"verificationResult":{"statement":{"predicate":{"wrong":true}}}}]\n'
  else
    jq -n --slurpfile predicate "$STUB_SBOM" '[{verificationResult:{statement:{predicate:$predicate[0]}}}]'
  fi
else
  printf '[{"verificationResult":{"statement":{"predicate":{}}}}]\n'
fi
`)
  chmodSync(gh, 0o755)
  return { bundle, bin, output, log }
}

function run(mode: "success" | "exit" | "empty" | "wrong-predicate") {
  const paths = fixture(mode)
  const result = spawnSync("bash", [
    join(import.meta.dir, "verify-engineering-rc-attestations.sh"),
    paths.bundle,
    "a".repeat(40),
    paths.output,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      GH_TOKEN: "test-token-not-a-secret",
      PATH: `${paths.bin}:${process.env.PATH}`,
      STUB_LOG: paths.log,
      STUB_MODE: mode,
      STUB_SBOM: join(paths.bundle, "sbom.spdx.json"),
    },
  })
  return { ...paths, result }
}

describe("Engineering RC saved-attestation verification", () => {
  test("executes two provenance checks and one ZIP-only SBOM check", () => {
    const { bundle, output, log, result } = run("success")
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, verifiedAttestations: 3 })
    const invocations = readFileSync(log, "utf8").trim().split("\n")
    expect(invocations).toHaveLength(3)
    expect(invocations[0]).toContain(`attestation verify ${bundle}/Simulator-arm64.dmg --bundle ${bundle}/attestations/provenance.sigstore.json`)
    expect(invocations[1]).toContain(`attestation verify ${bundle}/Simulator-arm64.zip --bundle ${bundle}/attestations/provenance.sigstore.json`)
    expect(invocations[2]).toContain(`attestation verify ${bundle}/Simulator-arm64.zip --bundle ${bundle}/attestations/sbom.sigstore.json`)
    expect(invocations.filter((line) => line.includes("--predicate-type https://slsa.dev/provenance/v1"))).toHaveLength(2)
    expect(invocations.filter((line) => line.includes("--predicate-type https://spdx.dev/Document/v2.3"))).toHaveLength(1)
    for (const line of invocations) {
      expect(line).toContain("--repo Jiachi-Deng/Simulator")
      expect(line).toContain("--source-ref refs/heads/main")
      expect(line).toContain(`--source-digest ${"a".repeat(40)}`)
      expect(line).toContain(`--signer-digest ${"a".repeat(40)}`)
      expect(line).toContain("--deny-self-hosted-runners")
    }
    expect(statSync(output).mode & 0o777).toBe(0o700)
    for (const name of ["dmg-provenance.json", "zip-provenance.json", "zip-sbom.json"]) {
      expect(statSync(join(output, name)).mode & 0o777).toBe(0o600)
    }
  })

  test.each([
    ["exit", "gh verification failure"],
    ["empty", "empty verification result"],
    ["wrong-predicate", "SBOM predicate mismatch"],
  ] as const)("fails closed on %s", (mode) => {
    const { result } = run(mode)
    expect(result.status).not.toBe(0)
  })

  test("requires an explicit token, source SHA, and absent output directory", () => {
    const { bundle, output } = fixture("success")
    const script = join(import.meta.dir, "verify-engineering-rc-attestations.sh")
    expect(spawnSync("bash", [script, bundle, "bad", output], { encoding: "utf8" }).status).not.toBe(0)
    mkdirSync(output)
    expect(spawnSync("bash", [script, bundle, "a".repeat(40), output], {
      encoding: "utf8",
      env: { ...process.env, GH_TOKEN: "test-token-not-a-secret" },
    }).status).not.toBe(0)
  })
})
