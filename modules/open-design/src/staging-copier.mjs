import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { stagingAssert, stagingFail } from "./staging-error.mjs";

export async function ensureEmptyStagingRoot(stagingRoot) {
  stagingAssert(path.isAbsolute(stagingRoot ?? ""), "STAGING_ROOT_INVALID", "staging root must be an absolute path");
  let stat = await lstat(stagingRoot).catch((error) => error.code === "ENOENT" ? null : stagingFail("STAGING_ROOT_INVALID", error.message));
  if (stat == null) {
    await mkdir(stagingRoot, { mode: 0o700 }).catch((error) => stagingFail("STAGING_ROOT_INVALID", error.message));
    stat = await lstat(stagingRoot).catch((error) => stagingFail("STAGING_ROOT_INVALID", error.message));
  }
  stagingAssert(stat.isDirectory() && !stat.isSymbolicLink(), "STAGING_ROOT_INVALID", "staging root must be a real directory");
  const directory = await opendir(stagingRoot).catch((error) => stagingFail("STAGING_ROOT_INVALID", error.message));
  for await (const _entry of directory) stagingFail("STAGING_ROOT_NOT_EMPTY", "staging root must be empty");
  return await realpath(stagingRoot).catch((error) => stagingFail("STAGING_ROOT_INVALID", error.message));
}

export async function copyStagingInputs({ stagingRoot, inputs, policy, target } = {}) {
  stagingAssert(Array.isArray(inputs) && inputs.length > 0, "STAGING_INPUTS_INVALID", "at least one explicit staging input is required");
  stagingAssert(isPlainObject(policy), "STAGING_POLICY_INVALID", "artifact policy must be an object");
  const root = await ensureEmptyStagingRoot(stagingRoot);
  const destinations = new Set();
  const copied = [];
  const excluded = [];
  let totalBytes = 0;

  for (const input of inputs) {
    validateInput(input);
    const sourceStat = await lstat(input.source).catch((error) => stagingFail("STAGING_SOURCE_INVALID", `${input.label}: ${error.message}`));
    stagingAssert(!sourceStat.isSymbolicLink(), "STAGING_SYMLINK_FORBIDDEN", `${input.label} source must not be a symlink`);
    const sourceReal = await realpath(input.source).catch((error) => stagingFail("STAGING_SOURCE_INVALID", `${input.label}: ${error.message}`));
    if (sourceStat.isDirectory()) {
      await copyDirectory(sourceReal, sourceReal, input.destination, input.label);
    } else if (sourceStat.isFile()) {
      await copyRegularFile(sourceReal, input.destination, input.label);
    } else {
      stagingFail("STAGING_SPECIAL_FILE_FORBIDDEN", `${input.label} source is not a regular file or directory`);
    }
  }

  return { root, copied, excluded, totalBytes };

  async function copyDirectory(sourceDirectory, sourceRoot, destinationRoot, label) {
    const before = await lstat(sourceDirectory).catch((error) => stagingFail("STAGING_SOURCE_INVALID", `${label}: ${error.message}`));
    stagingAssert(before.isDirectory() && !before.isSymbolicLink(), "STAGING_SYMLINK_FORBIDDEN", `${label} directory is not real`);
    const directory = await opendir(sourceDirectory).catch((error) => stagingFail("STAGING_SOURCE_INVALID", `${label}: ${error.message}`));
    for await (const dirent of directory) {
      const sourcePath = path.join(sourceDirectory, dirent.name);
      const relativeSourcePath = path.relative(sourceRoot, sourcePath).split(path.sep).join("/");
      const destinationPath = `${destinationRoot}/${relativeSourcePath}`;
      const stat = await lstat(sourcePath).catch((error) => stagingFail("STAGING_SOURCE_INVALID", `${label}: ${error.message}`));
      stagingAssert(!stat.isSymbolicLink(), "STAGING_SYMLINK_FORBIDDEN", `${label} contains a symlink: ${relativeSourcePath}`);
      if (stat.isDirectory()) {
        if (isExcludedPath(destinationPath, policy, target)) {
          excluded.push({ input: label, path: destinationPath, reason: "policy" });
          continue;
        }
        await copyDirectory(sourcePath, sourceRoot, destinationRoot, label);
      } else if (stat.isFile()) {
        await copyRegularFile(sourcePath, destinationPath, label);
      } else {
        stagingFail("STAGING_SPECIAL_FILE_FORBIDDEN", `${label} contains a special file: ${relativeSourcePath}`);
      }
    }
    const after = await lstat(sourceDirectory).catch((error) => stagingFail("STAGING_SOURCE_INVALID", `${label}: ${error.message}`));
    stagingAssert(sameIdentity(before, after), "STAGING_SOURCE_CHANGED", `${label} directory changed while copying`);
  }

  async function copyRegularFile(sourcePath, destinationPath, label) {
    if (isExcludedPath(destinationPath, policy, target)) {
      excluded.push({ input: label, path: destinationPath, reason: "policy" });
      return;
    }
    assertAllowedDestination(destinationPath, policy, target);
    stagingAssert(!destinations.has(destinationPath), "STAGING_DESTINATION_COLLISION", `multiple inputs resolve to ${destinationPath}`);
    destinations.add(destinationPath);
    const sourceStat = await lstat(sourcePath).catch((error) => stagingFail("STAGING_SOURCE_INVALID", `${label}: ${error.message}`));
    stagingAssert(sourceStat.isFile() && !sourceStat.isSymbolicLink(), "STAGING_SPECIAL_FILE_FORBIDDEN", `${label} contains a non-regular file: ${sourcePath}`);
    stagingAssert(sourceStat.nlink === 1, "STAGING_HARD_LINK_FORBIDDEN", `${label} contains a hard-linked file: ${sourcePath}`);
    stagingAssert(sourceStat.uid === currentUid(), "STAGING_OWNER_MISMATCH", `${label} source is not owned by the current user: ${sourcePath}`);
    stagingAssert(sourceStat.size <= policy.limits.maxFileBytes, "FILE_LIMIT_EXCEEDED", `${destinationPath} exceeds maxFileBytes`);
    stagingAssert(Number.isSafeInteger(totalBytes + sourceStat.size) && totalBytes + sourceStat.size <= policy.limits.maxTotalBytes, "TOTAL_SIZE_EXCEEDED", "staging inputs exceed maxTotalBytes");

    const destinationAbsolute = artifactPathToAbsolute(root, destinationPath);
    await ensureDestinationDirectory(path.dirname(destinationAbsolute), root);
    const copiedFile = await copyUnlinkedRegularFile(sourcePath, destinationAbsolute, sourceStat, destinationPath);
    totalBytes += copiedFile.bytes;
    copied.push({ input: label, path: destinationPath, bytes: copiedFile.bytes, sha256: copiedFile.sha256, mode: copiedFile.mode, sourceCtimeMs: sourceStat.ctimeMs, sourceMtimeMs: sourceStat.mtimeMs });
  }
}

async function copyUnlinkedRegularFile(sourcePath, destinationPath, expected, label) {
  const input = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)).catch((error) => stagingFail("STAGING_SOURCE_INVALID", `${label}: ${error.message}`));
  let output;
  try {
    const before = await input.stat();
    stagingAssert(before.isFile() && before.nlink === 1 && sameIdentity(before, expected), "STAGING_SOURCE_CHANGED", `${label} changed before copying`);
    output = await open(destinationPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600).catch((error) => stagingFail("STAGING_DESTINATION_INVALID", `${label}: ${error.message}`));
    const hash = (await import("node:crypto")).createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, position + written);
        stagingAssert(result.bytesWritten > 0, "STAGING_WRITE_FAILED", `${label} write made no progress`);
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    const after = await input.stat();
    const afterPath = await lstat(sourcePath);
    stagingAssert(sameIdentity(before, after) && sameIdentity(before, afterPath) && after.size === position, "STAGING_SOURCE_CHANGED", `${label} changed while copying`);
    const destinationStat = await output.stat();
    stagingAssert(destinationStat.isFile() && destinationStat.nlink === 1 && destinationStat.uid === currentUid() && destinationStat.size === position, "STAGING_DESTINATION_INVALID", `${label} destination did not remain an owner-built unlinked regular file`);
    const mode = before.mode & 0o111 ? 0o755 : 0o644;
    await chmod(destinationPath, mode);
    return { bytes: position, sha256: hash.digest("hex"), mode: mode.toString(8).padStart(4, "0") };
  } catch (error) {
    await output?.close().catch(() => undefined);
    output = undefined;
    await rm(destinationPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await output?.close().catch(() => undefined);
    await input.close().catch(() => undefined);
  }
}

function validateInput(input) {
  stagingAssert(isPlainObject(input), "STAGING_INPUTS_INVALID", "each staging input must be an object");
  stagingAssert(typeof input.label === "string" && input.label.length > 0, "STAGING_INPUTS_INVALID", "each staging input needs a label");
  stagingAssert(typeof input.source === "string" && path.isAbsolute(input.source), "STAGING_INPUTS_INVALID", `${input.label} source must be an absolute path`);
  stagingAssert(typeof input.destination === "string" && isNormalizedArtifactPath(input.destination), "STAGING_INPUTS_INVALID", `${input.label} destination must be a normalized artifact path`);
  stagingAssert(input.destination !== "artifact-manifest.json", "STAGING_DESTINATION_INVALID", "artifact-manifest.json is generated only after inventory validation");
}

function assertAllowedDestination(value, policy, target) {
  stagingAssert(isNormalizedArtifactPath(value), "STAGING_DESTINATION_INVALID", `invalid artifact path: ${value}`);
  stagingAssert(!isExcludedPath(value, policy, target), "STAGING_DESTINATION_FORBIDDEN", `policy excludes artifact path: ${value}`);
  const allowed = policy.exactPathRules?.some((rule) => rule.path === value) || policy.pathRules?.some((rule) => value.startsWith(rule.prefix));
  stagingAssert(allowed, "STAGING_DESTINATION_FORBIDDEN", `artifact path is outside the allowed profile: ${value}`);
}

function isExcludedPath(value, policy, target) {
  const lower = value.toLowerCase();
  if (lower.endsWith(".map")) return true;
  const segments = lower.split("/");
  if (lower.includes("/node-pty/third_party/")) return true;
  if (target?.platform && target?.arch) {
    const expected = `${target.platform}-${target.arch}`;
    if (segments.some((segment) => /^(darwin|linux|win32)-(arm64|x64)$/u.test(segment) && segment !== expected)) return true;
  }
  const segmentMatches = (pattern) => {
    const normalized = pattern.toLowerCase();
    if (normalized.includes("/")) return (`/${lower}/`).includes(`/${normalized}/`);
    return segments.some((segment) => matchesSimpleGlob(segment, normalized));
  };
  return (policy.forbiddenSegmentPatterns ?? []).some(segmentMatches)
    || (policy.forbiddenBasenamePatterns ?? []).some((pattern) => matchesSimpleGlob(path.posix.basename(lower), pattern.toLowerCase()));
}

function matchesSimpleGlob(value, pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "u").test(value);
}

function isNormalizedArtifactPath(value) {
  return typeof value === "string" && value.length > 0 && value === value.normalize("NFC") && !value.includes("\\") && !value.includes("\0")
    && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value
    && !value.split("/").some((part) => part === "" || part === "." || part === "..") && !/[\u0000-\u001f\u007f]/u.test(value);
}

function artifactPathToAbsolute(root, artifactPath) {
  const absolute = path.join(root, ...artifactPath.split("/"));
  stagingAssert(absolute === root || absolute.startsWith(`${root}${path.sep}`), "STAGING_DESTINATION_INVALID", `destination escapes staging root: ${artifactPath}`);
  return absolute;
}

async function ensureDestinationDirectory(directory, root) {
  const relative = path.relative(root, directory);
  stagingAssert(relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)), "STAGING_DESTINATION_INVALID", "destination directory escapes staging root");
  let current = root;
  for (const component of relative === "" ? [] : relative.split(path.sep)) {
    current = path.join(current, component);
    const stat = await lstat(current).catch((error) => error.code === "ENOENT" ? null : stagingFail("STAGING_DESTINATION_INVALID", error.message));
    if (stat == null) {
      await mkdir(current, { mode: 0o700 }).catch((error) => stagingFail("STAGING_DESTINATION_INVALID", error.message));
      continue;
    }
    stagingAssert(stat.isDirectory() && !stat.isSymbolicLink(), "STAGING_DESTINATION_INVALID", `destination component is not a real directory: ${current}`);
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.nlink === right.nlink;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function currentUid() {
  stagingAssert(typeof process.getuid === "function", "OWNER_CHECK_UNSUPPORTED", "current platform cannot verify filesystem ownership");
  return process.getuid();
}
