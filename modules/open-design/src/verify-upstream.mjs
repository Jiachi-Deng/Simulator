import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { stagingAssert, stagingFail } from "./staging-error.mjs";

const execFile = promisify(execFileCallback);

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
  nodeVersion = process.version,
  pnpmVersion,
  pnpmBin = "pnpm",
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
  const manifestPath = safeSourcePath(root, provenance?.upstreamManifest?.path, "UPSTREAM_MANIFEST_INVALID");
  const manifest = await readJsonRegular(manifestPath, "UPSTREAM_MANIFEST_INVALID");
  verifyManifest(manifest, provenance);
  const lockfilePath = safeSourcePath(root, provenance?.lockfile?.path, "LOCKFILE_INVALID");
  const lockfileHash = await hashRegularFile(lockfilePath, "LOCKFILE_INVALID");
  stagingAssert(lockfileHash === provenance?.lockfile?.sha256, "LOCKFILE_HASH_MISMATCH", `lockfile SHA-256 ${lockfileHash} does not match pinned hash`);

  const resolvedPnpmVersion = pnpmVersion ?? trimStdout(await run(pnpmBin, ["--version"], { cwd: root }));
  verifyToolchain({ manifest, provenance, nodeVersion, pnpmVersion: resolvedPnpmVersion });

  return {
    sourceRoot: root,
    repository: normalizeRepositoryUrl(actualRepository),
    commit: actualCommit,
    cleanliness,
    lockfile: { path: provenance.lockfile.path, sha256: lockfileHash },
    toolchain: { node: normalizeVersion(nodeVersion), pnpm: resolvedPnpmVersion },
    manifest,
  };
}

export function verifyToolchain({ manifest, provenance, nodeVersion, pnpmVersion }) {
  const expectedNode = provenance?.buildToolchainExpectations?.node;
  const expectedPnpmRange = provenance?.buildToolchainExpectations?.pnpm;
  const expectedPnpm = parsePackageManager(provenance?.upstreamManifest?.packageManager);
  stagingAssert(expectedNode === "~24", "TOOLCHAIN_EXPECTATION_INVALID", "provenance must pin Node ~24");
  stagingAssert(expectedPnpmRange === ">=10.33.2 <11", "TOOLCHAIN_EXPECTATION_INVALID", "provenance must pin pnpm >=10.33.2 <11");
  stagingAssert(expectedPnpm?.name === "pnpm" && expectedPnpm.version === "10.33.2", "TOOLCHAIN_EXPECTATION_INVALID", "provenance must pin pnpm@10.33.2");
  stagingAssert(manifest?.packageManager === "pnpm@10.33.2", "UPSTREAM_MANIFEST_MISMATCH", "upstream packageManager must be pnpm@10.33.2");
  stagingAssert(manifest?.engines?.node === "~24", "UPSTREAM_MANIFEST_MISMATCH", "upstream engines.node must be ~24");
  stagingAssert(manifest?.engines?.pnpm === ">=10.33.2 <11", "UPSTREAM_MANIFEST_MISMATCH", "upstream engines.pnpm must be >=10.33.2 <11");
  stagingAssert(parseMajor(nodeVersion) === 24, "NODE_VERSION_MISMATCH", `Node ${nodeVersion} does not satisfy ~24`);
  stagingAssert(normalizeVersion(pnpmVersion) === expectedPnpm.version, "PNPM_VERSION_MISMATCH", `pnpm ${pnpmVersion} does not equal ${expectedPnpm.version}`);
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

function parseMajor(value) {
  const match = /^v?(\d+)\.\d+\.\d+$/u.exec(normalizeVersion(value));
  return match == null ? null : Number(match[1]);
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
