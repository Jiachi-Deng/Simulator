import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdtemp, open, opendir, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, digestInventory } from "./validate-artifact.mjs";
import { ensurePrivateDirectory } from "./private-build-workspace.mjs";
import { stagingAssert, stagingFail } from "./staging-error.mjs";

export async function createAtomicStagingTarget(finalRoot) {
  stagingAssert(path.isAbsolute(finalRoot ?? ""), "PUBLISH_TARGET_INVALID", "publish target must be absolute");
  const parent = await ensurePrivateDirectory(path.dirname(finalRoot), { code: "PUBLISH_PARENT_INVALID" });
  const basename = path.basename(finalRoot);
  stagingAssert(basename.length > 0 && basename !== "." && basename !== "..", "PUBLISH_TARGET_INVALID", "publish target basename is invalid");
  await assertAbsent(finalRoot);
  await fsyncDirectory(parent, "PUBLISH_DURABILITY_UNSUPPORTED");
  const tempRoot = await mkdtemp(path.join(parent, `.${basename}.tmp-`)).catch((error) => stagingFail("PUBLISH_TEMP_FAILED", error.message));
  await chmod(tempRoot, 0o700);
  await assertOwnerDirectory(tempRoot, "PUBLISH_TEMP_FAILED");
  return {
    finalRoot,
    parent,
    tempRoot,
    published: false,
    async cleanup() {
      if (this.published) return;
      await makeTreeWritable(tempRoot).catch(() => undefined);
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

async function makeTreeWritable(root) {
  const stat = await lstat(root).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stat == null) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    await chmod(root, 0o600);
    return;
  }
  await chmod(root, 0o700);
  const directory = await opendir(root);
  for await (const entry of directory) await makeTreeWritable(path.join(root, entry.name));
}

export async function sealAndPublish({ target, inventory } = {}) {
  stagingAssert(target?.published === false && path.isAbsolute(target?.tempRoot ?? "") && path.isAbsolute(target?.finalRoot ?? ""), "PUBLISH_STATE_INVALID", "atomic staging target is invalid or already published");
  stagingAssert(inventory?.files && Array.isArray(inventory.files), "PUBLISH_INVENTORY_INVALID", "final inventory is required");
  await verifyFinalInventory(target.tempRoot, inventory);
  await sealTree(target.tempRoot);
  await verifySealedTree(target.tempRoot, inventory, { transportRootWritable: true });
  await fsyncDirectory(target.tempRoot, "PUBLISH_DURABILITY_UNSUPPORTED");
  await assertAbsent(target.finalRoot);
  await ensurePrivateDirectory(target.parent, { code: "PUBLISH_PARENT_INVALID" });
  await rename(target.tempRoot, target.finalRoot).catch((error) => stagingFail("PUBLISH_RENAME_FAILED", error.message));
  target.published = true;
  await chmod(target.finalRoot, 0o555).catch((error) => stagingFail("PUBLISH_SEAL_FAILED", error.message));
  await fsyncDirectory(target.finalRoot, "PUBLISH_DURABILITY_UNSUPPORTED");
  await verifySealedTree(target.finalRoot, inventory);
  await fsyncDirectory(target.parent, "PUBLISH_DURABILITY_UNSUPPORTED");
  return { root: target.finalRoot, atomic: true, sealed: true, durability: "fsync-complete" };
}

export async function writeExclusiveCanonicalJson(filename, value) {
  const payload = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const handle = await open(filename, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600)
    .catch((error) => stagingFail("ATTESTATION_WRITE_FAILED", error.message));
  try {
    let offset = 0;
    while (offset < payload.length) {
      const { bytesWritten } = await handle.write(payload, offset, payload.length - offset, offset);
      stagingAssert(bytesWritten > 0, "ATTESTATION_WRITE_FAILED", "JSON write made no progress");
      offset += bytesWritten;
    }
    const stat = await handle.stat();
    stagingAssert(stat.isFile() && stat.nlink === 1 && stat.uid === currentUid() && stat.size === payload.length, "ATTESTATION_WRITE_FAILED", "JSON output did not remain an owner-built unlinked regular file");
    await handle.sync().catch((error) => stagingFail("PUBLISH_DURABILITY_UNSUPPORTED", error.message));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function verifyFinalInventory(root, inventory) {
  const expected = new Map(inventory.files.map((file) => [file.path, file]));
  stagingAssert(expected.size === inventory.files.length, "PUBLISH_INVENTORY_INVALID", "inventory contains duplicate paths");
  const seen = new Set();
  await visit(root, "", async (absolutePath, relativePath, stat) => {
    if (stat.isDirectory()) return;
    const file = expected.get(relativePath);
    stagingAssert(file != null, "PUBLISH_INVENTORY_MISMATCH", `unattested final file: ${relativePath}`);
    seen.add(relativePath);
    const bytes = await readFile(absolutePath);
    stagingAssert(bytes.length === file.bytes, "PUBLISH_INVENTORY_MISMATCH", `byte count changed after inventory: ${relativePath}`);
    if (relativePath === "artifact-manifest.json") {
      stagingAssert(bytes.equals(Buffer.from(`${canonicalJson(inventory)}\n`)), "PUBLISH_INVENTORY_MISMATCH", "artifact manifest bytes do not equal final canonical inventory");
      stagingAssert(file.sha256 === digestInventory(inventory), "PUBLISH_INVENTORY_MISMATCH", "artifact manifest self digest is invalid");
    } else {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      stagingAssert(sha256 === file.sha256, "PUBLISH_INVENTORY_MISMATCH", `digest changed after inventory: ${relativePath}`);
    }
  });
  stagingAssert(seen.size === expected.size && [...expected.keys()].every((entry) => seen.has(entry)), "PUBLISH_INVENTORY_MISMATCH", "final tree is missing inventory files");
}

async function sealTree(root) {
  const directories = [];
  await visit(root, "", async (absolutePath, _relativePath, stat) => {
    if (stat.isDirectory()) {
      directories.push(absolutePath);
      return;
    }
    const executable = (stat.mode & 0o111) !== 0;
    await fsyncFile(absolutePath);
    await chmod(absolutePath, executable ? 0o555 : 0o444);
    await fsyncFile(absolutePath);
  });
  directories.sort((left, right) => right.length - left.length);
  for (const directory of directories.filter((entry) => entry !== root)) {
    await chmod(directory, 0o555);
    await fsyncDirectory(directory, "PUBLISH_DURABILITY_UNSUPPORTED");
  }
}

async function verifySealedTree(root, inventory, { transportRootWritable = false } = {}) {
  await verifyFinalInventory(root, inventory);
  await visit(root, "", async (_absolutePath, relativePath, stat) => {
    if (transportRootWritable && relativePath === "") {
      stagingAssert((stat.mode & 0o077) === 0, "PUBLISH_SEAL_FAILED", "transport root must remain owner-only before rename");
    } else stagingAssert((stat.mode & 0o222) === 0, "PUBLISH_SEAL_FAILED", `sealed path remains writable: ${relativePath || "."}`);
  });
}

async function visit(root, relativeDirectory, visitor) {
  const absoluteDirectory = relativeDirectory ? path.join(root, ...relativeDirectory.split("/")) : root;
  const directoryStat = await lstat(absoluteDirectory).catch((error) => stagingFail("PUBLISH_FILESYSTEM_ERROR", error.message));
  stagingAssert(directoryStat.isDirectory() && !directoryStat.isSymbolicLink() && directoryStat.uid === currentUid(), "PUBLISH_OWNER_MISMATCH", `directory is not owner-built: ${relativeDirectory || "."}`);
  await visitor(absoluteDirectory, relativeDirectory, directoryStat);
  const directory = await opendir(absoluteDirectory).catch((error) => stagingFail("PUBLISH_FILESYSTEM_ERROR", error.message));
  for await (const entry of directory) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const absolutePath = path.join(absoluteDirectory, entry.name);
    const stat = await lstat(absolutePath).catch((error) => stagingFail("PUBLISH_FILESYSTEM_ERROR", error.message));
    stagingAssert(!stat.isSymbolicLink(), "PUBLISH_SYMLINK_FORBIDDEN", `symlink is forbidden: ${relativePath}`);
    stagingAssert(stat.uid === currentUid(), "PUBLISH_OWNER_MISMATCH", `path is not owned by current user: ${relativePath}`);
    if (stat.isDirectory()) await visit(root, relativePath, visitor);
    else {
      stagingAssert(stat.isFile() && stat.nlink === 1, "PUBLISH_SPECIAL_FILE_FORBIDDEN", `path is not an unlinked regular file: ${relativePath}`);
      await visitor(absolutePath, relativePath, stat);
    }
  }
}

async function fsyncFile(filename) {
  const handle = await open(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)).catch((error) => stagingFail("PUBLISH_DURABILITY_UNSUPPORTED", error.message));
  try {
    await handle.sync().catch((error) => stagingFail("PUBLISH_DURABILITY_UNSUPPORTED", error.message));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function fsyncDirectory(directory, code) {
  const handle = await open(directory, fsConstants.O_RDONLY).catch((error) => stagingFail(code, error.message));
  try {
    await handle.sync().catch((error) => stagingFail(code, error.message));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function assertAbsent(filename) {
  const stat = await lstat(filename).catch((error) => error.code === "ENOENT" ? null : stagingFail("PUBLISH_TARGET_INVALID", error.message));
  stagingAssert(stat == null, "PUBLISH_TARGET_EXISTS", "publish target already exists and will not be replaced");
}

async function assertOwnerDirectory(directory, code) {
  const stat = await lstat(directory).catch((error) => stagingFail(code, error.message));
  stagingAssert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === currentUid() && (stat.mode & 0o077) === 0, code, "directory must be owner-only");
  const resolved = await realpath(directory).catch((error) => stagingFail(code, error.message));
  stagingAssert(resolved.length > 0, code, "directory cannot be resolved");
}

function currentUid() {
  stagingAssert(typeof process.getuid === "function", "OWNER_CHECK_UNSUPPORTED", "current platform cannot verify filesystem ownership");
  return process.getuid();
}
