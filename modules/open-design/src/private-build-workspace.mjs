import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { applySimulatorPatch } from "./apply-simulator-patch.mjs";
import { EXPECTED_NEXT_ENV_BASE, EXPECTED_NEXT_ENV_GENERATED } from "./verify-upstream.mjs";
import { stagingAssert, stagingFail } from "./staging-error.mjs";

const execFile = promisify(execFileCallback);

export async function createPrivateBuildWorkspace({ sourceRoot, workParent, provenance, run = defaultRun } = {}) {
  stagingAssert(path.isAbsolute(sourceRoot ?? ""), "SOURCE_ROOT_INVALID", "source root must be absolute");
  stagingAssert(path.isAbsolute(workParent ?? ""), "WORK_PARENT_INVALID", "work parent must be absolute");
  const parent = await ensurePrivateDirectory(workParent, { create: true, code: "WORK_PARENT_INVALID" });
  const root = await mkdtemp(path.join(parent, "open-design-build-")).catch((error) => stagingFail("BUILD_ROOT_CREATE_FAILED", error.message));
  await chmod(root, 0o700).catch((error) => stagingFail("BUILD_ROOT_CREATE_FAILED", error.message));
  await assertPrivateDirectory(root, "BUILD_ROOT_INVALID");
  const checkoutRoot = path.join(root, "checkout");
  const homeRoot = path.join(root, "home");
  const tempRoot = path.join(root, "tmp");
  const cacheRoot = path.join(root, "cache");
  const storeRoot = path.join(root, "pnpm-store");
  const daemonBundleRoot = path.join(root, "daemon-bundle");
  const daemonClosureRoot = path.join(root, "daemon-closure");
  const webDeployRoot = path.join(root, "web-sidecar-deploy");
  const normalizedRoot = path.join(root, "normalized");
  await Promise.all([homeRoot, tempRoot, cacheRoot, storeRoot].map(async (directory) => {
    await mkdir(directory, { mode: 0o700 });
    await assertPrivateDirectory(directory, "BUILD_ROOT_INVALID");
  }));

  try {
    await run("git", ["clone", "--quiet", "--no-hardlinks", "--no-checkout", sourceRoot, checkoutRoot], { cwd: root });
    await chmod(checkoutRoot, 0o700).catch((error) => stagingFail("BUILD_CHECKOUT_INVALID", error.message));
    await run("git", ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", provenance.source.commit], { cwd: checkoutRoot });
    await assertCheckoutIdentity({ checkoutRoot, provenance, run, phase: "pre-patch" });
    await assertNoIgnoredOrUntrackedInputs(checkoutRoot, run);
    const appliedPatch = await applySimulatorPatch({ checkoutRoot, provenance, run });
    await assertPatchedCheckout({ checkoutRoot, provenance, run });
    return {
      root,
      checkoutRoot,
      homeRoot,
      tempRoot,
      cacheRoot,
      storeRoot,
      daemonBundleRoot,
      daemonClosureRoot,
      webDeployRoot,
      normalizedRoot,
      appliedPatch,
      async cleanup() {
        await chmod(root, 0o700).catch(() => undefined);
        await rm(root, { recursive: true, force: false });
      },
    };
  } catch (error) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function verifyPostBuildWorkspace({ workspace, provenance, buildStartedAtMs, run = defaultRun } = {}) {
  stagingAssert(Number.isFinite(buildStartedAtMs) && buildStartedAtMs > 0, "BUILD_TIME_INVALID", "build start time is required");
  const checkoutRoot = workspace?.checkoutRoot;
  stagingAssert(path.isAbsolute(checkoutRoot ?? ""), "BUILD_ROOT_INVALID", "workspace checkout root is invalid");
  await assertCheckoutIdentity({ checkoutRoot, provenance, run, phase: "post-build" });
  await assertPatchedCheckout({ checkoutRoot, provenance, run, allowNextGenerated: true });
  await run("git", ["diff", "--check"], { cwd: checkoutRoot });
  const requiredOutputs = [
    path.join(checkoutRoot, "apps/web/.next/standalone"),
    path.join(checkoutRoot, "apps/web/.next/static"),
    workspace.daemonBundleRoot,
    workspace.webDeployRoot,
  ];
  for (const output of requiredOutputs) {
    const stat = await lstat(output).catch((error) => stagingFail("BUILD_OUTPUT_MISSING", `${output}: ${error.message}`));
    stagingAssert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === currentUid(), "BUILD_OUTPUT_INVALID", `${output} must be an owner-built directory`);
    stagingAssert(stat.ctimeMs >= buildStartedAtMs, "BUILD_OUTPUT_STALE", `${output} predates the current build`);
  }
  return { checkedAt: new Date().toISOString(), buildStartedAt: new Date(buildStartedAtMs).toISOString(), requiredOutputs };
}

export function createHermeticBuildEnvironment({ workspace, nodeBin, provenance } = {}) {
  stagingAssert(path.isAbsolute(nodeBin ?? ""), "TOOLCHAIN_PATH_INVALID", "Node executable path must be absolute");
  const forced = provenance?.buildContract?.environmentPolicy?.force;
  stagingAssert(forced && typeof forced === "object" && !Array.isArray(forced), "BUILD_ENV_INVALID", "forced build environment policy is required");
  stagingAssert(Array.isArray(provenance.buildContract.environmentPolicy.inherit) && provenance.buildContract.environmentPolicy.inherit.length === 0, "BUILD_ENV_INVALID", "build environment must not inherit user variables");
  return Object.freeze({
    ...forced,
    HOME: workspace.homeRoot,
    TMPDIR: `${workspace.tempRoot}${path.sep}`,
    XDG_CACHE_HOME: workspace.cacheRoot,
    npm_config_cache: path.join(workspace.cacheRoot, "npm"),
    npm_config_store_dir: workspace.storeRoot,
    PATH: `${path.dirname(nodeBin)}:/usr/bin:/bin`,
  });
}

export async function ensurePrivateDirectory(directory, { create = false, code = "PRIVATE_DIRECTORY_INVALID" } = {}) {
  stagingAssert(path.isAbsolute(directory ?? ""), code, "directory must be absolute");
  if (create) await mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") stagingFail(code, error.message);
  });
  const resolved = await realpath(directory).catch((error) => stagingFail(code, error.message));
  await assertPrivateDirectory(resolved, code);
  return resolved;
}

export async function assertPrivateDirectory(directory, code = "PRIVATE_DIRECTORY_INVALID") {
  const stat = await lstat(directory).catch((error) => stagingFail(code, error.message));
  stagingAssert(stat.isDirectory() && !stat.isSymbolicLink(), code, "path must be a real directory");
  stagingAssert(stat.uid === currentUid(), code, "directory must be owned by the current user");
  stagingAssert((stat.mode & 0o077) === 0, code, "directory must not grant group or other permissions");
  return stat;
}

async function assertCheckoutIdentity({ checkoutRoot, provenance, run, phase }) {
  await assertPrivateDirectory(checkoutRoot, "BUILD_CHECKOUT_INVALID");
  const [commit, branch] = await Promise.all([
    run("git", ["rev-parse", "HEAD"], { cwd: checkoutRoot }),
    run("git", ["branch", "--show-current"], { cwd: checkoutRoot }),
  ]);
  stagingAssert(stdout(commit).trim() === provenance.source.commit, "BUILD_CHECKOUT_COMMIT_MISMATCH", `${phase} checkout commit changed`);
  stagingAssert(stdout(branch).trim() === "", "BUILD_CHECKOUT_NOT_DETACHED", `${phase} checkout must remain detached`);
}

async function assertNoIgnoredOrUntrackedInputs(checkoutRoot, run) {
  const status = stdout(await run("git", ["status", "--porcelain=v1", "--ignored", "--untracked-files=all", "-z"], { cwd: checkoutRoot }));
  stagingAssert(status.length === 0, "BUILD_CHECKOUT_CONTAMINATED", "fresh private checkout contains ignored, untracked, or modified inputs");
}

async function assertPatchedCheckout({ checkoutRoot, provenance, run, allowNextGenerated = false }) {
  const [trackedResult, untrackedResult] = await Promise.all([
    run("git", ["diff", "--name-only", "--no-ext-diff", "HEAD"], { cwd: checkoutRoot }),
    run("git", ["ls-files", "--others", "--exclude-standard"], { cwd: checkoutRoot }),
  ]);
  const changed = [...new Set([...lines(stdout(trackedResult)), ...lines(stdout(untrackedResult))])].sort();
  const patchPaths = [...provenance.simulatorPatch.changedPaths].sort();
  const allowed = allowNextGenerated ? [...patchPaths, "apps/web/next-env.d.ts"].sort() : patchPaths;
  stagingAssert(changed.length >= patchPaths.length && changed.every((entry) => allowed.includes(entry)) && patchPaths.every((entry) => changed.includes(entry)), "BUILD_SOURCE_MUTATED", `tracked or untracked changes exceed the patch contract: ${changed.join(", ") || "none"}`);
  stagingAssert(await hashRegular(path.join(checkoutRoot, "package.json")) === provenance.simulatorPatch.postimageSha256, "PATCH_POSTIMAGE_MISMATCH", "patched package.json changed after patch application");
  for (const entry of provenance.simulatorPatch.fileDigests) {
    stagingAssert(await hashRegular(path.join(checkoutRoot, ...entry.path.split("/"))) === entry.postimageSha256, "PATCH_POSTIMAGE_MISMATCH", `${entry.path} changed after patch application`);
  }
  for (const input of provenance.buildInputs) {
    if (input.path.startsWith("patches/") || patchPaths.includes(input.path) || input.path === "apps/web/next-env.d.ts") continue;
    stagingAssert(await hashRegular(path.join(checkoutRoot, ...input.path.split("/"))) === input.sha256, "BUILD_INPUT_HASH_MISMATCH", `${input.path} changed in private checkout`);
  }
  const nextEnv = await readFile(path.join(checkoutRoot, "apps/web/next-env.d.ts"), "utf8");
  stagingAssert(nextEnv === EXPECTED_NEXT_ENV_BASE || (allowNextGenerated && nextEnv === EXPECTED_NEXT_ENV_GENERATED), "BUILD_SOURCE_MUTATED", "next-env.d.ts is not the pinned input or exact known generated output");
}

function lines(value) {
  return value.trim().split("\n").filter(Boolean);
}

async function hashRegular(filename) {
  const stat = await lstat(filename).catch((error) => stagingFail("BUILD_INPUT_INVALID", error.message));
  stagingAssert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === currentUid(), "BUILD_INPUT_INVALID", `${filename} must be an owner-built unlinked regular file`);
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}

function currentUid() {
  stagingAssert(typeof process.getuid === "function", "OWNER_CHECK_UNSUPPORTED", "current platform cannot verify filesystem ownership");
  return process.getuid();
}

function stdout(result) {
  const value = typeof result === "string" ? result : result?.stdout;
  stagingAssert(typeof value === "string", "COMMAND_OUTPUT_INVALID", "command runner did not return stdout");
  return value;
}

async function defaultRun(command, args, options) {
  return await execFile(command, args, { ...options, maxBuffer: 32 * 1024 * 1024 });
}
