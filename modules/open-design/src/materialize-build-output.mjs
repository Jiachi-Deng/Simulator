import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, readlink, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { stagingAssert, stagingFail } from "./staging-error.mjs";

const NATIVE_EXTENSIONS = new Set([".node", ".so", ".dylib", ".dll", ".exe"]);
const MAX_ENTRIES = 200_000;
const MAX_DEPTH = 256;

export async function materializeBuildOutput({ sourceRoot, destinationRoot, buildStartedAtMs } = {}) {
  stagingAssert(path.isAbsolute(sourceRoot ?? "") && path.isAbsolute(destinationRoot ?? ""), "MATERIALIZE_ROOT_INVALID", "source and destination roots must be absolute");
  stagingAssert(Number.isFinite(buildStartedAtMs), "MATERIALIZE_TIME_INVALID", "build start time is required");
  const sourceReal = await realpath(sourceRoot).catch((error) => stagingFail("MATERIALIZE_SOURCE_INVALID", error.message));
  const sourceStat = await lstat(sourceRoot).catch((error) => stagingFail("MATERIALIZE_SOURCE_INVALID", error.message));
  stagingAssert(sourceStat.isDirectory() && !sourceStat.isSymbolicLink() && sourceStat.uid === currentUid(), "MATERIALIZE_SOURCE_INVALID", "source root must be an owner-built real directory");
  await mkdir(destinationRoot, { mode: 0o700 }).catch((error) => stagingFail("MATERIALIZE_DESTINATION_INVALID", error.message));
  const destinationStat = await lstat(destinationRoot).catch((error) => stagingFail("MATERIALIZE_DESTINATION_INVALID", error.message));
  stagingAssert(destinationStat.isDirectory() && !destinationStat.isSymbolicLink() && destinationStat.uid === currentUid() && (destinationStat.mode & 0o077) === 0, "MATERIALIZE_DESTINATION_INVALID", "destination root must be a new owner-only directory");

  let entries = 0;
  let symlinksMaterialized = 0;
  let hardlinksMaterialized = 0;
  const nativeOrigins = [];
  try {
    await copyDirectory(sourceReal, destinationRoot, "", new Set(), 0);
    return { root: destinationRoot, symlinksMaterialized, hardlinksMaterialized, nativeOrigins: nativeOrigins.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path))) };
  } catch (error) {
    await rm(destinationRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  async function copyDirectory(sourceDirectory, destinationDirectory, relativePath, ancestors, depth) {
    stagingAssert(depth <= MAX_DEPTH, "MATERIALIZE_DEPTH_EXCEEDED", `output nesting exceeds ${MAX_DEPTH}: ${relativePath || "."}`);
    const sourceDirectoryReal = await realpath(sourceDirectory).catch((error) => stagingFail("MATERIALIZE_SOURCE_INVALID", error.message));
    assertContained(sourceReal, sourceDirectoryReal, relativePath);
    stagingAssert(!ancestors.has(sourceDirectoryReal), "MATERIALIZE_SYMLINK_CYCLE", `directory cycle detected: ${relativePath || "."}`);
    const nextAncestors = new Set(ancestors).add(sourceDirectoryReal);
    const before = await lstat(sourceDirectoryReal).catch((error) => stagingFail("MATERIALIZE_SOURCE_INVALID", error.message));
    stagingAssert(before.isDirectory() && !before.isSymbolicLink() && before.uid === currentUid(), "MATERIALIZE_SOURCE_INVALID", `directory is not owner-built: ${relativePath || "."}`);
    const directory = await opendir(sourceDirectoryReal).catch((error) => stagingFail("MATERIALIZE_SOURCE_INVALID", error.message));
    for await (const entry of directory) {
      entries += 1;
      stagingAssert(entries <= MAX_ENTRIES, "MATERIALIZE_ENTRY_LIMIT_EXCEEDED", `output exceeds ${MAX_ENTRIES} entries`);
      const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const sourcePath = path.join(sourceDirectoryReal, entry.name);
      const destinationPath = path.join(destinationDirectory, entry.name);
      await copyEntry(sourcePath, destinationPath, childRelative, nextAncestors, depth + 1);
    }
    const after = await lstat(sourceDirectoryReal).catch((error) => stagingFail("MATERIALIZE_SOURCE_INVALID", error.message));
    stagingAssert(sameIdentity(before, after), "MATERIALIZE_SOURCE_CHANGED", `directory changed while materializing: ${relativePath || "."}`);
  }

  async function copyEntry(sourcePath, destinationPath, relativePath, ancestors, depth) {
    const stat = await lstat(sourcePath).catch((error) => stagingFail("MATERIALIZE_SOURCE_INVALID", error.message));
    if (stat.isSymbolicLink()) {
      const linkTarget = await readlink(sourcePath).catch((error) => stagingFail("MATERIALIZE_SYMLINK_INVALID", error.message));
      stagingAssert(!path.isAbsolute(linkTarget), "MATERIALIZE_SYMLINK_ESCAPE", `absolute symlink is forbidden: ${relativePath}`);
      const resolved = await realpath(sourcePath).catch((error) => stagingFail("MATERIALIZE_SYMLINK_INVALID", `${relativePath}: ${error.message}`));
      assertContained(sourceReal, resolved, relativePath);
      const after = await lstat(sourcePath).catch((error) => stagingFail("MATERIALIZE_SOURCE_INVALID", error.message));
      stagingAssert(sameIdentity(stat, after), "MATERIALIZE_SOURCE_CHANGED", `symlink changed while resolving: ${relativePath}`);
      symlinksMaterialized += 1;
      const targetStat = await lstat(resolved).catch((error) => stagingFail("MATERIALIZE_SYMLINK_INVALID", error.message));
      if (targetStat.isDirectory()) {
        await mkdir(destinationPath, { mode: 0o700 });
        await copyDirectory(resolved, destinationPath, relativePath, ancestors, depth);
      } else if (targetStat.isFile()) {
        await copyFile(resolved, destinationPath, relativePath, targetStat);
      } else stagingFail("MATERIALIZE_SPECIAL_FILE_FORBIDDEN", `symlink resolves to a special file: ${relativePath}`);
      return;
    }
    if (stat.isDirectory()) {
      await mkdir(destinationPath, { mode: 0o700 });
      await copyDirectory(sourcePath, destinationPath, relativePath, ancestors, depth);
      return;
    }
    if (stat.isFile()) {
      await copyFile(sourcePath, destinationPath, relativePath, stat);
      return;
    }
    stagingFail("MATERIALIZE_SPECIAL_FILE_FORBIDDEN", `special file is forbidden: ${relativePath}`);
  }

  async function copyFile(sourcePath, destinationPath, relativePath, expected) {
    stagingAssert(expected.nlink >= 1, "MATERIALIZE_SOURCE_INVALID", `source link count is invalid: ${relativePath}`);
    if (expected.nlink > 1) hardlinksMaterialized += 1;
    stagingAssert(expected.uid === currentUid(), "MATERIALIZE_OWNER_MISMATCH", `source is not owned by the current user: ${relativePath}`);
    const input = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)).catch((error) => stagingFail("MATERIALIZE_SOURCE_INVALID", error.message));
    let output;
    try {
      const before = await input.stat();
      stagingAssert(before.isFile() && sameIdentity(before, expected), "MATERIALIZE_SOURCE_CHANGED", `file changed before copying: ${relativePath}`);
      output = await open(destinationPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (true) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(buffer, written, bytesRead - written, position + written);
          stagingAssert(result.bytesWritten > 0, "MATERIALIZE_WRITE_FAILED", `write made no progress: ${relativePath}`);
          written += result.bytesWritten;
        }
        position += bytesRead;
      }
      const after = await input.stat();
      const afterPath = await lstat(sourcePath);
      stagingAssert(sameIdentity(before, after) && sameIdentity(before, afterPath) && after.size === position, "MATERIALIZE_SOURCE_CHANGED", `file changed while copying: ${relativePath}`);
      const destinationStat = await output.stat();
      stagingAssert(destinationStat.isFile() && destinationStat.nlink === 1 && destinationStat.uid === currentUid() && destinationStat.size === position, "MATERIALIZE_DESTINATION_INVALID", `destination is not an owner-built unlinked regular file: ${relativePath}`);
      await chmod(destinationPath, before.mode & 0o111 ? 0o755 : 0o644);
      const sha256 = hash.digest("hex");
      if (NATIVE_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
        stagingAssert(before.ctimeMs >= buildStartedAtMs, "NATIVE_OUTPUT_STALE", `native source predates this build: ${relativePath}`);
        nativeOrigins.push({ path: relativePath, sha256, sourceCtime: new Date(before.ctimeMs).toISOString(), mode: before.mode & 0o111 ? "0755" : "0644" });
      }
    } finally {
      await output?.close().catch(() => undefined);
      await input.close().catch(() => undefined);
    }
  }
}

export async function hoistMaterializedPnpmAliases({ materialized, buildStartedAtMs } = {}) {
  stagingAssert(path.isAbsolute(materialized?.root ?? "") && Array.isArray(materialized?.nativeOrigins), "MATERIALIZE_ROOT_INVALID", "materialized output evidence is required");
  const virtualRoot = path.join(materialized.root, "node_modules/.pnpm/node_modules");
  const virtualStat = await lstat(virtualRoot).catch((error) => error.code === "ENOENT" ? null : stagingFail("MATERIALIZE_SOURCE_INVALID", error.message));
  if (virtualStat == null) {
    materialized.virtualStorePackagesHoisted = 0;
    return { packagesHoisted: 0, nativeOrigins: [] };
  }
  stagingAssert(virtualStat.isDirectory() && !virtualStat.isSymbolicLink() && virtualStat.uid === currentUid(), "MATERIALIZE_SOURCE_INVALID", "pnpm virtual hoist root must be an owner-built real directory");
  const packagePaths = await listVirtualPackages(virtualRoot);
  const originByPath = new Map(materialized.nativeOrigins.map((entry) => [entry.path, entry]));
  const nativeOrigins = [];
  let packagesHoisted = 0;
  for (const packagePath of packagePaths) {
    const destination = path.join(materialized.root, "node_modules", ...packagePath.split("/"));
    const existing = await lstat(destination).catch((error) => error.code === "ENOENT" ? null : stagingFail("MATERIALIZE_DESTINATION_INVALID", error.message));
    if (existing != null) continue;
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const source = path.join(virtualRoot, ...packagePath.split("/"));
    const result = await materializeBuildOutput({ sourceRoot: source, destinationRoot: destination, buildStartedAtMs: 0 });
    for (const origin of result.nativeOrigins) {
      const sourcePath = `node_modules/.pnpm/node_modules/${packagePath}/${origin.path}`;
      const original = originByPath.get(sourcePath);
      stagingAssert(original?.sha256 === origin.sha256 && Date.parse(original.sourceCtime) >= buildStartedAtMs, "NATIVE_BUILD_EVIDENCE_INVALID", `hoisted native alias lacks original build evidence: ${sourcePath}`);
      nativeOrigins.push({ path: `node_modules/${packagePath}/${origin.path}`, sha256: original.sha256, sourceCtime: original.sourceCtime, mode: original.mode });
    }
    packagesHoisted += 1;
  }
  materialized.nativeOrigins.push(...nativeOrigins);
  materialized.nativeOrigins.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  materialized.virtualStorePackagesHoisted = packagesHoisted;
  return { packagesHoisted, nativeOrigins };
}

async function listVirtualPackages(virtualRoot) {
  const packagePaths = [];
  const directory = await opendir(virtualRoot).catch((error) => stagingFail("MATERIALIZE_SOURCE_INVALID", error.message));
  for await (const entry of directory) {
    const entryPath = path.join(virtualRoot, entry.name);
    const stat = await lstat(entryPath).catch((error) => stagingFail("MATERIALIZE_SOURCE_INVALID", error.message));
    stagingAssert(stat.isDirectory() && !stat.isSymbolicLink(), "MATERIALIZE_SOURCE_INVALID", `virtual package alias is not a real directory: ${entry.name}`);
    if (!entry.name.startsWith("@")) {
      packagePaths.push(entry.name);
      continue;
    }
    const scoped = await opendir(entryPath).catch((error) => stagingFail("MATERIALIZE_SOURCE_INVALID", error.message));
    for await (const child of scoped) {
      const childStat = await lstat(path.join(entryPath, child.name)).catch((error) => stagingFail("MATERIALIZE_SOURCE_INVALID", error.message));
      stagingAssert(childStat.isDirectory() && !childStat.isSymbolicLink(), "MATERIALIZE_SOURCE_INVALID", `virtual scoped package alias is not a real directory: ${entry.name}/${child.name}`);
      packagePaths.push(`${entry.name}/${child.name}`);
    }
  }
  return packagePaths.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function assertContained(root, candidate, relativePath) {
  stagingAssert(candidate === root || candidate.startsWith(`${root}${path.sep}`), "MATERIALIZE_SYMLINK_ESCAPE", `resolved path escapes output root: ${relativePath}`);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.nlink === right.nlink;
}

function currentUid() {
  stagingAssert(typeof process.getuid === "function", "OWNER_CHECK_UNSUPPORTED", "current platform cannot verify filesystem ownership");
  return process.getuid();
}
