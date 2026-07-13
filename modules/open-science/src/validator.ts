import { createHash } from "node:crypto"
import { lstat, readdir, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { parseTrustDecision } from "./trust-decision.js"
import { OPENSCIENCE_PIN as PIN } from "./pins.js"
import type {
  ArtifactInventory, ArtifactRole, BuildBindings, InventoryFile, RuntimeBindings, RuntimePolicy, TrustDecision,
  ValidationOptions, VerificationIdentity,
} from "./types.js"

const MAX_FILE_SIZE = 256 * 1024 * 1024
const MAX_TOTAL_SIZE = 384 * 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/
const ROLE_PATHS: Record<ArtifactRole, string> = {
  binary: "bin/openscience-darwin-arm64",
  license: "LICENSE",
  notice: "NOTICE",
  "third-party-notices": "THIRD_PARTY_NOTICES",
  sbom: "sbom.cdx.json",
  checksums: "checksums.txt",
  "runtime-policy": "runtime-policy.json",
  provenance: "provenance.json",
  "third-party-decisions": "third-party-decisions.json",
  "models-snapshot": "models-dev-api.json",
  "build-attestation": "build-attestation.json",
  "runtime-conformance": "runtime-conformance.json",
}
const ROLES = new Set<ArtifactRole>(Object.keys(ROLE_PATHS) as ArtifactRole[])
const FORBIDDEN_NAMES = new Set(["auth.json", "mcp-auth.json", ".env", ".npmrc"])

interface ActualFile { path: string; bytes: Buffer; size: number; sha256: string }
interface TrustedComponent { feature: string; id: string; disposition: "required" | "excluded"; license: string }
interface TrustedComponentPolicy { policySha256: string; componentSetSha256: string; components: TrustedComponent[] }

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string, required = allowed): void {
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error(`${label} has Symbol fields`)
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`)
  const missing = required.filter((key) => !(key in value))
  if (missing.length) throw new Error(`${label} missing fields: ${missing.join(", ")}`)
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`)
  return value
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function safeRelative(filePath: string): boolean {
  return filePath.length > 0 && filePath.length <= 240 && !path.isAbsolute(filePath) && !filePath.includes("\\") &&
    filePath.split("/").every((part) => part !== "" && part !== "." && part !== "..")
}

function collisionKey(filePath: string): string {
  return filePath.normalize("NFKC").toLocaleLowerCase("en-US")
}

export function parseInventory(input: unknown): ArtifactInventory {
  const root = record(input, "inventory")
  exactKeys(root, ["schemaVersion", "source", "artifact", "files"], "inventory")
  const source = record(root.source, "source")
  const artifact = record(root.artifact, "artifact")
  exactKeys(source, ["repository", "ref", "commit"], "source")
  exactKeys(artifact, ["name", "version", "platform", "arch", "format", "capabilities"], "artifact")
  if (root.schemaVersion !== 1) throw new Error("unsupported inventory schemaVersion")
  if (source.repository !== PIN.repository || source.ref !== PIN.ref || source.commit !== PIN.commit) throw new Error("source pin mismatch")
  if (artifact.name !== "openscience" || artifact.version !== "1.3.4" || artifact.platform !== "darwin" ||
      artifact.arch !== "arm64" || artifact.format !== "bun-compiled-binary" ||
      JSON.stringify(artifact.capabilities) !== JSON.stringify(["embedded-web", "rdkit"])) throw new Error("artifact profile mismatch")
  const files = array(root.files, "files")
  if (files.length !== ROLES.size) throw new Error("inventory must contain every required role exactly once")
  const paths = new Set<string>()
  const normalized = new Set<string>()
  const roles = new Set<ArtifactRole>()
  const parsed: InventoryFile[] = []
  for (const [index, raw] of files.entries()) {
    const file = record(raw, `files[${index}]`)
    exactKeys(file, ["path", "sha256", "size", "role"], `files[${index}]`)
    if (typeof file.path !== "string" || typeof file.sha256 !== "string" || typeof file.size !== "number" ||
        typeof file.role !== "string" || !ROLES.has(file.role as ArtifactRole)) throw new Error(`invalid files[${index}]`)
    const role = file.role as ArtifactRole
    if (!safeRelative(file.path)) throw new Error(`unsafe path: ${file.path}`)
    const key = collisionKey(file.path)
    if (normalized.has(key)) throw new Error(`Unicode/case path collision: ${file.path}`)
    if (paths.has(file.path) || roles.has(role)) throw new Error("duplicate inventory path or role")
    normalized.add(key); paths.add(file.path); roles.add(role)
    parsed.push(file as unknown as InventoryFile)
  }
  for (const file of parsed) {
    if (file.path !== ROLE_PATHS[file.role]) throw new Error(`role/path binding mismatch: ${file.role}`)
    if (!SHA256.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error(`invalid size or hash: ${file.path}`)
  }
  return root as unknown as ArtifactInventory
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
}

async function enumerateArtifact(root: string): Promise<Map<string, ActualFile>> {
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("artifact root must be a real directory")
  const canonicalRoot = await realpath(root)
  const leaves = new Map<string, ActualFile>()
  const normalized = new Set<string>()
  let total = 0
  async function walk(directory: string, relativeDirectory: string): Promise<void> {
    for (const entry of await readdir(directory)) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry}` : entry
      if (!safeRelative(relative)) throw new Error(`unsafe artifact path: ${relative}`)
      const key = collisionKey(relative)
      if (normalized.has(key)) throw new Error(`Unicode/case artifact path collision: ${relative}`)
      normalized.add(key)
      const absolute = path.join(directory, entry)
      const stat = await lstat(absolute)
      if (stat.isSymbolicLink()) throw new Error(`symlink forbidden: ${relative}`)
      const canonical = await realpath(absolute)
      if (!contained(canonicalRoot, canonical)) throw new Error(`artifact path escapes root: ${relative}`)
      if (stat.isDirectory()) { await walk(absolute, relative); continue }
      if (!stat.isFile()) throw new Error(`non-regular artifact leaf: ${relative}`)
      if (FORBIDDEN_NAMES.has(entry.toLowerCase()) || /credential|secret|token/i.test(relative)) throw new Error(`credential file forbidden: ${relative}`)
      if (relative.startsWith("src/") || relative.includes("node_modules/") || relative.startsWith(".git/")) throw new Error(`source checkout or dev dependency forbidden: ${relative}`)
      if (/darwin-x64|linux|win32|windows/i.test(relative)) throw new Error(`other architecture forbidden: ${relative}`)
      if (stat.size > MAX_FILE_SIZE) throw new Error(`file exceeds size limit: ${relative}`)
      total += stat.size
      if (total > MAX_TOTAL_SIZE) throw new Error("artifact exceeds total size limit")
      const bytes = await readFile(absolute)
      if (bytes.length !== stat.size) throw new Error(`file changed during validation: ${relative}`)
      leaves.set(relative, { path: relative, bytes, size: stat.size, sha256: digest(bytes) })
    }
  }
  await walk(root, "")
  return leaves
}

function closeInventory(inventory: ArtifactInventory, actual: Map<string, ActualFile>): void {
  const declared = new Map(inventory.files.map((file) => [file.path, file]))
  for (const actualPath of actual.keys()) if (!declared.has(actualPath)) throw new Error(`unlisted artifact leaf: ${actualPath}`)
  for (const [declaredPath, file] of declared) {
    const leaf = actual.get(declaredPath)
    if (!leaf) throw new Error(`missing artifact leaf: ${declaredPath}`)
    if (leaf.size !== file.size) throw new Error(`size mismatch: ${declaredPath}`)
    if (leaf.sha256 !== file.sha256) throw new Error(`hash mismatch: ${declaredPath}`)
  }
}

function parseJson(leaf: ActualFile, label: string): unknown {
  try { return JSON.parse(leaf.bytes.toString("utf8")) } catch { throw new Error(`${label} must be valid JSON`) }
}

function parseXdgTemplate(value: unknown, expectedLeaf: string): string {
  const template = nonEmptyString(value, `XDG ${expectedLeaf}`)
  if (template.includes("\\")) throw new Error("invalid XDG template separator")
  const segments = template.split("/")
  if (segments[0] !== "${SIMULATOR_OPENSCIENCE_ROOT}" || segments.length !== 2 || segments[1] !== expectedLeaf) {
    throw new Error("shared or unscoped XDG root")
  }
  if (segments.some((segment) => segment === "." || segment === "..") || path.posix.normalize(template) !== template) {
    throw new Error("invalid XDG traversal or alias")
  }
  return segments.join("/")
}

export function validateRuntimePolicy(input: unknown): RuntimePolicy {
  const policy = record(input, "runtime policy")
  exactKeys(policy, ["schemaVersion", "network", "isolation", "nativeControls", "credentials"], "runtime policy")
  const network = record(policy.network, "network")
  const isolation = record(policy.isolation, "isolation")
  const controls = record(policy.nativeControls, "nativeControls")
  const credentials = record(policy.credentials, "credentials")
  exactKeys(network, ["listen", "allowedHosts", "requireHostValidation", "requireOriginValidation"], "network")
  exactKeys(isolation, ["xdgDataHome", "xdgConfigHome", "xdgCacheHome", "xdgStateHome"], "isolation")
  exactKeys(controls, ["agent", "mcp", "permissions"], "nativeControls")
  exactKeys(credentials, ["productionPersistence", "futurePersistence"], "credentials")
  if (policy.schemaVersion !== 1 || network.listen !== "dynamic-loopback-only" ||
      JSON.stringify(network.allowedHosts) !== JSON.stringify(["127.0.0.1", "[::1]"]) ||
      network.requireHostValidation !== true || network.requireOriginValidation !== true) throw new Error("non-loopback network policy")
  const roots = [
    parseXdgTemplate(isolation.xdgDataHome, "data"), parseXdgTemplate(isolation.xdgConfigHome, "config"),
    parseXdgTemplate(isolation.xdgCacheHome, "cache"), parseXdgTemplate(isolation.xdgStateHome, "state"),
  ]
  if (new Set(roots.map((root) => path.posix.normalize(root))).size !== 4) throw new Error("XDG roots must be canonically distinct")
  if (Object.values(controls).some((value) => value !== "preserve")) throw new Error("native controls must be preserved")
  if (credentials.productionPersistence !== "forbidden" || credentials.futurePersistence !== "host-bridge-required") throw new Error("credential persistence policy mismatch")
  return policy as unknown as RuntimePolicy
}

function parseProvenance(input: unknown, modelsDigest: string): void {
  const root = record(input, "provenance")
  exactKeys(root, ["schemaVersion", "source", "legal", "toolchain"], "provenance")
  const source = record(root.source, "provenance.source")
  const legal = record(root.legal, "provenance.legal")
  const toolchain = record(root.toolchain, "provenance.toolchain")
  exactKeys(source, ["repository", "ref", "commit"], "provenance.source")
  exactKeys(legal, ["license", "licenseSha256", "noticeSha256"], "provenance.legal")
  exactKeys(toolchain, ["bunVersion", "target", "sourceLockSha256", "modelsDevApiSha256", "networkDisabled"], "provenance.toolchain")
  if (root.schemaVersion !== 1 || source.repository !== PIN.repository || source.ref !== PIN.ref || source.commit !== PIN.commit ||
      legal.license !== "Apache-2.0" || legal.licenseSha256 !== PIN.licenseSha256 || legal.noticeSha256 !== PIN.noticeSha256 ||
      toolchain.bunVersion !== PIN.bun || toolchain.target !== PIN.target || toolchain.sourceLockSha256 !== PIN.bunLockSha256 ||
      toolchain.modelsDevApiSha256 !== modelsDigest || toolchain.networkDisabled !== true) throw new Error("provenance binding mismatch")
}

export function validateModelsSnapshot(input: unknown): void {
  const providers = record(input, "models.dev snapshot")
  if (Object.keys(providers).length === 0) throw new Error("models.dev snapshot must not be empty")
  const providerKeys = ["id", "name", "env", "npm", "api", "doc", "models"]
  const modelKeys = ["id", "name", "description", "family", "attachment", "reasoning", "reasoning_options", "tool_call", "temperature", "knowledge", "release_date", "last_updated", "modalities", "open_weights", "limit", "cost", "experimental", "interleaved", "provider", "status", "structured_output"]
  for (const [providerId, rawProvider] of Object.entries(providers)) {
    const provider = record(rawProvider, `provider ${providerId}`)
    exactKeys(provider, providerKeys, `provider ${providerId}`, ["id", "name", "models"])
    if (provider.id !== providerId) throw new Error(`provider id mismatch: ${providerId}`)
    nonEmptyString(provider.name, `provider ${providerId}.name`)
    const models = record(provider.models, `provider ${providerId}.models`)
    if (Object.keys(models).length === 0) throw new Error(`provider ${providerId} has no models`)
    for (const [modelId, rawModel] of Object.entries(models)) {
      const model = record(rawModel, `model ${modelId}`)
      exactKeys(model, modelKeys, `model ${modelId}`, ["id", "name"])
      if (model.id !== modelId) throw new Error(`model id mismatch: ${modelId}`)
      nonEmptyString(model.name, `model ${modelId}.name`)
      if (model.modalities !== undefined) exactKeys(record(model.modalities, `model ${modelId}.modalities`), ["input", "output"], `model ${modelId}.modalities`)
      if (model.limit !== undefined) exactKeys(record(model.limit, `model ${modelId}.limit`), ["context", "input", "output"], `model ${modelId}.limit`, [])
      if (model.cost !== undefined && model.cost !== null) {
        const cost = record(model.cost, `model ${modelId}.cost`)
        exactKeys(cost, ["input", "output", "cache_read", "cache_write", "reasoning", "input_audio", "output_audio", "context_over_200k", "tiers"], `model ${modelId}.cost`, [])
        if (cost.tiers !== undefined) for (const [tierIndex, rawTier] of array(cost.tiers, `model ${modelId}.cost.tiers`).entries()) {
          const tier = record(rawTier, `model ${modelId}.cost.tiers[${tierIndex}]`)
          exactKeys(tier, ["input", "output", "cache_read", "cache_write", "input_audio", "output_audio", "tier"], `model ${modelId}.cost.tiers[${tierIndex}]`, ["tier"])
          exactKeys(record(tier.tier, `model ${modelId}.cost.tiers[${tierIndex}].tier`), ["type", "size"], `model ${modelId}.cost.tiers[${tierIndex}].tier`)
        }
      }
      if (model.interleaved !== undefined && model.interleaved !== null && typeof model.interleaved === "object") {
        exactKeys(record(model.interleaved, `model ${modelId}.interleaved`), ["field"], `model ${modelId}.interleaved`)
      }
      if (model.provider !== undefined && model.provider !== null) {
        exactKeys(record(model.provider, `model ${modelId}.provider`), ["npm", "api", "shape"], `model ${modelId}.provider`, [])
      }
    }
  }
}

function parseTrustedComponentPolicy(bytes: Buffer): TrustedComponentPolicy {
  const root = record(JSON.parse(bytes.toString("utf8")), "trusted component policy")
  exactKeys(root, ["schemaVersion", "profile", "components"], "trusted component policy")
  if (root.schemaVersion !== 1 || root.profile !== "embedded-web-rdkit") throw new Error("trusted component policy schema/profile mismatch")
  const components = array(root.components, "trusted component policy components").map((raw, index) => {
    const component = record(raw, `trusted component policy components[${index}]`)
    exactKeys(component, ["feature", "id", "disposition", "license"], `trusted component policy components[${index}]`)
    const parsed = {
      feature: nonEmptyString(component.feature, "trusted component feature"),
      id: nonEmptyString(component.id, "trusted component id"),
      disposition: component.disposition,
      license: nonEmptyString(component.license, "trusted component license"),
    }
    if (parsed.disposition !== "required" && parsed.disposition !== "excluded") throw new Error(`invalid trusted component disposition: ${parsed.id}`)
    return parsed as TrustedComponent
  })
  const expectedFeatures = ["embedded-web", "rdkit-wasm", "pdfjs", "molstar", "igv"]
  if (components.length !== expectedFeatures.length || new Set(components.map(({ feature }) => feature)).size !== components.length ||
      JSON.stringify(components.map(({ feature }) => feature)) !== JSON.stringify(expectedFeatures)) {
    throw new Error("trusted component feature profile mismatch")
  }
  if (new Set(components.map(({ id }) => id)).size !== components.length) throw new Error("duplicate trusted component id")
  const componentSet = components.map(({ feature, id, disposition, license }) => ({ feature, id, disposition, license }))
  return { policySha256: digest(bytes), componentSetSha256: digest(Buffer.from(JSON.stringify(componentSet))), components }
}

async function loadTrustedComponentPolicy(): Promise<TrustedComponentPolicy> {
  const bytes = await readFile(new URL("../../policy/trusted-component-profile.json", import.meta.url))
  return parseTrustedComponentPolicy(bytes)
}

function parseComponentClosure(sbomInput: unknown, noticesInput: unknown, decisionsInput: unknown, modelsDigest: string,
  trustedPolicy: TrustedComponentPolicy): void {
  const sbom = record(sbomInput, "SBOM")
  exactKeys(sbom, ["bomFormat", "specVersion", "version", "metadata", "components"], "SBOM")
  const metadata = record(sbom.metadata, "SBOM.metadata")
  exactKeys(metadata, ["sourceCommit", "materials"], "SBOM.metadata")
  if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.6" || sbom.version !== 1 || metadata.sourceCommit !== PIN.commit) throw new Error("SBOM source/schema mismatch")
  const materials = array(metadata.materials, "SBOM.metadata.materials").map((raw, index) => {
    const material = record(raw, `SBOM.metadata.materials[${index}]`)
    exactKeys(material, ["uri", "digest"], `SBOM.metadata.materials[${index}]`)
    const materialDigest = record(material.digest, `SBOM.metadata.materials[${index}].digest`)
    exactKeys(materialDigest, ["algorithm", "value"], `SBOM.metadata.materials[${index}].digest`)
    return {
      uri: nonEmptyString(material.uri, "material uri"),
      digest: { algorithm: nonEmptyString(materialDigest.algorithm, "material digest algorithm"), value: nonEmptyString(materialDigest.value, "material digest value") },
    }
  })
  const expectedMaterials = [
    { uri: `${PIN.repository}@${PIN.commit}`, digest: { algorithm: "gitCommit", value: PIN.commit } },
    { uri: "https://models.dev/api.json", digest: { algorithm: "sha256", value: modelsDigest } },
    { uri: `${PIN.repository}/bun.lock@${PIN.commit}`, digest: { algorithm: "sha256", value: PIN.bunLockSha256 } },
  ]
  if (JSON.stringify(materials) !== JSON.stringify(expectedMaterials)) throw new Error("SBOM material closure mismatch")
  const sbomComponents = new Map<string, string>()
  for (const [index, raw] of array(sbom.components, "SBOM.components").entries()) {
    const component = record(raw, `SBOM.components[${index}]`)
    exactKeys(component, ["bom-ref", "name", "version", "license"], `SBOM.components[${index}]`)
    const id = nonEmptyString(component["bom-ref"], "component bom-ref")
    const license = nonEmptyString(component.license, `component ${id} license`)
    nonEmptyString(component.name, `component ${id} name`); nonEmptyString(component.version, `component ${id} version`)
    if (sbomComponents.has(id)) throw new Error(`duplicate SBOM component: ${id}`)
    sbomComponents.set(id, license)
  }
  const notices = record(noticesInput, "THIRD_PARTY_NOTICES")
  exactKeys(notices, ["schemaVersion", "sourceCommit", "components"], "THIRD_PARTY_NOTICES")
  if (notices.schemaVersion !== 1 || notices.sourceCommit !== PIN.commit) throw new Error("notices source/schema mismatch")
  const noticeComponents = new Map<string, string>()
  for (const [index, raw] of array(notices.components, "notices.components").entries()) {
    const component = record(raw, `notices.components[${index}]`)
    exactKeys(component, ["id", "name", "version", "license", "notice"], `notices.components[${index}]`)
    const id = nonEmptyString(component.id, "notice component id")
    const license = nonEmptyString(component.license, `notice ${id} license`)
    nonEmptyString(component.name, `notice ${id} name`); nonEmptyString(component.version, `notice ${id} version`)
    nonEmptyString(component.notice, `notice ${id} text`)
    if (noticeComponents.has(id)) throw new Error(`duplicate notice component: ${id}`)
    noticeComponents.set(id, license)
  }
  const decisions = record(decisionsInput, "third-party decisions")
  exactKeys(decisions, ["schemaVersion", "sourceCommit", "defaultDecision", "decisions"], "third-party decisions")
  if (decisions.schemaVersion !== 1 || decisions.sourceCommit !== PIN.commit || decisions.defaultDecision !== "excluded") throw new Error("third-party decision schema/source mismatch")
  const included = new Map<string, string>()
  const excluded = new Map<string, string>()
  const decisionIds = new Set<string>()
  for (const [index, raw] of array(decisions.decisions, "decisions").entries()) {
    const decision = record(raw, `decisions[${index}]`)
    exactKeys(decision, ["id", "decision", "license", "rationale"], `decisions[${index}]`)
    const id = nonEmptyString(decision.id, "decision id")
    if (decisionIds.has(id) || (decision.decision !== "included" && decision.decision !== "excluded")) throw new Error(`invalid or duplicate decision: ${id}`)
    decisionIds.add(id); nonEmptyString(decision.rationale, `decision ${id} rationale`)
    const license = nonEmptyString(decision.license, `decision ${id} license`)
    if (decision.decision === "included") included.set(id, license)
    else excluded.set(id, license)
  }
  const required = trustedPolicy.components.filter(({ disposition }) => disposition === "required")
  const explicitlyExcluded = trustedPolicy.components.filter(({ disposition }) => disposition === "excluded")
  if (required.length === 0) throw new Error("trusted component profile must require components")
  for (const component of required) {
    if (included.get(component.id) !== component.license) throw new Error(`required trusted component missing or mismatched: ${component.feature}`)
  }
  for (const component of explicitlyExcluded) {
    if (excluded.get(component.id) !== component.license) throw new Error(`trusted component exclusion missing or mismatched: ${component.feature}`)
  }
  const sbomIds = [...sbomComponents.keys()].sort()
  const noticeIds = [...noticeComponents.keys()].sort()
  const includedIds = [...included.keys()].sort()
  const requiredIds = required.map(({ id }) => id).sort()
  // The artifact's decision inventory cannot expand the trusted profile's allowlist.
  if (JSON.stringify(includedIds) !== JSON.stringify(requiredIds)) {
    throw new Error("included component set does not match trusted profile")
  }
  if (JSON.stringify(sbomIds) !== JSON.stringify(includedIds) || JSON.stringify(noticeIds) !== JSON.stringify(includedIds)) throw new Error("SBOM/notices/decision component closure mismatch")
  for (const id of includedIds) if (sbomComponents.get(id) !== included.get(id) || noticeComponents.get(id) !== included.get(id)) throw new Error(`component license mismatch: ${id}`)
}

function validateChecksums(bytes: Buffer, actual: Map<string, ActualFile>): void {
  const expected = [...actual.values()].filter((leaf) => leaf.path !== ROLE_PATHS.checksums).sort((a, b) => a.path.localeCompare(b.path))
  const lines = bytes.toString("utf8").split("\n")
  if (lines.at(-1) !== "") throw new Error("checksums.txt must end with newline")
  lines.pop()
  if (lines.length !== expected.length) throw new Error("checksums leaf closure mismatch")
  const seen = new Set<string>()
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line)
    if (!match || seen.has(match[2]!)) throw new Error("invalid or duplicate checksum line")
    seen.add(match[2]!)
    const leaf = actual.get(match[2]!)
    if (!leaf || leaf.path === ROLE_PATHS.checksums || leaf.sha256 !== match[1]) throw new Error(`checksum mismatch: ${match[2]}`)
  }
  for (const leaf of expected) if (!seen.has(leaf.path)) throw new Error(`checksum missing: ${leaf.path}`)
}

function parseBuildAttestation(input: unknown): BuildBindings {
  const root = record(input, "build attestation")
  exactKeys(root, ["schemaVersion", "predicateType", "bindings"], "build attestation")
  const bindings = record(root.bindings, "build attestation bindings")
  exactKeys(bindings, ["binarySha256", "sourceRepository", "sourceRef", "sourceCommit", "sourceLockSha256", "bunVersion", "modelsDevApiSha256", "networkDisabled", "componentPolicySha256", "componentSetSha256"], "build attestation bindings")
  if (root.schemaVersion !== 1 || root.predicateType !== "https://slsa.dev/provenance/v1") throw new Error("build attestation schema mismatch")
  return bindings as unknown as BuildBindings
}

function parseRuntimeEvidence(input: unknown): RuntimeBindings {
  const root = record(input, "runtime conformance evidence")
  exactKeys(root, ["schemaVersion", "bindings"], "runtime conformance evidence")
  const bindings = record(root.bindings, "runtime conformance bindings")
  exactKeys(bindings, ["binarySha256", "dynamicLoopbackBind", "hostValidation", "originValidation", "productionCredentialPersistenceDenied"], "runtime conformance bindings")
  if (root.schemaVersion !== 1) throw new Error("runtime evidence schema mismatch")
  return bindings as unknown as RuntimeBindings
}

function sameBindings(actual: object, expected: object, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} binding mismatch`)
}

function freezeClone<T extends object>(value: T): Readonly<T> {
  return Object.freeze(structuredClone(value))
}

function frozenIdentity(identity: VerificationIdentity): Readonly<VerificationIdentity> {
  return Object.freeze({ ...identity })
}

function validateTrustDecision(input: unknown, expected: Readonly<VerificationIdentity>, label: string): TrustDecision {
  const decision = parseTrustDecision(input, label)
  if (decision.subject !== expected.subject || decision.source !== expected.source || decision.evidence !== expected.evidence) {
    throw new Error(`${label} decision identity mismatch`)
  }
  return decision
}

export async function validateArtifact(root: string, rawInventory: unknown, options: ValidationOptions = {}): Promise<void> {
  if (!options.provenanceVerifier) throw new Error("trusted provenance verifier required")
  if (!options.runtimeVerifier) throw new Error("trusted runtime conformance verifier required")
  const inventory = parseInventory(rawInventory)
  const trustedComponents = await loadTrustedComponentPolicy()
  const actual = await enumerateArtifact(root)
  closeInventory(inventory, actual)
  const leaf = (role: ArtifactRole): ActualFile => actual.get(ROLE_PATHS[role])!
  if (leaf("license").size === 0 || leaf("license").sha256 !== PIN.licenseSha256) throw new Error("pinned LICENSE content mismatch")
  if (leaf("notice").size === 0 || leaf("notice").sha256 !== PIN.noticeSha256) throw new Error("pinned NOTICE content mismatch")
  if (leaf("third-party-notices").size === 0) throw new Error("THIRD_PARTY_NOTICES must not be empty")
  validateModelsSnapshot(parseJson(leaf("models-snapshot"), "models.dev snapshot"))
  parseProvenance(parseJson(leaf("provenance"), "provenance"), leaf("models-snapshot").sha256)
  validateRuntimePolicy(parseJson(leaf("runtime-policy"), "runtime policy"))
  parseComponentClosure(parseJson(leaf("sbom"), "SBOM"), parseJson(leaf("third-party-notices"), "THIRD_PARTY_NOTICES"), parseJson(leaf("third-party-decisions"), "third-party decisions"), leaf("models-snapshot").sha256, trustedComponents)
  validateChecksums(leaf("checksums").bytes, actual)

  const buildExpected: BuildBindings = {
    binarySha256: leaf("binary").sha256, sourceRepository: PIN.repository, sourceRef: PIN.ref,
    sourceCommit: PIN.commit, sourceLockSha256: PIN.bunLockSha256, bunVersion: PIN.bun,
    modelsDevApiSha256: leaf("models-snapshot").sha256, networkDisabled: true,
    componentPolicySha256: trustedComponents.policySha256, componentSetSha256: trustedComponents.componentSetSha256,
  }
  const attestation = parseJson(leaf("build-attestation"), "build attestation")
  sameBindings(parseBuildAttestation(attestation), buildExpected, "build attestation")
  const buildIdentity = frozenIdentity({
    subject: `sha256:${buildExpected.binarySha256}`,
    source: `${buildExpected.sourceRepository}@${buildExpected.sourceCommit}`,
    evidence: `sha256:${leaf("build-attestation").sha256}`,
  })
  const buildTrust = await options.provenanceVerifier.verify(attestation, freezeClone(buildExpected))
  validateTrustDecision(buildTrust, buildIdentity, "build provenance")

  const runtimeExpected: RuntimeBindings = {
    binarySha256: leaf("binary").sha256, dynamicLoopbackBind: true, hostValidation: true,
    originValidation: true, productionCredentialPersistenceDenied: true,
  }
  const runtimeEvidence = parseJson(leaf("runtime-conformance"), "runtime conformance evidence")
  sameBindings(parseRuntimeEvidence(runtimeEvidence), runtimeExpected, "runtime evidence")
  const runtimeIdentity = frozenIdentity({
    subject: `sha256:${runtimeExpected.binarySha256}`,
    source: `runtime-policy:sha256:${leaf("runtime-policy").sha256}`,
    evidence: `sha256:${leaf("runtime-conformance").sha256}`,
  })
  const runtimeTrust = await options.runtimeVerifier.verify(runtimeEvidence, freezeClone(runtimeExpected))
  validateTrustDecision(runtimeTrust, runtimeIdentity, "runtime conformance")
}
