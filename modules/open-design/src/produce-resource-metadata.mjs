import { createHash } from "node:crypto";
import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { canonicalJsonBytes, inferResourcePathCategory } from "./validate-artifact.mjs";
import { stagingAssert, stagingFail } from "./staging-error.mjs";

const NATIVE_EXTENSIONS = new Set([".node", ".so", ".dylib", ".dll", ".exe", ".wasm"]);

export async function produceResourceMetadata({ artifactRoot, provenance, policy, decisions, target } = {}) {
  stagingAssert(path.isAbsolute(artifactRoot ?? ""), "RESOURCE_METADATA_ROOT_INVALID", "artifact root must be absolute");
  stagingAssert(provenance?.source?.commit && policy?.resourceExtensions && Array.isArray(decisions?.decisions), "RESOURCE_METADATA_INPUT_INVALID", "provenance, policy and decisions are required");
  validateTarget(target);
  const root = await realpath(artifactRoot).catch((error) => stagingFail("RESOURCE_METADATA_ROOT_INVALID", error.message));
  const rootStat = await lstat(root).catch((error) => stagingFail("RESOURCE_METADATA_ROOT_INVALID", error.message));
  stagingAssert(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "RESOURCE_METADATA_ROOT_INVALID", "artifact root must be a real directory");

  const decisionByIdentity = new Map(decisions.decisions.map((decision) => [`${decision.category}\0${decision.sourcePath}`, decision]));
  const usedDecisions = new Map();
  const resources = {};
  const packageCache = new Map();
  await visit(root, "");
  await verifyRightsEvidence(root, [...usedDecisions.values()]);
  const orderedResources = Object.fromEntries(Object.entries(resources).sort(([left], [right]) => compareUtf8(left, right)));
  const document = {
    schemaVersion: 1,
    sourceCommit: provenance.source.commit,
    target: structuredClone(target),
    resources: orderedResources,
  };
  const bytes = canonicalJsonBytes(document);
  const categories = Object.values(orderedResources).reduce((counts, entry) => {
    counts[entry.resourceCategory] = (counts[entry.resourceCategory] ?? 0) + 1;
    return counts;
  }, {});
  return {
    document,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    evidence: { resourceCount: Object.keys(orderedResources).length, categories: Object.fromEntries(Object.entries(categories).sort(([left], [right]) => compareUtf8(left, right))) },
  };

  async function visit(absoluteDirectory, relativeDirectory) {
    const before = await lstat(absoluteDirectory).catch((error) => stagingFail("RESOURCE_METADATA_FILESYSTEM_ERROR", error.message));
    stagingAssert(before.isDirectory() && !before.isSymbolicLink(), "RESOURCE_METADATA_SYMLINK_FORBIDDEN", `directory is not real: ${relativeDirectory || "."}`);
    const directory = await opendir(absoluteDirectory).catch((error) => stagingFail("RESOURCE_METADATA_FILESYSTEM_ERROR", error.message));
    for await (const entry of directory) {
      const artifactPath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(absoluteDirectory, entry.name);
      const stat = await lstat(absolutePath).catch((error) => stagingFail("RESOURCE_METADATA_FILESYSTEM_ERROR", error.message));
      stagingAssert(!stat.isSymbolicLink(), "RESOURCE_METADATA_SYMLINK_FORBIDDEN", `symlink is forbidden: ${artifactPath}`);
      if (stat.isDirectory()) {
        await visit(absolutePath, artifactPath);
        continue;
      }
      stagingAssert(stat.isFile() && stat.nlink === 1, "RESOURCE_METADATA_FILE_INVALID", `resource candidate must be an unlinked regular file: ${artifactPath}`);
      const category = resourceCategory(artifactPath, policy);
      if (category == null) continue;
      const sourcePath = await sourceIdentity(root, artifactPath, packageCache);
      const decision = decisionByIdentity.get(`${category}\0${sourcePath}`);
      const decisionId = decision?.id ?? `unreviewed-${slug(category)}-${createHash("sha256").update(sourcePath).digest("hex").slice(0, 16)}`;
      if (decision != null) usedDecisions.set(decision.id, decision);
      resources[artifactPath] = {
        resourceCategory: category,
        sourcePath,
        decisionId,
        ...(category === "native-binaries" && { nativeTarget: { format: nativeFormat(artifactPath), platform: target.platform, arch: target.arch, nodeAbi: target.nodeAbi, libc: target.libc } }),
      };
    }
    const after = await lstat(absoluteDirectory).catch((error) => stagingFail("RESOURCE_METADATA_FILESYSTEM_ERROR", error.message));
    stagingAssert(sameIdentity(before, after), "RESOURCE_METADATA_CHANGED", `directory changed while producing metadata: ${relativeDirectory || "."}`);
  }
}

async function verifyRightsEvidence(root, decisions) {
  const verified = new Map();
  for (const decision of decisions) {
    if (decision.status !== "include") continue;
    const evidence = decision.rightsEvidence;
    stagingAssert(decision.rightsStatus === "cleared" && typeof decision.license === "string" && decision.license.length > 0 && evidence != null, "RIGHTS_EVIDENCE_INVALID", `included decision lacks cleared evidence: ${decision.id}`);
    stagingAssert(isNormalizedArtifactPath(evidence.reference) && evidence.reference.startsWith("legal/"), "RIGHTS_EVIDENCE_INVALID", `rights evidence must be a packaged legal file: ${decision.id}`);
    stagingAssert(/^[0-9a-f]{64}$/u.test(evidence.sha256), "RIGHTS_EVIDENCE_INVALID", `rights evidence hash is invalid: ${decision.id}`);
    const previous = verified.get(evidence.reference);
    if (previous != null) {
      stagingAssert(previous === evidence.sha256, "RIGHTS_EVIDENCE_INVALID", `conflicting rights evidence hashes: ${evidence.reference}`);
      continue;
    }
    const filename = path.join(root, ...evidence.reference.split("/"));
    const before = await lstat(filename).catch((error) => stagingFail("RIGHTS_EVIDENCE_INVALID", `${decision.id}: ${error.message}`));
    stagingAssert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1, "RIGHTS_EVIDENCE_INVALID", `rights evidence is not an unlinked regular file: ${evidence.reference}`);
    const bytes = await readFile(filename).catch((error) => stagingFail("RIGHTS_EVIDENCE_INVALID", `${decision.id}: ${error.message}`));
    const after = await lstat(filename).catch((error) => stagingFail("RIGHTS_EVIDENCE_INVALID", `${decision.id}: ${error.message}`));
    stagingAssert(sameIdentity(before, after), "RIGHTS_EVIDENCE_INVALID", `rights evidence changed while hashing: ${evidence.reference}`);
    stagingAssert(createHash("sha256").update(bytes).digest("hex") === evidence.sha256, "RIGHTS_EVIDENCE_INVALID", `rights evidence hash mismatch: ${evidence.reference}`);
    verified.set(evidence.reference, evidence.sha256);
  }
}

function resourceCategory(artifactPath, policy) {
  if (isNativeResource(artifactPath)) return "native-binaries";
  const pathCategory = inferResourcePathCategory(artifactPath, policy);
  if (pathCategory != null) return pathCategory;
  const extension = path.posix.extname(artifactPath).toLowerCase();
  return Object.entries(policy.resourceExtensions).find(([, extensions]) => extensions.includes(extension))?.[0] ?? null;
}

async function sourceIdentity(root, artifactPath, packageCache) {
  const packageLocation = packageLocationForPath(artifactPath);
  if (packageLocation != null) {
    let manifest = packageCache.get(packageLocation.root);
    if (manifest == null) {
      const filename = path.join(root, ...packageLocation.root.split("/"), "package.json");
      const stat = await lstat(filename).catch((error) => stagingFail("RESOURCE_PACKAGE_MANIFEST_MISSING", `${artifactPath}: ${error.message}`));
      stagingAssert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "RESOURCE_PACKAGE_MANIFEST_INVALID", `package manifest is not an unlinked regular file: ${packageLocation.root}`);
      try {
        manifest = JSON.parse(await readFile(filename, "utf8"));
      } catch (error) {
        stagingFail("RESOURCE_PACKAGE_MANIFEST_INVALID", `${packageLocation.root}: ${error.message}`);
      }
      stagingAssert(manifest?.name === packageLocation.name && typeof manifest.version === "string" && manifest.version.length > 0, "RESOURCE_PACKAGE_MANIFEST_INVALID", `package identity mismatch: ${packageLocation.root}`);
      packageCache.set(packageLocation.root, manifest);
    }
    return `${manifest.name}@${manifest.version}/${packageLocation.inside}`;
  }
  for (const [prefix, sourcePrefix] of [
    ["web/standalone/apps/web/public/", "apps/web/public/"],
    ["web/standalone/apps/web/.next/static/", "apps/web/.next/static/"],
  ]) {
    if (artifactPath.startsWith(prefix)) return `${sourcePrefix}${artifactPath.slice(prefix.length)}`;
  }
  return `build-output/${artifactPath}`;
}

function packageLocationForPath(artifactPath) {
  const parts = artifactPath.split("/");
  let index = -1;
  for (let cursor = 0; cursor < parts.length; cursor += 1) if (parts[cursor] === "node_modules") index = cursor;
  if (index < 0 || index + 2 >= parts.length) return null;
  const scoped = parts[index + 1].startsWith("@");
  const nameParts = scoped ? parts.slice(index + 1, index + 3) : parts.slice(index + 1, index + 2);
  const insideParts = parts.slice(index + 1 + nameParts.length);
  if (insideParts.length === 0) return null;
  return { name: nameParts.join("/"), root: parts.slice(0, index + 1 + nameParts.length).join("/"), inside: insideParts.join("/") };
}

function isNativeResource(artifactPath) {
  return NATIVE_EXTENSIONS.has(path.posix.extname(artifactPath).toLowerCase()) || /\/node_modules\/node-pty\/prebuilds\/[^/]+\/spawn-helper$/u.test(artifactPath);
}

function isNormalizedArtifactPath(value) {
  return typeof value === "string" && value.length > 0 && value === value.normalize("NFC") && !value.includes("\\") && !value.includes("\0")
    && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value
    && !value.split("/").some((part) => part === "" || part === "." || part === "..") && !/[\u0000-\u001f\u007f]/u.test(value);
}

function nativeFormat(artifactPath) {
  const extension = path.posix.extname(artifactPath).toLowerCase();
  if (extension === ".node") return "node-addon";
  if (extension === ".wasm") return "wasm-module";
  if (extension === ".exe" || artifactPath.endsWith("/spawn-helper")) return "executable";
  return "shared-library";
}

function validateTarget(target) {
  stagingAssert(["darwin", "linux", "win32"].includes(target?.platform) && ["arm64", "x64"].includes(target?.arch), "RESOURCE_METADATA_TARGET_INVALID", "target platform and architecture are invalid");
  stagingAssert(typeof target.nodeAbi === "string" && /^\d{1,4}$/u.test(target.nodeAbi) && ["none", "glibc", "musl", "msvcrt"].includes(target.libc), "RESOURCE_METADATA_TARGET_INVALID", "target ABI or libc is invalid");
}

function slug(value) { return value.replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, ""); }
function compareUtf8(left, right) { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs; }
