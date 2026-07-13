import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { stagingAssert, stagingFail } from "./staging-error.mjs";

const execFile = promisify(execFileCallback);
const moduleRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const EXPECTED_NEXT_ENV_BASE = [
  '/// <reference types="next" />',
  '/// <reference types="next/image-types/global" />',
  'import "./.next/dev/types/routes.d.ts";',
  "",
  "// NOTE: This file should not be edited",
  "// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.",
  ""
].join("\n");

export const EXPECTED_NEXT_ENV_GENERATED = EXPECTED_NEXT_ENV_BASE.replace(
  'import "./.next/dev/types/routes.d.ts";',
  'import "./.next/types/routes.d.ts";'
);

export async function verifyUpstream({
  sourceRoot,
  provenance,
  nodeBin,
  pnpmBin,
  inspectToolchain = defaultInspectToolchain,
  run = defaultRun,
} = {}) {
  stagingAssert(path.isAbsolute(sourceRoot ?? ""), "SOURCE_ROOT_INVALID", "source root must be an absolute path");
  const root = await realpath(sourceRoot).catch((error) => stagingFail("SOURCE_ROOT_INVALID", error.message));
  const sourceStat = await lstat(root).catch((error) => stagingFail("SOURCE_ROOT_INVALID", error.message));
  stagingAssert(sourceStat.isDirectory() && !sourceStat.isSymbolicLink(), "SOURCE_ROOT_INVALID", "source root must be a real directory");
  stagingAssert(isPlainObject(provenance), "PROVENANCE_INVALID", "provenance must be an object");

  const git = async (args) => trimStdout(await run("git", args, { cwd: root }));
  const gitRaw = async (args) => trimStdout(await run("git", args, { cwd: root }), false);
  stagingAssert(await git(["rev-parse", "--is-inside-work-tree"]) === "true", "SOURCE_GIT_INVALID", "source root must be a Git worktree");

  const actualRepository = await git(["remote", "get-url", "origin"]);
  stagingAssert(
    normalizeRepositoryUrl(actualRepository) === normalizeRepositoryUrl(provenance.repository),
    "SOURCE_REPOSITORY_MISMATCH",
    `origin ${actualRepository} does not exactly identify ${provenance.repository}`
  );

  const actualCommit = await git(["rev-parse", "HEAD"]);
  stagingAssert(actualCommit === provenance?.source?.commit, "SOURCE_COMMIT_MISMATCH", `HEAD ${actualCommit} does not match pinned commit ${provenance?.source?.commit}`);
  if (provenance?.source?.refType === "tag") {
    const tags = (await git(["tag", "--points-at", "HEAD", "--format=%(refname:short)"])).split("\n").filter(Boolean);
    stagingAssert(tags.includes(provenance.source.ref), "SOURCE_TAG_MISMATCH", `pinned tag ${provenance.source.ref} does not point at HEAD`);
  }

  const cleanliness = await verifyCleanWorkingTree({ root, gitRaw, run });
  const manifestText = await readGitFile(root, actualCommit, provenance?.upstreamManifest?.path, run, "UPSTREAM_MANIFEST_INVALID");
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    stagingFail("UPSTREAM_MANIFEST_INVALID", `invalid JSON: ${error.message}`);
  }
  verifyManifest(manifest, provenance);
  const manifestHash = hashBytes(manifestText);
  stagingAssert(manifestHash === provenance.upstreamManifest.sha256, "UPSTREAM_MANIFEST_HASH_MISMATCH", `package.json SHA-256 ${manifestHash} does not match pinned hash`);
  const lockfileText = await readGitFile(root, actualCommit, provenance?.lockfile?.path, run, "LOCKFILE_INVALID");
  const lockfileHash = hashBytes(lockfileText);
  stagingAssert(lockfileHash === provenance?.lockfile?.sha256, "LOCKFILE_HASH_MISMATCH", `lockfile SHA-256 ${lockfileHash} does not match pinned hash`);
  const sourceInputs = await verifyBuildInputs(root, actualCommit, provenance, run);

  const toolchain = await inspectToolchain({ nodeBin, pnpmBin, root, run });
  verifyToolchain({ manifest, provenance, toolchain });

  return {
    sourceRoot: root,
    repository: normalizeRepositoryUrl(actualRepository),
    commit: actualCommit,
    cleanliness,
    lockfile: { path: provenance.lockfile.path, sha256: lockfileHash },
    manifest,
    manifestDigest: { path: provenance.upstreamManifest.path, sha256: manifestHash },
    inputs: sourceInputs,
    toolchain,
  };
}

export function verifyToolchain({ manifest, provenance, toolchain }) {
  const expectedNode = provenance?.buildToolchainExpectations?.node;
  const expectedPnpm = parsePackageManager(provenance?.upstreamManifest?.packageManager);
  stagingAssert(expectedNode === "24.14.1", "TOOLCHAIN_EXPECTATION_INVALID", "provenance must pin Node 24.14.1");
  stagingAssert(provenance?.buildToolchainExpectations?.pnpm === "10.33.2", "TOOLCHAIN_EXPECTATION_INVALID", "provenance must pin pnpm 10.33.2");
  stagingAssert(expectedPnpm?.name === "pnpm" && expectedPnpm.version === "10.33.2", "TOOLCHAIN_EXPECTATION_INVALID", "provenance must pin pnpm@10.33.2");
  stagingAssert(manifest?.packageManager === "pnpm@10.33.2", "UPSTREAM_MANIFEST_MISMATCH", "upstream packageManager must be pnpm@10.33.2");
  stagingAssert(manifest?.engines?.node === "~24", "UPSTREAM_MANIFEST_MISMATCH", "upstream engines.node must be ~24");
  stagingAssert(manifest?.engines?.pnpm === ">=10.33.2 <11", "UPSTREAM_MANIFEST_MISMATCH", "upstream engines.pnpm must be >=10.33.2 <11");
  stagingAssert(isPlainObject(toolchain), "TOOLCHAIN_INSPECTION_INVALID", "toolchain inspection is required");
  for (const key of ["nodeVersion", "nodeAbi", "platform", "arch", "nodeExecutableSha256", "pnpmVersion", "pnpmExecutableSha256"]) {
    stagingAssert(typeof toolchain[key] === "string" && toolchain[key].length > 0, "TOOLCHAIN_INSPECTION_INVALID", `toolchain ${key} is required`);
  }
  const expected = provenance.buildToolchainExpectations;
  stagingAssert(normalizeVersion(toolchain.nodeVersion) === expected.node, "NODE_VERSION_MISMATCH", `Node ${toolchain.nodeVersion} does not equal ${expected.node}`);
  stagingAssert(toolchain.nodeAbi === expected.nodeAbi, "NODE_ABI_MISMATCH", `Node ABI ${toolchain.nodeAbi} does not equal ${expected.nodeAbi}`);
  stagingAssert(toolchain.platform === expected.platform && toolchain.arch === expected.arch, "TOOLCHAIN_PLATFORM_MISMATCH", `Node runtime ${toolchain.platform}-${toolchain.arch} does not equal ${expected.platform}-${expected.arch}`);
  stagingAssert(toolchain.nodeExecutableSha256 === expected.nodeExecutableSha256, "NODE_EXECUTABLE_MISMATCH", "Node executable digest does not match provenance");
  stagingAssert(normalizeVersion(toolchain.pnpmVersion) === expectedPnpm.version, "PNPM_VERSION_MISMATCH", `pnpm ${toolchain.pnpmVersion} does not equal ${expectedPnpm.version}`);
  stagingAssert(toolchain.pnpmExecutableSha256 === expected.pnpmExecutableSha256, "PNPM_EXECUTABLE_MISMATCH", "pnpm executable digest does not match provenance");
}

export async function defaultInspectToolchain({ nodeBin, pnpmBin, root, run = defaultRun } = {}) {
  for (const [label, value] of [["Node", nodeBin], ["pnpm", pnpmBin]]) {
    stagingAssert(typeof value === "string" && path.isAbsolute(value), "TOOLCHAIN_PATH_INVALID", `${label} executable path must be absolute`);
  }
  const [nodeExecutableSha256, pnpmExecutableSha256, runtimeResult, pnpmResult] = await Promise.all([
    hashRegularFile(nodeBin, "NODE_EXECUTABLE_INVALID"),
    hashRegularFile(pnpmBin, "PNPM_EXECUTABLE_INVALID"),
    run(nodeBin, ["-p", "JSON.stringify({nodeVersion:process.version,nodeAbi:process.versions.modules,platform:process.platform,arch:process.arch})"], { cwd: root }),
    run(nodeBin, [pnpmBin, "--version"], { cwd: root }),
  ]);
  let runtime;
  try {
    runtime = JSON.parse(trimStdout(runtimeResult));
  } catch (error) {
    stagingFail("TOOLCHAIN_INSPECTION_INVALID", `Node runtime inspection was not JSON: ${error.message}`);
  }
  return {
    ...runtime,
    nodeExecutable: await realpath(nodeBin),
    nodeExecutableSha256,
    pnpmVersion: trimStdout(pnpmResult),
    pnpmExecutable: await realpath(pnpmBin),
    pnpmExecutableSha256,
  };
}

export function normalizeRepositoryUrl(value) {
  stagingAssert(typeof value === "string" && value.length > 0, "SOURCE_REPOSITORY_INVALID", "repository URL must be non-empty");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    stagingFail("SOURCE_REPOSITORY_INVALID", `repository URL is invalid: ${value}`);
  }
  stagingAssert(parsed.protocol === "https:", "SOURCE_REPOSITORY_INVALID", "repository URL must use https");
  stagingAssert(!parsed.username && !parsed.password && !parsed.search && !parsed.hash, "SOURCE_REPOSITORY_INVALID", "repository URL must not contain credentials, query, or fragment");
  const pathname = parsed.pathname.replace(/\/+$/u, "").replace(/\.git$/u, "");
  stagingAssert(pathname.length > 1, "SOURCE_REPOSITORY_INVALID", "repository path is missing");
  return `https://${parsed.hostname.toLowerCase()}${pathname}`;
}

async function verifyCleanWorkingTree({ root, gitRaw, run }) {
  const status = await gitRaw(["status", "--porcelain=v1", "-z"]);
  if (status.length === 0) return { status: "clean", allowedGeneratedChange: false };
  const expectedStatus = " M apps/web/next-env.d.ts\0";
  stagingAssert(status === expectedStatus, "SOURCE_DIRTY", "worktree has changes other than the explicitly allowed Next-generated next-env.d.ts update");
  const base = trimStdout(await run("git", ["show", "HEAD:apps/web/next-env.d.ts"], { cwd: root }), false);
  const current = await readFile(path.join(root, "apps/web/next-env.d.ts"), "utf8");
  stagingAssert(base === EXPECTED_NEXT_ENV_BASE && current === EXPECTED_NEXT_ENV_GENERATED, "SOURCE_DIRTY", "next-env.d.ts does not exactly match the one accepted generated Next.js change");
  return { status: "known-next-env-generated-change", allowedGeneratedChange: true };
}

function verifyManifest(manifest, provenance) {
  stagingAssert(isPlainObject(manifest), "UPSTREAM_MANIFEST_INVALID", "upstream package.json must be an object");
  for (const key of ["name", "version", "packageManager"]) {
    stagingAssert(manifest[key] === provenance?.upstreamManifest?.[key], "UPSTREAM_MANIFEST_MISMATCH", `upstream package.json ${key} does not match provenance`);
  }
}

async function verifyBuildInputs(root, commit, provenance, run) {
  stagingAssert(Array.isArray(provenance?.buildInputs), "BUILD_INPUTS_INVALID", "provenance buildInputs must be an array");
  const seen = new Set();
  const verified = [];
  for (const input of provenance.buildInputs) {
    stagingAssert(isPlainObject(input) && typeof input.path === "string" && typeof input.sha256 === "string", "BUILD_INPUTS_INVALID", "build input entries require path and sha256");
    stagingAssert(!seen.has(input.path), "BUILD_INPUTS_INVALID", `duplicate build input: ${input.path}`);
    seen.add(input.path);
    if (input.path.startsWith("patches/")) {
      const patchPath = safeSourcePath(moduleRoot, input.path, "BUILD_INPUTS_INVALID");
      const sha256 = await hashRegularFile(patchPath, "BUILD_INPUTS_INVALID");
      stagingAssert(sha256 === input.sha256, "BUILD_INPUT_HASH_MISMATCH", `${input.path} SHA-256 does not match provenance`);
      verified.push({ path: input.path, sha256, owner: "simulator" });
      continue;
    }
    const content = await readGitFile(root, commit, input.path, run, "BUILD_INPUTS_INVALID");
    const sha256 = hashBytes(content);
    stagingAssert(sha256 === input.sha256, "BUILD_INPUT_HASH_MISMATCH", `${input.path} SHA-256 does not match provenance`);
    verified.push({ path: input.path, sha256, owner: "upstream" });
  }
  for (const required of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "apps/web/next-env.d.ts", provenance?.simulatorPatch?.path]) {
    stagingAssert(seen.has(required), "BUILD_INPUTS_INVALID", `required build input is not pinned: ${required}`);
  }
  return verified;
}

async function readGitFile(root, commit, relativePath, run, code) {
  safeSourcePath(root, relativePath, code);
  stagingAssert(/^[0-9a-f]{40}$/u.test(commit ?? ""), code, "Git object read requires a full commit SHA");
  try {
    return trimStdout(await run("git", ["show", `${commit}:${relativePath}`], { cwd: root }), false);
  } catch (error) {
    stagingFail(code, `cannot read ${relativePath} from pinned commit: ${error.message}`);
  }
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeSourcePath(root, relativePath, code) {
  stagingAssert(typeof relativePath === "string" && relativePath.length > 0 && !path.isAbsolute(relativePath) && path.posix.normalize(relativePath) === relativePath && !relativePath.includes("\\") && !relativePath.split("/").some((part) => !part || part === "." || part === ".."), code, "source path must be normalized and relative");
  return path.join(root, ...relativePath.split("/"));
}

async function readJsonRegular(filename, code) {
  const text = await readRegularFile(filename, code);
  try {
    return JSON.parse(text);
  } catch (error) {
    stagingFail(code, `invalid JSON: ${error.message}`);
  }
}

async function hashRegularFile(filename, code) {
  const text = await readRegularFile(filename, code);
  return createHash("sha256").update(text).digest("hex");
}

async function readRegularFile(filename, code) {
  const stat = await lstat(filename).catch((error) => stagingFail(code, error.message));
  stagingAssert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, code, `${filename} must be an unlinked regular file`);
  return await readFile(filename, "utf8").catch((error) => stagingFail(code, error.message));
}

function parsePackageManager(value) {
  const match = /^(?<name>[a-z0-9-]+)@(?<version>\d+\.\d+\.\d+)$/u.exec(value ?? "");
  return match?.groups;
}

function normalizeVersion(value) {
  return typeof value === "string" ? value.trim().replace(/^v/u, "") : "";
}

function trimStdout(result, trim = true) {
  const stdout = typeof result === "string" ? result : result?.stdout;
  stagingAssert(typeof stdout === "string", "COMMAND_OUTPUT_INVALID", "command runner did not return stdout");
  return trim ? stdout.trim() : stdout;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function defaultRun(command, args, options) {
  return await execFile(command, args, { ...options, maxBuffer: 16 * 1024 * 1024 });
}
