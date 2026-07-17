import { createHash } from "node:crypto"
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { join, resolve } from "node:path"
import { TextDecoder } from "node:util"
import {
  OPEN_DESIGN_HOST_VERSION,
  validateAndSummarizeOpenDesignRcAcceptanceIntake,
} from "../qa/open-design-rc-acceptance-evidence"

const SOURCE_SHA = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const EXPECTED_FILES = [
  "SHA256SUMS",
  "open-design-rc-acceptance-evidence.json",
  "open-design-rc-acceptance-intake.json",
] as const

function digest(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

function realFile(root: string, name: (typeof EXPECTED_FILES)[number]): string {
  const path = join(root, name)
  const metadata = lstatSync(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || realpathSync(path) !== path || metadata.size < 3 || metadata.size > 256 * 1024) {
    throw new Error(`OpenDesign acceptance entry is invalid: ${name}`)
  }
  return path
}

function strictUtf8(path: string, label: string): { bytes: Buffer; source: string } {
  const bytes = readFileSync(path)
  let source: string
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${label} is not valid UTF-8`)
  }
  if (!bytes.equals(Buffer.from(source, "utf8"))) throw new Error(`${label} is not canonical UTF-8`)
  return { bytes, source }
}

function canonicalJson(path: string, label: string): { bytes: Buffer; source: string; value: unknown } {
  const { bytes, source } = strictUtf8(path, label)
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error(`${label} is not JSON`)
  }
  if (source !== canonical(value)) throw new Error(`${label} is not canonical`)
  return { bytes, source, value }
}

export interface OpenDesignAcceptanceBinding {
  artifactDigest: string
  artifactId: string
  artifactName: "open-design-rc-acceptance-evidence"
  machineRunId: string
  runId: string
  summarySha256: string
  visualRunId: string
  workflowPath: ".github/workflows/open-design-rc-acceptance.yml"
}

export function verifyOpenDesignAcceptanceArtifact(
  rootPath: string,
  expectedSourceSha: string,
  expectedHostBuildRunId: string,
  expectedHostDmgSha256: string,
  artifactAuthority: { artifactDigest: string; artifactId: string; runId: string },
): OpenDesignAcceptanceBinding {
  if (!SOURCE_SHA.test(expectedSourceSha) || !/^[1-9][0-9]*$/.test(expectedHostBuildRunId)
    || !SHA256.test(expectedHostDmgSha256) || !/^sha256:[0-9a-f]{64}$/.test(artifactAuthority.artifactDigest)
    || !/^[1-9][0-9]*$/.test(artifactAuthority.artifactId) || !/^[1-9][0-9]*$/.test(artifactAuthority.runId)) {
    throw new Error("OpenDesign acceptance authority input is invalid")
  }
  const root = resolve(rootPath)
  const metadata = lstatSync(root)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(root) !== root) {
    throw new Error("OpenDesign acceptance root is invalid")
  }
  const entries = readdirSync(root).sort()
  if (entries.length !== EXPECTED_FILES.length || entries.some((entry, index) => entry !== EXPECTED_FILES[index])) {
    throw new Error("OpenDesign acceptance closure differs")
  }
  const paths = Object.fromEntries(EXPECTED_FILES.map((name) => [name, realFile(root, name)])) as Record<(typeof EXPECTED_FILES)[number], string>
  const intake = canonicalJson(paths["open-design-rc-acceptance-intake.json"], "OpenDesign acceptance intake")
  const summary = canonicalJson(paths["open-design-rc-acceptance-evidence.json"], "OpenDesign acceptance summary")
  const regenerated = validateAndSummarizeOpenDesignRcAcceptanceIntake(intake.value, expectedSourceSha)
  if (summary.source !== canonical(regenerated)) throw new Error("OpenDesign acceptance summary differs from its validated intake")
  if (regenerated.hostVersion !== OPEN_DESIGN_HOST_VERSION
    || regenerated.hostBuildRunId.toString() !== expectedHostBuildRunId
    || regenerated.hostArtifactSha256 !== expectedHostDmgSha256
    || regenerated.hostHeadSha !== expectedSourceSha
    || regenerated.paidTurns !== 40 || regenerated.previewHumanPasses !== 20
    || regenerated.oldStackTasksPassed !== 20 || regenerated.newStackConsecutivePassed !== 20
    || regenerated.blackoutTasksPassed !== 20 || regenerated.requiredCiPassed !== true
    || regenerated.rollbackExercisePassed !== true) {
    throw new Error("OpenDesign acceptance does not bind the exact Engineering RC and completed gates")
  }
  const expectedSums = [
    `${digest(summary.bytes)}  open-design-rc-acceptance-evidence.json`,
    `${digest(intake.bytes)}  open-design-rc-acceptance-intake.json`,
  ].sort().join("\n") + "\n"
  if (strictUtf8(paths.SHA256SUMS, "OpenDesign acceptance SHA256SUMS").source !== expectedSums) {
    throw new Error("OpenDesign acceptance SHA256SUMS differs")
  }
  return {
    artifactDigest: artifactAuthority.artifactDigest,
    artifactId: artifactAuthority.artifactId,
    artifactName: "open-design-rc-acceptance-evidence",
    machineRunId: regenerated.machineEvidence.runId.toString(),
    runId: artifactAuthority.runId,
    summarySha256: digest(summary.bytes),
    visualRunId: regenerated.visualEvidence.runId.toString(),
    workflowPath: ".github/workflows/open-design-rc-acceptance.yml",
  }
}

if (import.meta.main) {
  const [root, sourceSha, hostBuildRunId, hostDmgSha256, runId, artifactId, artifactDigest] = process.argv.slice(2)
  if (!root || !sourceSha || !hostBuildRunId || !hostDmgSha256 || !runId || !artifactId || !artifactDigest) {
    throw new Error("Usage: verify-open-design-acceptance-artifact.ts ROOT SOURCE_SHA HOST_BUILD_RUN_ID HOST_DMG_SHA256 RUN_ID ARTIFACT_ID ARTIFACT_DIGEST")
  }
  console.log(JSON.stringify(verifyOpenDesignAcceptanceArtifact(
    root,
    sourceSha,
    hostBuildRunId,
    hostDmgSha256,
    { runId, artifactId, artifactDigest },
  )))
}
