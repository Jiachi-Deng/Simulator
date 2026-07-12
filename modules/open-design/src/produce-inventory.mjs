#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, opendir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { caseFold } from "unicode-case-folding";
import { canonicalJson, digestInventory, loadRuntimeSchemas, validateArtifact } from "./validate-artifact.mjs";

const moduleRoot = new URL("../", import.meta.url);
const encoder = new TextEncoder();
const RESOURCE_FIELDS = new Set(["resourceCategory", "sourcePath", "decisionId", "nativeTarget"]);

export class InventoryProductionError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "InventoryProductionError";
    this.code = code;
  }
}

const fail = (code, message) => { throw new InventoryProductionError(code, message); };

export async function produceInventory({ stagingRoot, metadata = {}, provenance, policy, decisions, target, schemas, hook }) {
  if (!path.isAbsolute(stagingRoot)) fail("STAGING_ROOT_INVALID", "staging root must be absolute");
  if (!isPlainObject(metadata)) fail("METADATA_INVALID", "metadata map must be an object keyed by exact artifact path");

  const rootStat = await safeLstat(stagingRoot, "staging root");
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("STAGING_ROOT_INVALID", "staging root must be a real directory");
  const rootReal = await realpath(stagingRoot);
  const leafPaths = await walkDirectory(stagingRoot, "", rootReal, policy);
  if (leafPaths.includes("artifact-manifest.json")) fail("OUTPUT_PATH_OCCUPIED", "staging root must not contain the generated artifact-manifest.json");
  const foldedPaths = new Map();
  for (const artifactPath of leafPaths) {
    const key = caseFold(artifactPath.normalize("NFKC"));
    if (foldedPaths.has(key)) fail("PATH_COLLISION", `case/Unicode-colliding staged paths: ${foldedPaths.get(key)} and ${artifactPath}`);
    foldedPaths.set(key, artifactPath);
  }
  const leafSet = new Set(leafPaths);
  for (const metadataPath of Object.keys(metadata)) {
    validateArtifactPath(metadataPath, policy);
    if (!leafSet.has(metadataPath)) fail("UNEXPECTED_METADATA", `metadata has no matching staged file: ${metadataPath}`);
  }

  const identities = new Map();
  const files = [];
  let totalBytes = 0;
  for (const artifactPath of leafPaths) {
    const rule = findRule(artifactPath, policy);
    if (!rule) fail("PATH_NOT_ALLOWED", `path is outside the feature profile: ${artifactPath}`);
    const special = validateMetadata(artifactPath, metadata[artifactPath], policy);
    const collected = await collectFile({ stagingRoot, artifactPath, rootReal, policy, hook });
    const identityKey = `${collected.stat.dev}:${collected.stat.ino}`;
    if (identities.has(identityKey)) fail("HARD_LINK_ALIAS", `hard-linked artifact paths are forbidden: ${identities.get(identityKey)} and ${artifactPath}`);
    identities.set(identityKey, artifactPath);
    totalBytes += collected.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > policy.limits.maxTotalBytes) fail("TOTAL_SIZE_EXCEEDED", "staged files exceed maxTotalBytes");

    const required = policy.requiredFiles.find((candidate) => candidate.path === artifactPath);
    const native = policy.nativeBinaryExtensions.includes(path.posix.extname(artifactPath).toLowerCase());
    files.push({
      schemaVersion: 1,
      path: artifactPath,
      type: "file",
      artifactKind: native ? "native-binary" : rule.artifactKind,
      component: rule.component ?? rule.components[0],
      dependencyScope: rule.artifactKind === "runtime-package" || rule.artifactKind === "daemon-runtime" ? "production" : "artifact",
      bytes: collected.bytes,
      sha256: collected.sha256,
      ...(required && { mediaType: required.mediaType, schemaId: required.schemaId }),
      ...(required?.schemaVersion !== undefined && { contentSchemaVersion: required.schemaVersion, sourceCommit: provenance.source.commit }),
      ...special
    });
  }

  const manifestRule = findRule("artifact-manifest.json", policy);
  const manifestRequired = policy.requiredFiles.find((file) => file.path === "artifact-manifest.json");
  if (!manifestRule || !manifestRequired) fail("POLICY_INVALID", "policy must define artifact-manifest.json as a required exact path");
  files.push({
    schemaVersion: 1, path: "artifact-manifest.json", type: "file", artifactKind: manifestRule.artifactKind,
    component: manifestRule.component, dependencyScope: "artifact", bytes: 0, sha256: "0".repeat(64),
    mediaType: manifestRequired.mediaType, schemaId: manifestRequired.schemaId,
    contentSchemaVersion: manifestRequired.schemaVersion, sourceCommit: provenance.source.commit
  });
  files.sort((left, right) => compareUtf8(left.path, right.path));
  const inventory = { schemaVersion: 1, source: { ref: provenance.source.ref, commit: provenance.source.commit }, target: structuredClone(target), files };
  const manifest = files.find((file) => file.path === "artifact-manifest.json");
  for (let previousBytes = -1; manifest.bytes !== previousBytes;) {
    previousBytes = manifest.bytes;
    manifest.bytes = encoder.encode(`${canonicalJson(inventory)}\n`).length;
  }
  manifest.sha256 = digestInventory(inventory);
  const result = validateArtifact({ provenance, policy, decisions, inventory, schemas: schemas ?? await loadRuntimeSchemas() });
  if (!result.ok) fail("ARTIFACT_INVALID", result.errors.map((error) => `${error.code}: ${error.message}`).join("; "));
  return { inventory, json: `${canonicalJson(inventory)}\n` };
}

async function walkDirectory(absoluteDirectory, relativeDirectory, rootReal, policy) {
  await assertDirectory(absoluteDirectory, rootReal, relativeDirectory || ".");
  const entries = [];
  const directory = await opendir(absoluteDirectory);
  for await (const entry of directory) entries.push(entry.name);
  entries.sort(compareUtf8);

  const files = [];
  for (const name of entries) {
    const artifactPath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
    validateArtifactPath(artifactPath, policy);
    const absolutePath = path.join(absoluteDirectory, name);
    const stat = await safeLstat(absolutePath, artifactPath);
    if (stat.isSymbolicLink()) fail("SYMLINK_FORBIDDEN", `symlink is forbidden: ${artifactPath}`);
    if (stat.isDirectory()) files.push(...await walkDirectory(absolutePath, artifactPath, rootReal, policy));
    else if (stat.isFile()) files.push(artifactPath);
    else fail("SPECIAL_FILE_FORBIDDEN", `only regular files are allowed: ${artifactPath}`);
    if (files.length > policy.limits.maxEntries) fail("ENTRY_LIMIT_EXCEEDED", "staging root exceeds maxEntries");
  }
  return files;
}

async function assertDirectory(absolutePath, rootReal, artifactPath) {
  const stat = await safeLstat(absolutePath, artifactPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("SYMLINK_FORBIDDEN", `directory component is not a real directory: ${artifactPath}`);
  const resolved = await realpath(absolutePath);
  assertContained(rootReal, resolved, artifactPath);
}

async function collectFile({ stagingRoot, artifactPath, rootReal, policy, hook }) {
  const absolutePath = path.join(stagingRoot, ...artifactPath.split("/"));
  await assertPathComponents(stagingRoot, artifactPath, rootReal);
  const beforePath = await safeLstat(absolutePath, artifactPath);
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) fail("SPECIAL_FILE_FORBIDDEN", `leaf is not a regular file: ${artifactPath}`);
  assertContained(rootReal, await realpath(absolutePath), artifactPath);
  const handle = await open(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameIdentity(before, beforePath)) fail("FILE_CHANGED", `file identity changed while opening: ${artifactPath}`);
    if (before.size > BigInt(policy.limits.maxFileBytes)) fail("FILE_LIMIT_EXCEEDED", `file exceeds maxFileBytes: ${artifactPath}`);
    await hook?.({ phase: "afterOpen", path: artifactPath, fileHandle: handle });

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    let position = 0;
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, position);
      if (result.bytesRead === 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      bytes += result.bytesRead;
      position += result.bytesRead;
      if (bytes > policy.limits.maxFileBytes || !Number.isSafeInteger(bytes)) fail("FILE_LIMIT_EXCEEDED", `file exceeds maxFileBytes: ${artifactPath}`);
    }
    await hook?.({ phase: "afterRead", path: artifactPath, fileHandle: handle });
    const after = await handle.stat({ bigint: true });
    const afterPath = await safeLstat(absolutePath, artifactPath);
    if (!sameIdentity(before, after) || after.size !== BigInt(bytes) || !sameIdentity(before, afterPath)) {
      fail("FILE_CHANGED", `file changed during collection: ${artifactPath}`);
    }
    await assertPathComponents(stagingRoot, artifactPath, rootReal);
    assertContained(rootReal, await realpath(absolutePath), artifactPath);
    return { bytes, sha256: hash.digest("hex"), stat: before };
  } finally {
    await handle.close();
  }
}

async function assertPathComponents(stagingRoot, artifactPath, rootReal) {
  const components = artifactPath.split("/").slice(0, -1);
  let absolutePath = stagingRoot;
  let relativePath = "";
  for (const component of components) {
    absolutePath = path.join(absolutePath, component);
    relativePath = relativePath ? `${relativePath}/${component}` : component;
    await assertDirectory(absolutePath, rootReal, relativePath);
  }
}

function validateArtifactPath(value, policy) {
  if (typeof value !== "string" || !value || value !== value.normalize("NFC") || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || value.split("/").some((part) => !part || part === "." || part === "..") || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("PATH_INVALID", `artifact path must be normalized and relative: ${value}`);
  }
  if (encoder.encode(value).length > policy.limits.maxPathBytes) fail("PATH_LIMIT_EXCEEDED", `path exceeds maxPathBytes: ${value}`);
}

function validateMetadata(artifactPath, value, policy) {
  const extension = path.posix.extname(artifactPath).toLowerCase();
  const inferredCategory = policy.nativeBinaryExtensions.includes(extension) ? "native-binaries" : Object.entries(policy.resourceExtensions).find(([, extensions]) => extensions.includes(extension))?.[0];
  if (value === undefined) {
    if (inferredCategory) fail("METADATA_MISSING", `resource/native metadata is required for exact path: ${artifactPath}`);
    return {};
  }
  if (!isPlainObject(value) || Object.keys(value).some((key) => !RESOURCE_FIELDS.has(key))) fail("METADATA_INVALID", `metadata has unknown fields: ${artifactPath}`);
  for (const key of ["resourceCategory", "sourcePath", "decisionId"]) if (typeof value[key] !== "string" || !value[key]) fail("METADATA_INVALID", `metadata.${key} is required: ${artifactPath}`);
  if (inferredCategory && value.resourceCategory !== inferredCategory) fail("METADATA_INVALID", `metadata category does not match file type: ${artifactPath}`);
  if (value.resourceCategory === "native-binaries" && !isPlainObject(value.nativeTarget)) fail("METADATA_MISSING", `nativeTarget is required: ${artifactPath}`);
  if (value.resourceCategory !== "native-binaries" && value.nativeTarget !== undefined) fail("METADATA_INVALID", `nativeTarget is only valid for native binaries: ${artifactPath}`);
  return structuredClone(value);
}

function findRule(artifactPath, policy) {
  return policy.exactPathRules.find((rule) => rule.path === artifactPath) ?? policy.pathRules.find((rule) => artifactPath.startsWith(rule.prefix));
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function assertContained(rootReal, candidate, artifactPath) {
  if (candidate !== rootReal && !candidate.startsWith(`${rootReal}${path.sep}`)) fail("PATH_ESCAPE", `resolved path escapes staging root: ${artifactPath}`);
}

async function safeLstat(filename, label) {
  try { return await lstat(filename, { bigint: true }); }
  catch (error) { fail("FILESYSTEM_ERROR", `${label}: ${error.message}`); }
}

function compareUtf8(left, right) { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function isPlainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
async function readJson(filename) { return JSON.parse(await readFile(filename, "utf8")); }

async function main(argv) {
  const option = (name) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : undefined; };
  const stagingRoot = option("staging-root");
  const metadataPath = option("metadata");
  const targetPath = option("target");
  const output = option("output");
  if (!stagingRoot || !metadataPath || !targetPath) fail("ARGUMENT_MISSING", "required: --staging-root ABSOLUTE --metadata FILE --target FILE [--output FILE]");
  const [metadata, target, provenance, policy, decisions] = await Promise.all([
    readJson(metadataPath), readJson(targetPath), readJson(new URL("provenance.json", moduleRoot)), readJson(new URL("artifact-policy.json", moduleRoot)), readJson(new URL("resource-decisions.json", moduleRoot))
  ]);
  const { json } = await produceInventory({ stagingRoot, metadata, target, provenance, policy, decisions });
  if (output) await writeFile(output, json, { encoding: "utf8", flag: "wx" });
  else process.stdout.write(json);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
