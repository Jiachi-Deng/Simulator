#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA40 = /^[0-9a-f]{40}$/;
const RESOURCE_STATUSES = new Set(["include", "exclude", "review"]);
const RIGHTS_STATUSES = new Set(["cleared", "pending", "unknown", "not-applicable"]);

export function validateArtifact({ provenance, policy, decisions, inventory }) {
  const errors = [];
  const fail = (code, message) => errors.push({ code, message });

  if (!provenance || provenance.schemaVersion !== 1) fail("PROVENANCE_INVALID", "provenance schemaVersion must be 1");
  const pinned = provenance?.source;
  if (!pinned || !SHA40.test(pinned.commit ?? "")) fail("SOURCE_NOT_PINNED", "provenance source.commit must be a lowercase 40-character SHA");
  if (!pinned || !["tag", "commit"].includes(pinned.refType) || !pinned.ref) fail("SOURCE_NOT_PINNED", "provenance source must use a tag or commit ref");
  if (pinned?.refType === "tag" && /^(HEAD|main|master|develop)$/i.test(pinned.ref ?? "")) fail("SOURCE_NOT_PINNED", "branch and HEAD refs are not pinned sources");
  if (!provenance?.license?.spdxId || !provenance?.license?.sourceFile) fail("LICENSE_METADATA_MISSING", "provenance must declare SPDX license and upstream source file");
  if (!provenance?.source?.sourceDate) fail("SOURCE_DATE_MISSING", "provenance must declare sourceDate");
  if (!provenance?.buildToolchainExpectations?.node || !provenance?.buildToolchainExpectations?.pnpm) fail("TOOLCHAIN_MISSING", "provenance must declare Node and pnpm expectations");

  if (inventory?.source?.commit !== pinned?.commit || inventory?.source?.ref !== pinned?.ref) fail("SOURCE_MISMATCH", "inventory source must match pinned provenance exactly");
  if (!Array.isArray(inventory?.files)) fail("INVENTORY_INVALID", "inventory.files must be an array");
  if (!Array.isArray(policy?.allowedPathPrefixes) || !Array.isArray(policy?.requiredFiles)) fail("POLICY_INVALID", "policy path lists are required");
  if (!Array.isArray(decisions?.decisions)) fail("DECISIONS_INVALID", "resource decisions must be an array");

  const decisionById = new Map();
  for (const decision of decisions?.decisions ?? []) {
    if (!decision?.id || decisionById.has(decision.id)) fail("DECISION_INVALID", `resource decision id is missing or duplicated: ${decision?.id ?? "<missing>"}`);
    else decisionById.set(decision.id, decision);
    if (!policy.resourceCategories?.includes(decision?.category)) fail("DECISION_INVALID", `unknown resource category for ${decision?.id ?? "<missing>"}`);
    if (!RESOURCE_STATUSES.has(decision?.status) || !RIGHTS_STATUSES.has(decision?.rightsStatus)) fail("DECISION_INVALID", `invalid status for ${decision?.id ?? "<missing>"}`);
    if (decision?.status === "include" && decision?.rightsStatus !== "cleared") fail("RIGHTS_NOT_CLEARED", `included decision ${decision.id} must have cleared rights`);
  }

  const seen = new Set();
  for (const file of inventory?.files ?? []) {
    const normalized = validateRelativePath(file?.path, fail);
    if (!normalized) continue;
    if (seen.has(normalized)) fail("DUPLICATE_PATH", `duplicate artifact path: ${normalized}`);
    seen.add(normalized);

    const allowed = policy.allowedExactPaths?.includes(normalized) || policy.allowedPathPrefixes.some((prefix) => normalized.startsWith(prefix));
    if (!allowed) fail("PATH_NOT_ALLOWED", `path is outside the feature profile: ${normalized}`);

    const lowerSegments = normalized.toLowerCase().split("/");
    for (const forbidden of policy.forbiddenPathSegments ?? []) {
      const forbiddenParts = forbidden.toLowerCase().split("/");
      if (containsSequence(lowerSegments, forbiddenParts)) fail("FORBIDDEN_PATH", `path contains forbidden segment '${forbidden}': ${normalized}`);
    }
    const basename = path.posix.basename(normalized).toLowerCase();
    for (const pattern of policy.forbiddenBasenamePatterns ?? []) {
      if (matchesSimpleGlob(basename, pattern.toLowerCase())) fail("FORBIDDEN_PATH", `path matches forbidden pattern '${pattern}': ${normalized}`);
    }
    if (!policy.allowedDependencyScopes?.includes(file?.dependencyScope)) fail("DEPENDENCY_SCOPE_FORBIDDEN", `file must be a production/artifact dependency: ${normalized}`);

    if (file?.type === "symlink") {
      const target = file.symlinkTarget;
      if (typeof target !== "string" || !validateSymlinkTarget(normalized, target)) fail("SYMLINK_ESCAPE", `symlink target must stay inside artifact root: ${normalized}`);
    }

    const extension = path.posix.extname(normalized).toLowerCase();
    const native = policy.nativeBinaryExtensions?.includes(extension);
    const inferredResourceCategory = native
      ? "native-binaries"
      : Object.entries(policy.resourceExtensions ?? {}).find(([, extensions]) => extensions.includes(extension))?.[0];
    if (inferredResourceCategory && file?.resourceCategory !== inferredResourceCategory) {
      fail("UNEXPECTED_RESOURCE", `${inferredResourceCategory} resource lacks its required category and decision: ${normalized}`);
    }
    if (native && file?.resourceCategory !== "native-binaries") fail("NATIVE_RESOURCE_UNDECLARED", `native binary lacks native-binaries category: ${normalized}`);
    if (native) {
      for (const field of policy.requiredNativeAbiFields ?? []) {
        if (!file?.nativeAbi?.[field]) fail("NATIVE_ABI_MISSING", `native binary ${normalized} is missing ABI field ${field}`);
      }
    }

    if (file?.resourceCategory) {
      if (!policy.resourceCategories?.includes(file.resourceCategory)) fail("UNEXPECTED_RESOURCE", `unknown resource category on ${normalized}`);
      const decision = decisionById.get(file.decisionId);
      if (!decision || decision.category !== file.resourceCategory) fail("UNEXPECTED_RESOURCE", `resource has no matching category decision: ${normalized}`);
      else if (decision.status !== "include" || decision.rightsStatus !== "cleared") fail("RESOURCE_EXCLUDED", `resource decision is not cleared for inclusion: ${normalized}`);
    } else if (file?.kind === "resource") {
      fail("UNEXPECTED_RESOURCE", `resource must declare category and decisionId: ${normalized}`);
    }
  }

  for (const required of policy?.requiredFiles ?? []) {
    if (!seen.has(required)) fail("REQUIRED_FILE_MISSING", `required artifact file is missing: ${required}`);
  }

  return { ok: errors.length === 0, errors };
}

function validateRelativePath(value, fail) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail("PATH_INVALID", `artifact path is invalid: ${String(value)}`);
    return null;
  }
  if (value.includes("\\") || path.posix.isAbsolute(value) || value.split("/").some((part) => part === ".." || part === "." || part === "")) {
    fail("PATH_TRAVERSAL", `artifact path must be normalized and relative: ${value}`);
    return null;
  }
  if (path.posix.normalize(value) !== value) {
    fail("PATH_TRAVERSAL", `artifact path must be normalized and relative: ${value}`);
    return null;
  }
  return value;
}

function validateSymlinkTarget(linkPath, target) {
  if (target.includes("\\") || target.includes("\0") || path.posix.isAbsolute(target)) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(linkPath), target));
  return resolved !== ".." && !resolved.startsWith("../") && !path.posix.isAbsolute(resolved);
}

function containsSequence(haystack, needle) {
  return haystack.some((_, index) => needle.every((part, offset) => haystack[index + offset] === part));
}

function matchesSimpleGlob(value, pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

async function main(argv) {
  const names = ["provenance", "policy", "decisions", "inventory"];
  const options = Object.fromEntries(names.map((name) => {
    const index = argv.indexOf(`--${name}`);
    return [name, index >= 0 ? argv[index + 1] : undefined];
  }));
  const missing = names.filter((name) => !options[name]);
  if (missing.length) throw new Error(`Missing arguments: ${missing.map((name) => `--${name}`).join(", ")}`);
  const inputs = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readJson(options[name])])));
  const result = validateArtifact(inputs);
  if (!result.ok) {
    for (const error of result.errors) console.error(`${error.code}: ${error.message}`);
    process.exitCode = 1;
  } else {
    console.log(`Artifact inventory valid (${inputs.inventory.files.length} files).`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
