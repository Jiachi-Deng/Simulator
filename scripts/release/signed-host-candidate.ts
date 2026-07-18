import { createHash } from "node:crypto"
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"

const SHA256 = /^[0-9a-f]{64}$/
const SOURCE_SHA = /^[0-9a-f]{40}$/
const POSITIVE_ID = /^[1-9][0-9]*$/
const TEAM_ID = /^[A-Z0-9]{10}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/
const RC_LABEL = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-rc\.([1-9][0-9]*)$/

export const SIGNED_CANDIDATE_NAME_PATTERN = /^simulator-host-(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?-macos-arm64-developer-id-candidate-[0-9a-f]{40}$/
export const ENGINEERING_RC_NAME_PATTERN = /^simulator-(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-rc\.([1-9][0-9]*)-macos-arm64-unsigned$/

export const SIGNED_CANDIDATE_CLOSURE = [
  "SHA256SUMS",
  "Simulator-arm64.dmg",
  "Simulator-arm64.zip",
  "app-notarization.json",
  "attestations/provenance.sigstore.json",
  "dmg-notarization.json",
  "dmg-signatures.json",
  "h3-human-observation-v1.schema.json",
  "h3-post-install-authority-v1.schema.json",
  "h3-post-install-v1.schema.json",
  "payload-equivalence.json",
  "signed-host-manifest.json",
  "signed-host-provenance.json",
  "zip-signatures.json",
] as const

export const SIGNED_CANDIDATE_PRE_ATTESTATION_CLOSURE = SIGNED_CANDIDATE_CLOSURE.filter(
  (path) => path !== "SHA256SUMS" && path !== "attestations/provenance.sigstore.json",
)

const manifestFileKeys = [
  "appNotarization", "dmg", "dmgNotarization", "dmgSignatures", "h3HumanObservationSchema", "h3PostInstallAuthoritySchema", "h3PostInstallSchema",
  "payloadEquivalence", "provenance", "zip", "zipSignatures",
] as const

type RecordValue = Record<string, unknown>

function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as RecordValue
}

function exactKeys(value: RecordValue, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} keys differ`)
  }
}

function string(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`Invalid ${label}`)
  return value
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`Invalid ${label}`)
  return value as number
}

function digest(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (typeof value === "object" && value !== null) {
    const item = value as RecordValue
    return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${stable(item[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function validateFileRecord(value: unknown, expectedPath: string, label: string): { path: string; sha256: string; bytes: number } {
  const item = record(value, label)
  exactKeys(item, ["bytes", "path", "sha256"], label)
  if (item.path !== expectedPath) throw new Error(`${label} path differs`)
  return {
    path: expectedPath,
    sha256: string(item.sha256, SHA256, `${label}.sha256`),
    bytes: integer(item.bytes, `${label}.bytes`),
  }
}

export interface SignedHostManifest extends RecordValue {
  schemaVersion: 1
  kind: "simulator-macos-arm64-developer-id-candidate"
  repository: "Jiachi-Deng/Simulator"
  sourceSha: string
  hostVersion: string
  artifactName: string
  workflow: RecordValue
  engineeringRc: RecordValue
  openDesignAcceptance: RecordValue
  identity: RecordValue
  notarization: RecordValue
  gatekeeper: RecordValue
  payloadEquivalence: RecordValue
  files: RecordValue
}

export function validateSignedHostManifest(value: unknown): SignedHostManifest {
  const manifest = record(value, "manifest")
  exactKeys(manifest, [
    "artifactName", "engineeringRc", "files", "gatekeeper", "hostVersion", "identity", "kind",
    "notarization", "openDesignAcceptance", "payloadEquivalence", "repository", "schemaVersion", "sourceSha", "workflow",
  ], "manifest")
  if (manifest.schemaVersion !== 1 || manifest.kind !== "simulator-macos-arm64-developer-id-candidate"
    || manifest.repository !== "Jiachi-Deng/Simulator") throw new Error("Manifest authority differs")
  const sourceSha = string(manifest.sourceSha, SOURCE_SHA, "sourceSha")
  const hostVersion = string(manifest.hostVersion, VERSION, "hostVersion")
  const expectedName = `simulator-host-${hostVersion}-macos-arm64-developer-id-candidate-${sourceSha}`
  if (manifest.artifactName !== expectedName || !SIGNED_CANDIDATE_NAME_PATTERN.test(expectedName)) throw new Error("Candidate Artifact name differs")

  const workflow = record(manifest.workflow, "workflow")
  exactKeys(workflow, ["environment", "name", "runAttempt", "runId"], "workflow")
  if (workflow.name !== "signed-macos-host-acceptance.yml" || workflow.environment !== "signed-host-acceptance"
    || workflow.runAttempt !== 1) throw new Error("Workflow authority differs")
  string(workflow.runId, POSITIVE_ID, "workflow.runId")

  const engineeringRc = record(manifest.engineeringRc, "engineeringRc")
  exactKeys(engineeringRc, ["artifactDigest", "artifactId", "artifactName", "dmgSha256", "rcLabel", "runId", "zipSha256"], "engineeringRc")
  const rcLabel = string(engineeringRc.rcLabel, RC_LABEL, "engineeringRc.rcLabel")
  if (engineeringRc.artifactName !== `simulator-${rcLabel}-macos-arm64-unsigned`
    || !ENGINEERING_RC_NAME_PATTERN.test(String(engineeringRc.artifactName))) throw new Error("Engineering RC Artifact name differs")
  if (rcLabel.replace(/-rc\.[1-9][0-9]*$/, "") !== hostVersion) throw new Error("Engineering RC version differs from Host version")
  const engineeringRunId = string(engineeringRc.runId, POSITIVE_ID, "engineeringRc.runId")
  string(engineeringRc.artifactId, POSITIVE_ID, "engineeringRc.artifactId")
  string(engineeringRc.artifactDigest, /^sha256:[0-9a-f]{64}$/, "engineeringRc.artifactDigest")
  const baselineDmg = string(engineeringRc.dmgSha256, SHA256, "engineeringRc.dmgSha256")
  const baselineZip = string(engineeringRc.zipSha256, SHA256, "engineeringRc.zipSha256")

  const openDesignAcceptance = record(manifest.openDesignAcceptance, "openDesignAcceptance")
  exactKeys(openDesignAcceptance, [
    "artifactDigest", "artifactId", "artifactName", "machineRunId", "runId", "summarySha256", "visualRunId", "workflowPath",
  ], "openDesignAcceptance")
  if (openDesignAcceptance.artifactName !== "open-design-rc-acceptance-evidence"
    || openDesignAcceptance.workflowPath !== ".github/workflows/open-design-rc-acceptance.yml") {
    throw new Error("OpenDesign acceptance authority differs")
  }
  const acceptanceRunId = string(openDesignAcceptance.runId, POSITIVE_ID, "openDesignAcceptance.runId")
  const machineRunId = string(openDesignAcceptance.machineRunId, POSITIVE_ID, "openDesignAcceptance.machineRunId")
  const visualRunId = string(openDesignAcceptance.visualRunId, POSITIVE_ID, "openDesignAcceptance.visualRunId")
  string(openDesignAcceptance.artifactId, POSITIVE_ID, "openDesignAcceptance.artifactId")
  string(openDesignAcceptance.artifactDigest, /^sha256:[0-9a-f]{64}$/, "openDesignAcceptance.artifactDigest")
  string(openDesignAcceptance.summarySha256, SHA256, "openDesignAcceptance.summarySha256")
  if (new Set([engineeringRunId, acceptanceRunId, machineRunId, visualRunId]).size !== 4) {
    throw new Error("OpenDesign acceptance run identities overlap")
  }

  const identity = record(manifest.identity, "identity")
  exactKeys(identity, ["bundleIdentifier", "developerIdApplication", "entitlementsSha256", "teamId"], "identity")
  string(identity.bundleIdentifier, /^[A-Za-z0-9][A-Za-z0-9.-]+$/, "identity.bundleIdentifier")
  const subject = string(identity.developerIdApplication, /^Developer ID Application: .+ \([A-Z0-9]{10}\)$/, "identity.developerIdApplication")
  const teamId = string(identity.teamId, TEAM_ID, "identity.teamId")
  if (!subject.endsWith(`(${teamId})`)) throw new Error("Developer ID subject and Team ID differ")
  string(identity.entitlementsSha256, SHA256, "identity.entitlementsSha256")

  const notarization = record(manifest.notarization, "notarization")
  exactKeys(notarization, ["app", "dmg"], "notarization")
  for (const key of ["app", "dmg"] as const) {
    const item = record(notarization[key], `notarization.${key}`)
    exactKeys(item, ["id", "stapled", "status", "submittedSha256", "validated"], `notarization.${key}`)
    string(item.id, UUID, `notarization.${key}.id`)
    string(item.submittedSha256, SHA256, `notarization.${key}.submittedSha256`)
    if (item.status !== "Accepted" || item.stapled !== true || item.validated !== true) throw new Error(`${key} notarization gate did not pass`)
  }

  const gatekeeper = record(manifest.gatekeeper, "gatekeeper")
  exactKeys(gatekeeper, ["app", "dmg"], "gatekeeper")
  if (gatekeeper.app !== "PASS" || gatekeeper.dmg !== "PASS") throw new Error("Gatekeeper gate did not pass")

  const equivalence = record(manifest.payloadEquivalence, "payloadEquivalence")
  exactKeys(equivalence, ["canonicalInventorySha256", "equivalent", "normalizedMachOFiles", "policy", "reportSha256"], "payloadEquivalence")
  if (equivalence.equivalent !== true || equivalence.policy !== "macos-dual-container-app-payload-equivalence-v1") throw new Error("Payload equivalence gate did not pass")
  string(equivalence.canonicalInventorySha256, SHA256, "payloadEquivalence.canonicalInventorySha256")
  string(equivalence.reportSha256, SHA256, "payloadEquivalence.reportSha256")
  integer(equivalence.normalizedMachOFiles, "payloadEquivalence.normalizedMachOFiles")

  const files = record(manifest.files, "files")
  exactKeys(files, manifestFileKeys, "files")
  const expectedPaths: Record<(typeof manifestFileKeys)[number], string> = {
    dmg: "Simulator-arm64.dmg",
    zip: "Simulator-arm64.zip",
    payloadEquivalence: "payload-equivalence.json",
    dmgSignatures: "dmg-signatures.json",
    zipSignatures: "zip-signatures.json",
    appNotarization: "app-notarization.json",
    dmgNotarization: "dmg-notarization.json",
    provenance: "signed-host-provenance.json",
    h3HumanObservationSchema: "h3-human-observation-v1.schema.json",
    h3PostInstallAuthoritySchema: "h3-post-install-authority-v1.schema.json",
    h3PostInstallSchema: "h3-post-install-v1.schema.json",
  }
  const fileRecords = Object.fromEntries(manifestFileKeys.map((key) => [key, validateFileRecord(files[key], expectedPaths[key], `files.${key}`)])) as Record<(typeof manifestFileKeys)[number], { path: string; sha256: string; bytes: number }>
  if (fileRecords.dmg.sha256 === baselineDmg || fileRecords.zip.sha256 === baselineZip) throw new Error("Signed Artifact digest reuses unsigned Engineering RC digest")
  if (fileRecords.payloadEquivalence.sha256 !== equivalence.reportSha256) throw new Error("Payload equivalence report digest differs")
  return manifest as SignedHostManifest
}

function safeFile(root: string, relative: string): string {
  const path = join(root, ...relative.split("/"))
  const metadata = lstatSync(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || realpathSync(path) !== path) throw new Error(`Candidate closure entry must be one real file: ${relative}`)
  return path
}

function actualClosure(root: string): string[] {
  const result: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === "attestations") {
      for (const nested of readdirSync(join(root, entry.name), { withFileTypes: true })) {
        if (!nested.isFile()) throw new Error("Attestation closure contains a non-file")
        result.push(`attestations/${nested.name}`)
      }
    } else if (entry.isFile()) result.push(entry.name)
    else throw new Error(`Candidate closure contains an unexpected entry: ${entry.name}`)
  }
  return result.sort()
}

function validateContainerEquivalence(value: unknown, label: string): RecordValue {
  const evidence = record(value, label)
  exactKeys(evidence, [
    "baselineCanonicalInventorySha256", "baselineRootName", "candidateCanonicalInventorySha256", "candidateRootName",
    "directories", "equivalent", "exactFiles", "normalizedMachOFiles", "pathCount", "policy", "schemaVersion",
    "signatureMetadataFiles", "symlinks",
  ], label)
  if (evidence.schemaVersion !== 1 || evidence.equivalent !== true
    || evidence.policy !== "macos-app-payload-excluding-signature-metadata-v1"
    || evidence.baselineRootName !== "Simulator.app" || evidence.candidateRootName !== "Simulator.app") {
    throw new Error(`${label} authority differs`)
  }
  const baselineDigest = string(evidence.baselineCanonicalInventorySha256, SHA256, `${label}.baselineCanonicalInventorySha256`)
  const candidateDigest = string(evidence.candidateCanonicalInventorySha256, SHA256, `${label}.candidateCanonicalInventorySha256`)
  if (baselineDigest !== candidateDigest) throw new Error(`${label} canonical inventory differs`)
  const countKeys = ["directories", "exactFiles", "normalizedMachOFiles", "pathCount", "signatureMetadataFiles", "symlinks"] as const
  const counts = Object.fromEntries(countKeys.map((key) => {
    if (!Number.isSafeInteger(evidence[key]) || (evidence[key] as number) < 0) throw new Error(`${label}.${key} is invalid`)
    return [key, evidence[key] as number]
  })) as Record<(typeof countKeys)[number], number>
  if (counts.normalizedMachOFiles < 1 || counts.pathCount < 1
    || counts.pathCount !== counts.directories + counts.exactFiles + counts.normalizedMachOFiles + counts.signatureMetadataFiles + counts.symlinks) {
    throw new Error(`${label} count closure differs`)
  }
  return evidence
}

function validateJsonEvidence(root: string, manifest: SignedHostManifest): void {
  const identity = manifest.identity as RecordValue
  const files = manifest.files as RecordValue
  for (const key of ["dmgSignatures", "zipSignatures"] as const) {
    const file = files[key] as RecordValue
    const evidence = record(JSON.parse(readFileSync(join(root, String(file.path)), "utf8")), key)
    exactKeys(evidence, ["developerId", "kinds", "machOCount", "objects", "ok", "policy", "requiredArm64MachOFileType", "requiredArm64MachOPath"], key)
    if (evidence.ok !== true || evidence.policy !== "developer-id-strict" || !Array.isArray(evidence.objects) || evidence.objects.length < 2) throw new Error(`${key} is not strict Developer ID evidence`)
    const evidenceIdentity = record(evidence.developerId, `${key}.developerIdPolicy`)
    exactKeys(evidenceIdentity, ["authority", "bundleIdentifier", "entitlementsSha256", "teamIdentifier"], `${key}.developerIdPolicy`)
    if (evidenceIdentity.authority !== identity.developerIdApplication || evidenceIdentity.teamIdentifier !== identity.teamId
      || evidenceIdentity.bundleIdentifier !== identity.bundleIdentifier || evidenceIdentity.entitlementsSha256 !== identity.entitlementsSha256) {
      throw new Error(`${key} Developer ID policy differs from manifest`)
    }
    if (!Number.isSafeInteger(evidence.machOCount) || evidence.machOCount !== evidence.objects.length - 1
      || !Array.isArray(evidence.kinds) || evidence.kinds.length !== evidence.objects.length
      || evidence.kinds.some((kind) => kind !== "developer-id")
      || evidence.requiredArm64MachOFileType !== "EXECUTE" || typeof evidence.requiredArm64MachOPath !== "string") {
      throw new Error(`${key} code-object closure differs`)
    }
    const objectPaths = new Set<string>()
    let appEntitlements: Set<string> | undefined
    const nestedEntitlements: Array<{ path: string; keys: string[] }> = []
    for (const objectValue of evidence.objects) {
      const object = record(objectValue, `${key}.object`)
      exactKeys(object, ["architectures", "developerId", "kind", "path", "strictVerification"], `${key}.object`)
      const developerId = record(object.developerId, `${key}.developerId`)
      exactKeys(developerId, ["authority", "entitlements", "hardenedRuntime", "teamIdentifier", "timestamped"], `${key}.developerId`)
      const strictVerification = record(object.strictVerification, `${key}.strictVerification`)
      exactKeys(strictVerification, ["exitCode", "required"], `${key}.strictVerification`)
      if (typeof object.path !== "string" || objectPaths.has(object.path)) throw new Error(`${key} code-object path differs`)
      objectPaths.add(object.path)
      if (!Array.isArray(object.architectures)
        || object.architectures.some((architecture) => typeof architecture !== "string")
        || (object.path === "."
          ? object.architectures.length !== 0
          : object.architectures.length !== 1 || object.architectures[0] !== "arm64")) {
        throw new Error(`${key} code-object architecture differs`)
      }
      if (!Array.isArray(developerId.entitlements)
        || developerId.entitlements.some((entitlement) => typeof entitlement !== "string")
        || new Set(developerId.entitlements as string[]).size !== developerId.entitlements.length) {
        throw new Error(`${key} entitlement evidence differs`)
      }
      const entitlementKeys = developerId.entitlements as string[]
      if (object.path === ".") appEntitlements = new Set(entitlementKeys)
      else nestedEntitlements.push({ path: object.path, keys: entitlementKeys })
      if (object.kind !== "developer-id" || strictVerification.required !== true || strictVerification.exitCode !== 0
        || developerId.authority !== identity.developerIdApplication || developerId.teamIdentifier !== identity.teamId
        || developerId.timestamped !== true || developerId.hardenedRuntime !== true) throw new Error(`${key} contains an untrusted code object`)
    }
    if (!appEntitlements) throw new Error(`${key} app entitlement evidence is missing`)
    for (const nested of nestedEntitlements) {
      if (nested.keys.some((entitlement) => !appEntitlements?.has(entitlement))) {
        throw new Error(`${key} nested entitlement is not a subset of the reviewed app entitlement closure: ${nested.path}`)
      }
    }
    if (!objectPaths.has(".") || !evidence.objects.some((value: unknown) => {
      const object = value as RecordValue
      return object.path === evidence.requiredArm64MachOPath && Array.isArray(object.architectures)
        && object.architectures.length === 1 && object.architectures[0] === "arm64"
    })) throw new Error(`${key} required arm64 executable evidence differs`)
  }
  for (const [key, kind] of [
    ["appNotarization", "app"],
    ["dmgNotarization", "dmg"],
  ] as const) {
    const file = files[key] as RecordValue
    const evidence = record(JSON.parse(readFileSync(join(root, String(file.path)), "utf8")), key)
    exactKeys(evidence, ["artifactKind", "id", "schemaVersion", "status", "submittedArtifactSha256"], key)
    const notaryRecord = record((manifest.notarization as RecordValue)[kind], `notarization.${kind}`)
    if (evidence.schemaVersion !== 1 || evidence.artifactKind !== kind || evidence.status !== "Accepted"
      || evidence.id !== notaryRecord.id || evidence.submittedArtifactSha256 !== notaryRecord.submittedSha256) throw new Error(`${key} differs from manifest`)
  }
  const equivalenceFile = files.payloadEquivalence as RecordValue
  const equivalence = record(JSON.parse(readFileSync(join(root, String(equivalenceFile.path)), "utf8")), "payload-equivalence")
  exactKeys(equivalence, ["canonicalInventorySha256", "containers", "equivalent", "normalizedMachOFiles", "policy", "schemaVersion"], "payload-equivalence")
  const manifestEquivalence = manifest.payloadEquivalence as RecordValue
  const containers = record(equivalence.containers, "payload-equivalence.containers")
  exactKeys(containers, ["dmg", "zip"], "payload-equivalence.containers")
  const dmgEquivalence = validateContainerEquivalence(containers.dmg, "payload-equivalence.containers.dmg")
  const zipEquivalence = validateContainerEquivalence(containers.zip, "payload-equivalence.containers.zip")
  if (stable(dmgEquivalence) !== stable(zipEquivalence)
    || equivalence.schemaVersion !== 1 || equivalence.equivalent !== true
    || equivalence.policy !== "macos-dual-container-app-payload-equivalence-v1"
    || equivalence.policy !== manifestEquivalence.policy
    || equivalence.canonicalInventorySha256 !== manifestEquivalence.canonicalInventorySha256
    || equivalence.canonicalInventorySha256 !== dmgEquivalence.baselineCanonicalInventorySha256
    || equivalence.normalizedMachOFiles !== manifestEquivalence.normalizedMachOFiles
    || equivalence.normalizedMachOFiles !== dmgEquivalence.normalizedMachOFiles) {
    throw new Error("Payload equivalence evidence differs from manifest")
  }

  const provenanceFile = files.provenance as RecordValue
  const provenance = record(JSON.parse(readFileSync(join(root, String(provenanceFile.path)), "utf8")), "provenance")
  exactKeys(provenance, ["createdAt", "engineeringRc", "hostVersion", "identity", "kind", "openDesignAcceptance", "outputs", "repository", "schemaVersion", "signed", "sourceSha", "workflow"], "provenance")
  if (provenance.schemaVersion !== 1 || provenance.kind !== "simulator-macos-arm64-developer-id-candidate-provenance"
    || provenance.repository !== manifest.repository || provenance.sourceSha !== manifest.sourceSha
    || provenance.hostVersion !== manifest.hostVersion || provenance.signed !== true
    || stable(provenance.workflow) !== stable(manifest.workflow)
    || stable(provenance.engineeringRc) !== stable(manifest.engineeringRc)
    || stable(provenance.openDesignAcceptance) !== stable(manifest.openDesignAcceptance)
    || stable(provenance.identity) !== stable(manifest.identity)) throw new Error("Signed Host provenance authority differs")
  const createdAt = string(provenance.createdAt, /^\d{4}-(?:0[1-9]|1[0-2])-(?:[0-2]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/, "provenance.createdAt")
  if (new Date(createdAt).toISOString() !== createdAt) throw new Error("Provenance timestamp is not canonical UTC")
  const outputs = record(provenance.outputs, "provenance.outputs")
  exactKeys(outputs, ["dmgSha256", "payloadEquivalenceSha256", "zipSha256"], "provenance.outputs")
  if (outputs.dmgSha256 !== (files.dmg as RecordValue).sha256 || outputs.zipSha256 !== (files.zip as RecordValue).sha256
    || outputs.payloadEquivalenceSha256 !== (files.payloadEquivalence as RecordValue).sha256) throw new Error("Provenance output digest differs")

  const authoritySchemaFile = files.h3PostInstallAuthoritySchema as RecordValue
  const authoritySchemaPath = join(root, String(authoritySchemaFile.path))
  const authoritySchemaBytes = readFileSync(authoritySchemaPath)
  if (!authoritySchemaBytes.equals(readFileSync(join(import.meta.dir, "schemas", "h3-post-install-authority-v1.schema.json")))) {
    throw new Error("H3 post-install authority schema differs from the source contract")
  }
  const authorityClosureSchema = record(JSON.parse(authoritySchemaBytes.toString("utf8")), "H3 post-install authority schema")
  const authorityClosureProperties = record(authorityClosureSchema.properties, "H3 post-install authority schema properties")
  const githubAuthoritySchema = record(authorityClosureProperties.github, "H3 GitHub authority schema")
  if (authorityClosureSchema.additionalProperties !== false || githubAuthoritySchema.additionalProperties !== false
    || !Array.isArray(authorityClosureSchema.required) || !authorityClosureSchema.required.includes("github")
    || !authorityClosureSchema.required.includes("rawCandidate") || !authorityClosureSchema.required.includes("postInstall")) {
    throw new Error("H3 post-install authority schema is not the strict v1 contract")
  }

  const postInstallSchemaFile = files.h3PostInstallSchema as RecordValue
  const postInstallSchemaPath = join(root, String(postInstallSchemaFile.path))
  const postInstallSchemaBytes = readFileSync(postInstallSchemaPath)
  if (!postInstallSchemaBytes.equals(readFileSync(join(import.meta.dir, "schemas", "h3-post-install-v1.schema.json")))) {
    throw new Error("H3 post-install schema differs from the source contract")
  }
  const postInstallSchema = record(JSON.parse(postInstallSchemaBytes.toString("utf8")), "H3 post-install schema")
  if (postInstallSchema.additionalProperties !== false || !Array.isArray(postInstallSchema.required)
    || !postInstallSchema.required.includes("artifactName") || !postInstallSchema.required.includes("artifactDigest")
    || !postInstallSchema.required.includes("developerIdApplication") || !postInstallSchema.required.includes("installedAppIdentitySha256")) {
    throw new Error("H3 post-install schema is not the strict v1 contract")
  }

  const humanSchemaFile = files.h3HumanObservationSchema as RecordValue
  const humanSchemaPath = join(root, String(humanSchemaFile.path))
  const humanSchemaBytes = readFileSync(humanSchemaPath)
  if (!humanSchemaBytes.equals(readFileSync(join(import.meta.dir, "schemas", "h3-human-observation-v1.schema.json")))) {
    throw new Error("H3 human-observation schema differs from the source contract")
  }
  const humanSchema = record(JSON.parse(humanSchemaBytes.toString("utf8")), "H3 human-observation schema")
  const humanProperties = record(humanSchema.properties, "H3 human-observation schema properties")
  const authoritySchema = record(humanProperties.authority, "H3 human-observation authority schema")
  const authorityProperties = record(authoritySchema.properties, "H3 human-observation authority properties")
  const artifactNameSchema = record(authorityProperties.artifactName, "H3 human-observation artifactName schema")
  const observationSchema = record(humanProperties.observations, "H3 human-observation observations schema")
  const recoverySchema = record(humanProperties.recovery, "H3 human-observation recovery schema")
  const definitions = record(humanSchema.$defs, "H3 human-observation schema definitions")
  const screenshotSchema = record(definitions.screenshot, "H3 human-observation screenshot schema")
  const recoveryPass = record(definitions.recoveryPass, "H3 recovery PASS schema")
  const recoveryNotNeeded = record(definitions.recoveryNotNeeded, "H3 recovery NOT NEEDED schema")
  if (humanSchema.additionalProperties !== false
    || stable(humanSchema.required) !== stable(["schemaVersion", "kind", "authority", "createdAt", "observations", "recovery"])
    || authoritySchema.additionalProperties !== false
    || artifactNameSchema.pattern !== SIGNED_CANDIDATE_NAME_PATTERN.source
    || observationSchema.minItems !== 3 || observationSchema.maxItems !== 3 || observationSchema.items !== false
    || !Array.isArray(observationSchema.prefixItems) || observationSchema.prefixItems.length !== 3
    || !Array.isArray(recoverySchema.oneOf) || recoverySchema.oneOf.length !== 2
    || screenshotSchema.additionalProperties !== false
    || recoveryPass.additionalProperties !== false || recoveryNotNeeded.additionalProperties !== false) {
    throw new Error("H3 human-observation schema is not the strict v1 contract")
  }
}

function verifySignedHostCandidateCore(
  rootPath: string,
  expectedSourceSha: string,
  expectedRunId: string,
  expectedArtifactName: string,
  expectedClosure: readonly string[],
): { root: string; manifest: SignedHostManifest } {
  const root = resolve(rootPath)
  const rootMetadata = lstatSync(root)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || realpathSync(root) !== root) {
    throw new Error("Candidate root must be one real directory without aliases or symlinks")
  }
  const closure = actualClosure(root)
  if (closure.length !== expectedClosure.length || closure.some((path, index) => path !== expectedClosure[index])) throw new Error(`Signed Candidate closure differs: ${closure.join(",")}`)
  const manifestPath = safeFile(root, "signed-host-manifest.json")
  const manifestBytes = readFileSync(manifestPath, "utf8")
  const manifest = validateSignedHostManifest(JSON.parse(manifestBytes))
  if (manifestBytes !== `${stable(manifest)}\n`) throw new Error("Signed Host manifest is not canonical")
  if (manifest.sourceSha !== expectedSourceSha || (manifest.workflow as RecordValue).runId !== expectedRunId || manifest.artifactName !== expectedArtifactName) throw new Error("Expected Candidate authority differs")
  const files = manifest.files as RecordValue
  for (const key of manifestFileKeys) {
    const expected = files[key] as RecordValue
    const path = safeFile(root, String(expected.path))
    const bytes = readFileSync(path)
    if (bytes.length !== expected.bytes || digest(bytes) !== expected.sha256) throw new Error(`Candidate file evidence differs: ${expected.path}`)
  }
  validateJsonEvidence(root, manifest)
  return { root, manifest }
}

export function verifyPreAttestationSignedHostCandidate(rootPath: string, expectedSourceSha: string, expectedRunId: string, expectedArtifactName: string): SignedHostManifest {
  return verifySignedHostCandidateCore(
    rootPath,
    expectedSourceSha,
    expectedRunId,
    expectedArtifactName,
    SIGNED_CANDIDATE_PRE_ATTESTATION_CLOSURE,
  ).manifest
}

export function verifySignedHostCandidate(rootPath: string, expectedSourceSha: string, expectedRunId: string, expectedArtifactName: string): SignedHostManifest {
  const { root, manifest } = verifySignedHostCandidateCore(
    rootPath,
    expectedSourceSha,
    expectedRunId,
    expectedArtifactName,
    SIGNED_CANDIDATE_CLOSURE,
  )
  const sumsPath = safeFile(root, "SHA256SUMS")
  const expectedSumPaths = SIGNED_CANDIDATE_CLOSURE.filter((path) => path !== "SHA256SUMS")
  const expectedSums = expectedSumPaths.map((relative) => `${digest(readFileSync(safeFile(root, relative)))}  ${relative}`).join("\n") + "\n"
  if (readFileSync(sumsPath, "utf8") !== expectedSums) throw new Error("SHA256SUMS does not bind the exact Candidate closure")
  return manifest
}

export function writeCanonicalSignedHostManifest(inputPath: string, outputPath: string): SignedHostManifest {
  const manifest = validateSignedHostManifest(JSON.parse(readFileSync(inputPath, "utf8")))
  writeFileSync(outputPath, `${stable(manifest)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 })
  return manifest
}

if (import.meta.main) {
  const [operation, first, second, third, fourth] = process.argv.slice(2)
  if (operation === "generate" && first && second && !third) {
    writeCanonicalSignedHostManifest(first, second)
    console.log(JSON.stringify({ ok: true, path: resolve(second) }))
  } else if (operation === "validate-pre" && first && second && third && fourth) {
    const manifest = verifyPreAttestationSignedHostCandidate(first, second, third, fourth)
    console.log(JSON.stringify({ ok: true, phase: "pre-attestation", artifactName: manifest.artifactName, sourceSha: manifest.sourceSha }))
  } else if (operation === "validate" && first && second && third && fourth) {
    const manifest = verifySignedHostCandidate(first, second, third, fourth)
    console.log(JSON.stringify({ ok: true, artifactName: manifest.artifactName, sourceSha: manifest.sourceSha }))
  } else {
    throw new Error("Usage: signed-host-candidate.ts generate INPUT OUTPUT | validate-pre ROOT SOURCE_SHA RUN_ID ARTIFACT_NAME | validate ROOT SOURCE_SHA RUN_ID ARTIFACT_NAME")
  }
}
