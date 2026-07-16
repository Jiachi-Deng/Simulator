import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { assertNativeBuildsAllowed } from "./native-inventory.mjs";
import { stagingAssert, stagingFail } from "./staging-error.mjs";

const execFile = promisify(execFileCallback);
const moduleRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function applySimulatorPatch({ checkoutRoot, provenance, run = defaultRun } = {}) {
  stagingAssert(path.isAbsolute(checkoutRoot ?? ""), "PATCH_CHECKOUT_INVALID", "checkout root must be absolute");
  const patch = provenance?.simulatorPatch;
  stagingAssert(isPlainObject(patch), "PATCH_PROVENANCE_INVALID", "Simulator patch provenance is required");
  stagingAssert(Array.isArray(patch.changedPaths) && patch.changedPaths.length > 0, "PATCH_SCOPE_INVALID", "Simulator patch changed paths are required");
  stagingAssert(Array.isArray(patch.fileDigests) && patch.fileDigests.length === patch.changedPaths.length, "PATCH_PROVENANCE_INVALID", "Simulator patch file digests are required");
  const expectedPaths = [...patch.changedPaths].sort();
  stagingAssert(new Set(expectedPaths).size === expectedPaths.length && expectedPaths.every(isAllowedPatchPath), "PATCH_SCOPE_INVALID", "Simulator patch contains an unsupported path");
  stagingAssert(JSON.stringify(patch.changedPaths) === JSON.stringify(expectedPaths), "PATCH_SCOPE_INVALID", "Simulator patch paths must be sorted");
  const digestByPath = new Map(patch.fileDigests.map((entry) => [entry?.path, entry]));
  stagingAssert(digestByPath.size === expectedPaths.length && expectedPaths.every((entry) => digestByPath.has(entry)), "PATCH_PROVENANCE_INVALID", "Simulator patch file digests do not match changed paths");

  const patchPath = safeModulePath(patch.path);
  const packagePath = path.join(checkoutRoot, "package.json");
  const patchSha256 = await hashRegularFile(patchPath, "PATCH_FILE_INVALID");
  stagingAssert(patchSha256 === patch.sha256, "PATCH_HASH_MISMATCH", "Simulator patch digest does not match provenance");
  for (const relativePath of expectedPaths) {
    const digest = digestByPath.get(relativePath);
    stagingAssert(isPlainObject(digest) && digest.path === relativePath && (digest.preimageSha256 === null || isSha256(digest.preimageSha256)) && isSha256(digest.postimageSha256), "PATCH_PROVENANCE_INVALID", `invalid patch digest entry for ${relativePath}`);
    const filename = safeCheckoutPath(checkoutRoot, relativePath);
    if (digest.preimageSha256 === null) {
      await assertMissing(filename, "PATCH_PREIMAGE_MISMATCH");
    } else {
      stagingAssert(await hashRegularFile(filename, "PATCH_PREIMAGE_INVALID") === digest.preimageSha256, "PATCH_PREIMAGE_MISMATCH", `${relativePath} does not match the pinned patch preimage`);
    }
  }
  const preimageSha256 = await hashRegularFile(packagePath, "PATCH_PREIMAGE_INVALID");
  stagingAssert(preimageSha256 === patch.preimageSha256 && preimageSha256 === provenance.upstreamManifest.sha256, "PATCH_PREIMAGE_MISMATCH", "package.json does not match the pinned patch preimage");

  await run("git", ["apply", "--check", "--whitespace=error-all", patchPath], { cwd: checkoutRoot });
  await run("git", ["apply", "--whitespace=error-all", patchPath], { cwd: checkoutRoot });

  const postimageSha256 = await hashRegularFile(packagePath, "PATCH_POSTIMAGE_INVALID");
  stagingAssert(postimageSha256 === patch.postimageSha256, "PATCH_POSTIMAGE_MISMATCH", "patched package.json digest does not match provenance");
  for (const relativePath of expectedPaths) {
    const digest = digestByPath.get(relativePath);
    stagingAssert(await hashRegularFile(safeCheckoutPath(checkoutRoot, relativePath), "PATCH_POSTIMAGE_INVALID") === digest.postimageSha256, "PATCH_POSTIMAGE_MISMATCH", `${relativePath} does not match the pinned patch postimage`);
  }
  const changedPaths = await changedPathsInCheckout(checkoutRoot, run);
  stagingAssert(JSON.stringify(changedPaths) === JSON.stringify(expectedPaths), "PATCH_SCOPE_INVALID", `patch changed unexpected paths: ${changedPaths.join(", ") || "none"}`);

  const manifest = await readJsonRegular(packagePath, "PATCH_POSTIMAGE_INVALID");
  await assertOnlyNodePtyApproval(provenance, manifest);
  assertNativeBuildsAllowed(manifest);
  return { path: patch.path, sha256: patchSha256, preimageSha256, postimageSha256, changedPaths, manifest };
}

export function assertOnlyNodePtyApproval(provenance, patchedManifest) {
  const fixturePath = path.join(moduleRoot, "fixtures", "upstream-package.open-design-v0.14.1.json");
  return readJsonRegular(fixturePath, "PATCH_FIXTURE_INVALID").then((upstreamManifest) => {
    stagingAssert(digestJsonBytes(upstreamManifest) === provenance.upstreamManifest.sha256, "PATCH_FIXTURE_INVALID", "real pinned manifest fixture digest does not match provenance");
    const expected = structuredClone(upstreamManifest);
    const allowed = expected?.pnpm?.onlyBuiltDependencies;
    stagingAssert(Array.isArray(allowed) && !allowed.includes("node-pty"), "PATCH_FIXTURE_INVALID", "pinned upstream fixture unexpectedly approves node-pty");
    allowed.splice(allowed.indexOf("protobufjs"), 0, "node-pty");
    stagingAssert(JSON.stringify(patchedManifest) === JSON.stringify(expected), "PATCH_SCOPE_INVALID", "patched manifest differs by more than the approved node-pty build entry");
  });
}

function safeModulePath(relativePath) {
  stagingAssert(typeof relativePath === "string" && relativePath.length > 0 && !path.isAbsolute(relativePath) && path.posix.normalize(relativePath) === relativePath && !relativePath.includes("\\") && !relativePath.split("/").some((part) => !part || part === "." || part === ".."), "PATCH_FILE_INVALID", "patch path must be normalized and module-relative");
  return path.join(moduleRoot, ...relativePath.split("/"));
}

function safeCheckoutPath(checkoutRoot, relativePath) {
  stagingAssert(isNormalizedRelativePath(relativePath), "PATCH_SCOPE_INVALID", "patch changed path must be normalized and checkout-relative");
  return path.join(checkoutRoot, ...relativePath.split("/"));
}

function isNormalizedRelativePath(relativePath) {
  return typeof relativePath === "string" && relativePath.length > 0 && !path.isAbsolute(relativePath) && path.posix.normalize(relativePath) === relativePath && !relativePath.includes("\\") && !relativePath.split("/").some((part) => !part || part === "." || part === "..");
}

const ALLOWED_PATCH_PATHS = new Set([
  "apps/daemon/src/routes/runs.ts",
  "apps/daemon/src/routes/static-resource.ts",
  "apps/daemon/src/routes/vela.ts",
  "apps/daemon/src/runtimes/defs/simulator-host.ts",
  "apps/daemon/src/runtimes/json-event-stream.ts",
  "apps/daemon/src/runtimes/registry.ts",
  "apps/daemon/src/runtimes/simulator-host-v2-event-stream.ts",
  "apps/daemon/src/server.ts",
  "apps/daemon/src/simulator-host-agent.ts",
  "apps/web/next.config.ts",
  "apps/web/src/App.tsx",
  "apps/web/src/components/AvatarMenu.tsx",
  "apps/web/src/components/EntrySettingsMenu.tsx",
  "apps/web/src/components/EntryShell.tsx",
  "apps/web/src/components/FileWorkspace.tsx",
  "apps/web/src/components/InlineModelSwitcher.tsx",
  "apps/web/src/components/ProjectView.tsx",
  "apps/web/src/components/SettingsDialog.tsx",
  "apps/web/src/index.css",
  "apps/web/src/providers/daemon.ts",
  "apps/web/src/providers/simulator-host-mode.js",
  "apps/web/src/styles/simulator-host.css",
  "package.json",
]);

export function isAllowedPatchPath(relativePath) {
  return isNormalizedRelativePath(relativePath) && ALLOWED_PATCH_PATHS.has(relativePath);
}

async function changedPathsInCheckout(checkoutRoot, run) {
  const [tracked, untracked] = await Promise.all([
    run("git", ["diff", "--name-only", "--no-ext-diff", "HEAD"], { cwd: checkoutRoot }),
    run("git", ["ls-files", "--others", "--exclude-standard"], { cwd: checkoutRoot }),
  ]);
  return [...new Set([...lines(stdout(tracked)), ...lines(stdout(untracked))])].sort();
}

function lines(value) {
  return value.trim().split("\n").filter(Boolean);
}

async function assertMissing(filename, code) {
  try {
    await lstat(filename);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    stagingFail(code, error.message);
  }
  stagingFail(code, `${filename} must not exist before applying the patch`);
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

async function hashRegularFile(filename, code) {
  const stat = await lstat(filename).catch((error) => stagingFail(code, error.message));
  stagingAssert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, code, `${filename} must be an unlinked regular file`);
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}

async function readJsonRegular(filename, code) {
  const stat = await lstat(filename).catch((error) => stagingFail(code, error.message));
  stagingAssert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, code, `${filename} must be an unlinked regular file`);
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    stagingFail(code, `invalid JSON: ${error.message}`);
  }
}

function digestJsonBytes(value) {
  return createHash("sha256").update(`${JSON.stringify(value, null, 2)}\n`).digest("hex");
}

function stdout(result) {
  const value = typeof result === "string" ? result : result?.stdout;
  stagingAssert(typeof value === "string", "COMMAND_OUTPUT_INVALID", "command runner did not return stdout");
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function defaultRun(command, args, options) {
  return await execFile(command, args, { ...options, maxBuffer: 16 * 1024 * 1024 });
}
