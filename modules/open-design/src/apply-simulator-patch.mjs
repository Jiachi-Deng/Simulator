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
  stagingAssert(Array.isArray(patch.changedPaths) && patch.changedPaths.length === 1 && patch.changedPaths[0] === "package.json", "PATCH_SCOPE_INVALID", "patch may change only package.json");

  const patchPath = safeModulePath(patch.path);
  const packagePath = path.join(checkoutRoot, "package.json");
  const [patchSha256, preimageSha256] = await Promise.all([
    hashRegularFile(patchPath, "PATCH_FILE_INVALID"),
    hashRegularFile(packagePath, "PATCH_PREIMAGE_INVALID"),
  ]);
  stagingAssert(patchSha256 === patch.sha256, "PATCH_HASH_MISMATCH", "Simulator patch digest does not match provenance");
  stagingAssert(preimageSha256 === patch.preimageSha256 && preimageSha256 === provenance.upstreamManifest.sha256, "PATCH_PREIMAGE_MISMATCH", "package.json does not match the pinned patch preimage");

  await run("git", ["apply", "--check", "--whitespace=error-all", patchPath], { cwd: checkoutRoot });
  await run("git", ["apply", "--whitespace=error-all", patchPath], { cwd: checkoutRoot });

  const postimageSha256 = await hashRegularFile(packagePath, "PATCH_POSTIMAGE_INVALID");
  stagingAssert(postimageSha256 === patch.postimageSha256, "PATCH_POSTIMAGE_MISMATCH", "patched package.json digest does not match provenance");
  const changedPaths = stdout(await run("git", ["diff", "--name-only", "--no-ext-diff"], { cwd: checkoutRoot })).trim().split("\n").filter(Boolean);
  stagingAssert(changedPaths.length === 1 && changedPaths[0] === "package.json", "PATCH_SCOPE_INVALID", `patch changed unexpected paths: ${changedPaths.join(", ") || "none"}`);

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
