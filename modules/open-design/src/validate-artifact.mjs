#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { caseFold } from "unicode-case-folding";

const SHA40 = /^[0-9a-f]{40}$/;
const textEncoder = new TextEncoder();
const moduleRoot = new URL("../", import.meta.url);

export function validateArtifact({ provenance, policy, decisions, attestation, inventory, schemas }) {
  const errors = [];
  const fail = (code, message) => errors.push({ code, message });
  const schemaInputs = [
    ["provenance", provenance, schemas?.provenance],
    ["policy", policy, schemas?.policy],
    ["decisions", decisions, schemas?.decisions],
    ["attestation", attestation, schemas?.attestation],
    ["inventory", inventory, schemas?.inventory]
  ];
  for (const [name, value, schema] of schemaInputs) {
    if (!schema) fail("SCHEMA_MISSING", `runtime schema is missing for ${name}`);
    else validateSchema(value, schema, name, fail);
  }
  if (!schemas?.inventoryFile) fail("SCHEMA_MISSING", "runtime schema is missing for inventory.file");
  else for (const [index, file] of (inventory?.files ?? []).entries()) validateSchema(file, schemas.inventoryFile, `inventory.files[${index}]`, fail);
  if (errors.length) return { ok: false, errors };

  const pinned = provenance.source;
  if (!SHA40.test(pinned.commit) || /^(HEAD|main|master|develop)$/i.test(pinned.ref)) fail("SOURCE_NOT_PINNED", "source must use a pinned tag/commit and full SHA");
  if (inventory.source.commit !== pinned.commit || inventory.source.ref !== pinned.ref) fail("SOURCE_MISMATCH", "inventory source must match pinned provenance exactly");
  validateAttestation({ attestation, provenance, inventory }, fail);

  validateLimits({ provenance, policy, decisions, attestation, inventory }, policy.limits, fail);
  validateTarget(inventory.target, fail);

  const decisionById = new Map();
  for (const decision of decisions.decisions) {
    if (decisionById.has(decision.id)) fail("DECISION_INVALID", `duplicate resource decision id: ${decision.id}`);
    decisionById.set(decision.id, decision);
    if (!validateNormalizedRelativePath(decision.sourcePath) || /[*?[\]{}]/u.test(decision.sourcePath)) fail("DECISION_SOURCE_INVALID", `decision sourcePath must be exact, normalized and relative: ${decision.sourcePath}`);
    if (decision.status === "include" && (decision.rightsStatus !== "cleared" || !decision.license?.trim() || !decision.rightsEvidence)) {
      fail("RIGHTS_EVIDENCE_MISSING", `included decision ${decision.id} requires cleared rights, license and evidence`);
    }
  }

  const seen = new Map();
  let totalBytes = 0;
  for (const file of inventory.files) {
    if (!validateNormalizedRelativePath(file.path)) {
      fail("PATH_TRAVERSAL", `artifact path must be NFC-normalized, relative and slash-separated: ${file.path}`);
      continue;
    }
    const collisionKey = unicodeCaseFold(file.path.normalize("NFKC"));
    if (seen.has(collisionKey)) fail("DUPLICATE_PATH", `case/Unicode-colliding artifact paths: ${seen.get(collisionKey)} and ${file.path}`);
    else seen.set(collisionKey, file.path);

    totalBytes += file.bytes;
    if (file.bytes > policy.limits.maxFileBytes) fail("FILE_LIMIT_EXCEEDED", `file exceeds maxFileBytes: ${file.path}`);
    if (!Number.isSafeInteger(file.bytes)) fail("FILE_LIMIT_EXCEEDED", `file bytes must be a safe integer: ${file.path}`);

    const rule = policy.exactPathRules.find((candidate) => candidate.path === file.path)
      ?? policy.pathRules.find((candidate) => file.path.startsWith(candidate.prefix));
    const extension = path.posix.extname(file.path).toLowerCase();
    const native = policy.nativeBinaryExtensions.includes(extension);
    if (!rule) fail("PATH_NOT_ALLOWED", `path is outside the feature profile: ${file.path}`);
    else {
      const expectedKind = rule.artifactKind;
      const kindAllowed = file.artifactKind === expectedKind || (native && expectedKind === "runtime-package" && file.artifactKind === "native-binary");
      const componentAllowed = rule.component ? file.component === rule.component : rule.components.includes(file.component);
      if (!kindAllowed || !componentAllowed) fail("PROFILE_MISMATCH", `artifact kind/component does not match its path rule: ${file.path}`);
    }
    if (!policy.allowedDependencyScopes.includes(file.dependencyScope)) fail("DEPENDENCY_SCOPE_FORBIDDEN", `development scope is forbidden: ${file.path}`);
    if (isForbiddenPath(file.path, policy)) fail("FORBIDDEN_PATH", `path matches an excluded Electron/cache/test/update/dev-tool rule: ${file.path}`);

    if (file.type === "symlink") {
      if (!file.symlinkTarget || !validateSymlinkTarget(file.path, file.symlinkTarget)) fail("SYMLINK_ESCAPE", `symlink target must stay inside artifact root: ${file.path}`);
    } else if (file.symlinkTarget !== undefined) fail("FILE_METADATA_INVALID", `regular file cannot declare symlinkTarget: ${file.path}`);

    const inferredCategory = native ? "native-binaries" : inferResourceCategory(extension, policy);
    const pathCategory = inferResourcePathCategory(file.path, policy);
    if (inferredCategory && file.resourceCategory !== inferredCategory) fail("UNEXPECTED_RESOURCE", `${inferredCategory} resource lacks its category/decision: ${file.path}`);
    if (pathCategory && file.resourceCategory !== pathCategory) fail("UNEXPECTED_RESOURCE", `${pathCategory} resource lacks its category/decision: ${file.path}`);
    if (pathCategory !== undefined && !file.resourceCategory) fail("UNEXPECTED_RESOURCE", `resource path lacks its category/decision: ${file.path}`);
    if (file.resourceCategory) validateResource(file, decisionById, fail);
    else if (file.sourcePath !== undefined || file.decisionId !== undefined) fail("UNEXPECTED_RESOURCE", `resource metadata is incomplete: ${file.path}`);

    if (native) validateNative(file, extension, inventory.target, fail);
    else if (file.nativeTarget !== undefined || file.artifactKind === "native-binary") fail("NATIVE_METADATA_INVALID", `non-native file declares native metadata: ${file.path}`);
  }
  if (inventory.files.length > policy.limits.maxEntries) fail("ENTRY_LIMIT_EXCEEDED", "inventory exceeds maxEntries");
  if (!Number.isSafeInteger(totalBytes) || totalBytes > policy.limits.maxTotalBytes) fail("TOTAL_SIZE_EXCEEDED", "inventory exceeds maxTotalBytes");

  const filesByPath = new Map(inventory.files.map((file) => [file.path, file]));
  for (const required of policy.requiredFiles) validateRequiredFile(filesByPath.get(required.path), required, pinned.commit, { provenance, attestation, inventory }, fail);

  return { ok: errors.length === 0, errors };
}

function validateAttestation({ attestation, provenance, inventory }, fail) {
  if (attestation.sourceCommit !== provenance.source.commit) fail("ATTESTATION_SOURCE_MISMATCH", "build attestation source commit does not match provenance");
  if (attestation.patch.sha256 !== provenance.simulatorPatch.sha256 || attestation.patch.postimageSha256 !== provenance.simulatorPatch.postimageSha256) {
    fail("ATTESTATION_PATCH_MISMATCH", "build attestation patch does not match provenance");
  }
  const expected = provenance.buildToolchainExpectations;
  const actual = attestation.toolchain;
  for (const [attestationKey, provenanceKey] of [["nodeVersion", "node"], ["nodeAbi", "nodeAbi"], ["platform", "platform"], ["arch", "arch"], ["nodeExecutableSha256", "nodeExecutableSha256"], ["pnpmVersion", "pnpm"], ["pnpmExecutableSha256", "pnpmExecutableSha256"]]) {
    if (actual[attestationKey] !== expected[provenanceKey]) fail("ATTESTATION_TOOLCHAIN_MISMATCH", `build attestation ${attestationKey} does not match provenance`);
  }
  if (inventory.target.platform !== actual.platform || inventory.target.arch !== actual.arch || inventory.target.nodeAbi !== actual.nodeAbi) fail("ATTESTATION_TARGET_MISMATCH", "artifact target does not match attested toolchain");
  const buildStartedAt = Date.parse(attestation.build.startedAt);
  const originByPath = new Map(attestation.build.normalization.nativeOrigins.map((entry) => [entry.path, entry]));
  const nativeByPath = new Map(attestation.native.map((entry) => [entry.path, entry]));
  for (const file of inventory.files) {
    if (file.artifactKind !== "native-binary") continue;
    const native = nativeByPath.get(file.path);
    const origin = originByPath.get(file.path);
    if (!native || native.sha256 !== file.sha256 || !origin || origin.sha256 !== file.sha256 || !Number.isFinite(Date.parse(origin.sourceCtime)) || Date.parse(origin.sourceCtime) < buildStartedAt) {
      fail("ATTESTATION_NATIVE_MISMATCH", `native output is not bound to fresh normalized build evidence: ${file.path}`);
    } else if (path.posix.extname(file.path).toLowerCase() === ".node" && (native.load?.ok !== true || native.load.nodeAbi !== inventory.target.nodeAbi)) {
      fail("ATTESTATION_NATIVE_MISMATCH", `Node addon is not bound to a successful exact-runtime load: ${file.path}`);
    }
  }
  if (attestation.smoke.daemon.pid !== attestation.smoke.daemon.status.pid || attestation.smoke.web.pid !== attestation.smoke.web.status.pid) fail("ATTESTATION_SMOKE_MISMATCH", "smoke status PID must match each spawned child");
  if (attestation.smoke.daemon.entryPath !== "runtime/daemon/dist/sidecar/index.js" || attestation.smoke.web.entryPath !== "runtime/packages/web-sidecar/dist/sidecar/index.js") fail("ATTESTATION_SMOKE_MISMATCH", "smoke entries must bind the staged daemon and web sidecar");
}

function validateSchema(value, schema, location, fail, rootSchema = schema) {
  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/$defs/")) {
      fail("SCHEMA_INVALID", `${location} uses an unsupported schema reference`);
      return;
    }
    const resolved = rootSchema.$defs?.[schema.$ref.slice("#/$defs/".length)];
    if (!resolved) {
      fail("SCHEMA_INVALID", `${location} schema reference is missing`);
      return;
    }
    validateSchema(value, resolved, location, fail, rootSchema);
    return;
  }
  if (schema.const !== undefined && !Object.is(value, schema.const)) fail("SCHEMA_INVALID", `${location} must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((candidate) => Object.is(value, candidate))) fail("SCHEMA_INVALID", `${location} has an unknown enum value`);
  if (schema.type && !matchesType(value, schema.type)) {
    fail("SCHEMA_INVALID", `${location} has invalid type`);
    return;
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail("SCHEMA_INVALID", `${location} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail("SCHEMA_INVALID", `${location} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail("SCHEMA_INVALID", `${location} does not match required pattern`);
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) fail("SCHEMA_INVALID", `${location} is below minimum`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail("SCHEMA_INVALID", `${location} has too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail("SCHEMA_INVALID", `${location} has too many items`);
    if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items, `${location}[${index}]`, fail, rootSchema));
  } else if (isPlainObject(value)) {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) if (!(required in value)) fail("SCHEMA_INVALID", `${location}.${required} is required`);
    for (const [key, child] of Object.entries(value)) {
      if (properties[key]) validateSchema(child, properties[key], `${location}.${key}`, fail, rootSchema);
      else if (schema.additionalProperties === false) fail("SCHEMA_INVALID", `${location}.${key} is an unknown field`);
    }
  }
}

function matchesType(value, expected) {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((type) => type === "null" ? value === null
    : type === "array" ? Array.isArray(value)
      : type === "object" ? isPlainObject(value)
        : type === "integer" ? Number.isInteger(value)
          : typeof value === type);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateLimits(inputs, limits, fail) {
  const walk = (value, location) => {
    if (typeof value === "string" && textEncoder.encode(value).length > limits.maxStringBytes) fail("STRING_LIMIT_EXCEEDED", `${location} exceeds maxStringBytes`);
    else if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${location}[${index}]`));
    else if (isPlainObject(value)) for (const [key, child] of Object.entries(value)) walk(child, `${location}.${key}`);
  };
  walk(inputs, "inputs");
  for (const file of inputs.inventory.files) if (textEncoder.encode(file.path).length > limits.maxPathBytes) fail("PATH_LIMIT_EXCEEDED", `path exceeds maxPathBytes: ${file.path}`);
}

function validateNormalizedRelativePath(value) {
  return typeof value === "string" && value.length > 0 && value === value.normalize("NFC") && !value.includes("\\") && !value.includes("\0")
    && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value
    && !value.split("/").some((part) => part === "" || part === "." || part === "..")
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validateSymlinkTarget(linkPath, target) {
  if (typeof target !== "string" || !target || target !== target.normalize("NFC") || path.posix.isAbsolute(target) || target.includes("\\") || target.includes("\0") || /[\u0000-\u001f\u007f]/u.test(target)) return false;
  if (target.split("/").some((part) => part === "" || part === ".")) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(linkPath), target));
  return resolved !== ".." && !resolved.startsWith("../") && !path.posix.isAbsolute(resolved);
}

function unicodeCaseFold(value) {
  return caseFold(value);
}

function isForbiddenPath(value, policy) {
  const lower = value.toLowerCase();
  const segments = lower.split("/");
  return policy.forbiddenSegmentPatterns.some((pattern) => {
    const normalizedPattern = pattern.toLowerCase();
    if (normalizedPattern.includes("/")) return (`/${lower}/`).includes(`/${normalizedPattern}/`);
    return segments.some((segment) => matchesSimpleGlob(segment, normalizedPattern));
  }) || policy.forbiddenBasenamePatterns.some((pattern) => matchesSimpleGlob(path.posix.basename(lower), pattern.toLowerCase()));
}

function matchesSimpleGlob(value, pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "u").test(value);
}

function inferResourceCategory(extension, policy) {
  return Object.entries(policy.resourceExtensions).find(([, extensions]) => extensions.includes(extension))?.[0];
}

export function inferResourcePathCategory(artifactPath, policy) {
  for (const segment of artifactPath.split("/")) {
    if (Object.hasOwn(policy.resourcePathCategories, segment)) return policy.resourcePathCategories[segment] ?? null;
  }
  return undefined;
}

function validateResource(file, decisions, fail) {
  if (!file.sourcePath || !validateNormalizedRelativePath(file.sourcePath)) fail("RESOURCE_SOURCE_INVALID", `resource sourcePath must be exact and normalized: ${file.path}`);
  const decision = decisions.get(file.decisionId);
  if (!decision || decision.category !== file.resourceCategory || decision.sourcePath !== file.sourcePath) {
    fail("RESOURCE_DECISION_MISMATCH", `decisionId must match exact sourcePath and category: ${file.path}`);
  } else if (decision.status !== "include" || decision.rightsStatus !== "cleared" || !decision.license?.trim() || !decision.rightsEvidence) {
    fail("RESOURCE_EXCLUDED", `resource lacks an include+cleared decision with license evidence: ${file.path}`);
  }
}

function validateNative(file, extension, target, fail) {
  if (file.artifactKind !== "native-binary" || file.resourceCategory !== "native-binaries" || !file.nativeTarget) {
    fail("NATIVE_METADATA_INVALID", `native binary requires native artifact/resource metadata: ${file.path}`);
    return;
  }
  const expectedFormat = extension === ".node" ? "node-addon" : extension === ".exe" ? "executable" : "shared-library";
  if (file.nativeTarget.format !== expectedFormat) fail("NATIVE_METADATA_INVALID", `native format does not match extension: ${file.path}`);
  for (const key of ["platform", "arch", "libc"]) if (file.nativeTarget[key] !== target[key]) fail("NATIVE_TARGET_MISMATCH", `${key} does not match artifact target: ${file.path}`);
  if (file.nativeTarget.nodeAbi !== undefined && file.nativeTarget.nodeAbi !== target.nodeAbi) fail("NATIVE_TARGET_MISMATCH", `nodeAbi does not match artifact target: ${file.path}`);
  if (expectedFormat === "node-addon" && !file.nativeTarget.nodeAbi) fail("NATIVE_ABI_MISSING", `Node addon requires nodeAbi: ${file.path}`);
  if (target.platform === "darwin" && target.libc !== "none") fail("NATIVE_TARGET_INVALID", "darwin target libc must be none");
  if (target.platform === "win32" && target.libc !== "msvcrt") fail("NATIVE_TARGET_INVALID", "win32 target libc must be msvcrt");
  if (target.platform === "linux" && !["glibc", "musl"].includes(target.libc)) fail("NATIVE_TARGET_INVALID", "linux target libc must be glibc or musl");
}

function validateTarget(target, fail) {
  if (target.platform === "darwin" && target.libc !== "none") fail("TARGET_INVALID", "darwin target libc must be none");
  if (target.platform === "win32" && target.libc !== "msvcrt") fail("TARGET_INVALID", "win32 target libc must be msvcrt");
  if (target.platform === "linux" && !["glibc", "musl"].includes(target.libc)) fail("TARGET_INVALID", "linux target libc must be glibc or musl");
}

function validateRequiredFile(file, required, sourceCommit, inputs, fail) {
  if (!file) {
    fail("REQUIRED_FILE_MISSING", `required artifact file is missing: ${required.path}`);
    return;
  }
  if (file.type !== "file" || file.artifactKind !== required.artifactKind || file.component !== required.component) fail("REQUIRED_FILE_INVALID", `required path must be a regular file with the correct kind: ${required.path}`);
  if (file.mediaType !== required.mediaType || file.schemaId !== required.schemaId) fail("CONTENT_BINDING_INVALID", `required file has incorrect media/schema binding: ${required.path}`);
  if (required.path !== "legal/LICENSE" && (file.contentSchemaVersion !== required.schemaVersion || file.sourceCommit !== sourceCommit)) fail("CONTENT_BINDING_INVALID", `required JSON document lacks expected schemaVersion/sourceCommit binding: ${required.path}`);
  if (required.path === "provenance.json" && file.sha256 !== digestCanonicalJson(inputs.provenance)) fail("CONTENT_DIGEST_MISMATCH", "provenance digest does not bind the supplied provenance document");
  if (required.path === "build-attestation.json" && file.sha256 !== digestCanonicalJson(inputs.attestation)) fail("CONTENT_DIGEST_MISMATCH", "attestation digest does not bind the supplied build attestation document");
  if (required.path === "artifact-manifest.json" && file.sha256 !== digestInventory(inputs.inventory)) fail("CONTENT_DIGEST_MISMATCH", "manifest digest does not bind the supplied inventory document");
}

export function digestCanonicalJson(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function digestInventory(inventory) {
  const copy = structuredClone(inventory);
  const self = copy.files.find((file) => file.path === "artifact-manifest.json");
  if (self) self.sha256 = "0".repeat(64);
  return digestCanonicalJson(copy);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

export async function loadRuntimeSchemas() {
  const names = { provenance: "provenance.schema.json", policy: "policy.schema.json", decisions: "resource-decisions.schema.json", attestation: "build-attestation.schema.json", inventory: "inventory.schema.json", inventoryFile: "inventory-file.schema.json" };
  return Object.fromEntries(await Promise.all(Object.entries(names).map(async ([name, filename]) => [name, await readJson(new URL(filename, moduleRoot))])));
}

async function main(argv) {
  const options = parseArguments(argv);
  const names = ["provenance", "policy", "decisions", "attestation", "inventory"];
  const inputs = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readJson(options[name])])));
  inputs.schemas = await loadRuntimeSchemas();
  const result = validateArtifact(inputs);
  if (!result.ok) {
    for (const error of result.errors) console.error(`${error.code}: ${error.message}`);
    process.exitCode = 1;
  } else console.log(`Artifact inventory valid (${inputs.inventory.files.length} files).`);
}

function parseArguments(argv) {
  const allowed = new Set(["provenance", "policy", "decisions", "attestation", "inventory"]);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    if (!token?.startsWith("--") || !allowed.has(token.slice(2))) throw new Error(`ARGUMENT_UNKNOWN: unknown argument: ${token}`);
    const name = token.slice(2);
    if (Object.hasOwn(options, name)) throw new Error(`ARGUMENT_DUPLICATE: duplicate argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`ARGUMENT_MISSING: missing value for ${token}`);
    options[name] = value;
  }
  for (const name of allowed) if (!options[name]) throw new Error(`ARGUMENT_MISSING: required argument: --${name}`);
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
