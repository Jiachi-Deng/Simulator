import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, opendir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { stagingAssert, stagingFail } from "./staging-error.mjs";

export const REQUIRED_NATIVE_BUILD_PACKAGES = Object.freeze(["better-sqlite3", "node-pty", "sharp"]);
export const REQUIRED_STAGED_NATIVE_PACKAGES = Object.freeze(["better-sqlite3", "node-pty"]);
const NATIVE_EXTENSIONS = new Set([".node", ".so", ".dylib", ".dll", ".exe"]);
const NODE_PTY_HELPER_SUFFIX = "/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper";
const execFile = promisify(execFileCallback);
const addonLoader = fileURLToPath(new URL("load-native-addon.mjs", import.meta.url));

export function assertNativeBuildsAllowed(manifest) {
  const pnpm = manifest?.pnpm;
  stagingAssert(isPlainObject(pnpm), "NATIVE_BUILD_POLICY_INVALID", "upstream package.json must declare pnpm build policy");
  const allowed = pnpm.onlyBuiltDependencies;
  const ignored = pnpm.ignoredBuiltDependencies ?? [];
  stagingAssert(Array.isArray(allowed) && allowed.every((value) => typeof value === "string"), "NATIVE_BUILD_POLICY_INVALID", "pnpm.onlyBuiltDependencies must be a string array");
  stagingAssert(Array.isArray(ignored) && ignored.every((value) => typeof value === "string"), "NATIVE_BUILD_POLICY_INVALID", "pnpm.ignoredBuiltDependencies must be a string array when present");
  for (const packageName of REQUIRED_NATIVE_BUILD_PACKAGES) {
    stagingAssert(!ignored.includes(packageName) && allowed.includes(packageName), "NATIVE_BUILD_IGNORED", `${packageName} is not allowed to run its native build by pnpm`);
  }
}

export async function inspectNativeRuntime({
  artifactRoot,
  metadata,
  target,
  nodeBin,
  buildEvidence,
  loadAddon = defaultLoadAddon,
  runtime = { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules },
} = {}) {
  stagingAssert(path.isAbsolute(artifactRoot ?? ""), "NATIVE_ROOT_INVALID", "artifact root must be an absolute path");
  stagingAssert(isPlainObject(metadata), "NATIVE_METADATA_INVALID", "metadata must be an object keyed by artifact path");
  validateTarget(target, runtime);
  stagingAssert(path.isAbsolute(nodeBin ?? "") || loadAddon !== defaultLoadAddon, "NATIVE_NODE_INVALID", "exact Node executable path is required for native loading");
  stagingAssert(Number.isFinite(buildEvidence?.buildStartedAtMs) && Array.isArray(buildEvidence?.copied), "NATIVE_BUILD_EVIDENCE_INVALID", "native inspection requires build start and copy evidence");
  const copyByPath = new Map(buildEvidence.copied.map((entry) => [entry.path, entry]));

  const root = await realpath(artifactRoot).catch((error) => stagingFail("NATIVE_ROOT_INVALID", error.message));
  const rootStat = await lstat(root).catch((error) => stagingFail("NATIVE_ROOT_INVALID", error.message));
  stagingAssert(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "NATIVE_ROOT_INVALID", "artifact root must be a real directory");

  const entries = [];
  const seenPackages = new Set();
  const missingMetadata = [];
  await visitDirectory(root, "");
  if (missingMetadata.length > 0) stagingFail("NATIVE_METADATA_MISSING", `nativeTarget metadata is required for: ${missingMetadata.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))).join(", ")}`);
  for (const packageName of REQUIRED_STAGED_NATIVE_PACKAGES) {
    stagingAssert(seenPackages.has(packageName), "NATIVE_PACKAGE_MISSING", `${packageName} has no staged native binary`);
  }
  return entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));

  async function visitDirectory(absoluteDirectory, relativeDirectory) {
    const before = await lstat(absoluteDirectory).catch((error) => stagingFail("NATIVE_FILESYSTEM_ERROR", error.message));
    stagingAssert(before.isDirectory() && !before.isSymbolicLink(), "NATIVE_SYMLINK_FORBIDDEN", `directory is not a real directory: ${relativeDirectory || "."}`);
    const directory = await opendir(absoluteDirectory).catch((error) => stagingFail("NATIVE_FILESYSTEM_ERROR", error.message));
    for await (const dirent of directory) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${dirent.name}` : dirent.name;
      const absolutePath = path.join(absoluteDirectory, dirent.name);
      const stat = await lstat(absolutePath).catch((error) => stagingFail("NATIVE_FILESYSTEM_ERROR", error.message));
      stagingAssert(!stat.isSymbolicLink(), "NATIVE_SYMLINK_FORBIDDEN", `symlink is forbidden: ${relativePath}`);
      if (stat.isDirectory()) {
        await visitDirectory(absolutePath, relativePath);
        continue;
      }
      stagingAssert(stat.isFile(), "NATIVE_SPECIAL_FILE_FORBIDDEN", `only regular files are allowed: ${relativePath}`);
      stagingAssert(stat.nlink === 1, "NATIVE_HARD_LINK_FORBIDDEN", `hard-linked file is forbidden: ${relativePath}`);
      const runtimeClass = runtimeBinaryClass(relativePath);
      if (runtimeClass == null) continue;

      const packageName = packageNameForArtifactPath(relativePath);
      stagingAssert(packageName != null, "NATIVE_PACKAGE_UNKNOWN", `native binary is outside a known package path: ${relativePath}`);
      const nativeTarget = metadata[relativePath]?.nativeTarget;
      if (!isPlainObject(nativeTarget)) {
        missingMetadata.push(relativePath);
        continue;
      }
      validateNativeMetadata(nativeTarget, target, relativePath);
      const binary = runtimeClass === "wasm-resource" ? await inspectWasmBinary(absolutePath, relativePath) : await inspectNativeBinary(absolutePath, relativePath);
      if (runtimeClass !== "wasm-resource") {
        stagingAssert(binary.platform === target.platform, "NATIVE_PLATFORM_MISMATCH", `${relativePath} is ${binary.platform}, expected ${target.platform}`);
        stagingAssert(binary.arch === target.arch, "NATIVE_ARCH_MISMATCH", `${relativePath} is ${binary.arch}, expected ${target.arch}`);
      }
      const expectedFormat = artifactFormat(relativePath);
      stagingAssert(nativeTarget.format === expectedFormat, "NATIVE_FORMAT_MISMATCH", `${relativePath} has metadata format ${nativeTarget.format}, expected ${expectedFormat}`);
      const copyEvidence = copyByPath.get(relativePath);
      stagingAssert(copyEvidence != null && typeof copyEvidence.sha256 === "string", "NATIVE_BUILD_EVIDENCE_INVALID", `copy evidence is missing: ${relativePath}`);
      stagingAssert(copyEvidence.sourceCtimeMs >= buildEvidence.buildStartedAtMs, "NATIVE_OUTPUT_STALE", `${relativePath} source native output predates this build`);
      const sha256 = createHash("sha256").update(await readFile(absolutePath)).digest("hex");
      stagingAssert(sha256 === copyEvidence.sha256, "NATIVE_BUILD_EVIDENCE_INVALID", `${relativePath} digest differs from copy evidence`);
      const expectedMode = runtimeClass === "executable-native" ? "0755" : "0644";
      stagingAssert(copyEvidence.mode === expectedMode && (stat.mode & 0o777).toString(8).padStart(4, "0") === expectedMode, "NATIVE_MODE_MISMATCH", `${relativePath} must be mode ${expectedMode}`);
      let load = null;
      if (expectedFormat === "node-addon") {
        load = await loadAddon({ nodeBin, addonPath: absolutePath, relativePath });
        stagingAssert(load?.ok === true, "NATIVE_LOAD_FAILED", `${relativePath} did not load under the exact target Node runtime`);
        stagingAssert(load.nodeVersion === `v${target.nodeVersion ?? "24.18.0"}` && load.nodeAbi === target.nodeAbi && load.platform === target.platform && load.arch === target.arch, "NATIVE_LOAD_RUNTIME_MISMATCH", `${relativePath} loaded under a different Node runtime`);
      }
      entries.push({
        packageName,
        path: relativePath,
        format: expectedFormat,
        platform: target.platform,
        arch: target.arch,
        nodeAbi: target.nodeAbi,
        libc: target.libc,
        binaryFormat: binary.format,
        resourceClass: runtimeClass,
        mode: expectedMode,
        sha256,
        sourceCtime: new Date(copyEvidence.sourceCtimeMs).toISOString(),
        freshFromBuild: true,
        load,
      });
      seenPackages.add(packageName);
    }
    const after = await lstat(absoluteDirectory).catch((error) => stagingFail("NATIVE_FILESYSTEM_ERROR", error.message));
    stagingAssert(sameIdentity(before, after), "NATIVE_RUNTIME_CHANGED", `directory changed during native inspection: ${relativeDirectory || "."}`);
  }
}

async function defaultLoadAddon({ nodeBin, addonPath, relativePath }) {
  let result;
  try {
    result = await execFile(nodeBin, [addonLoader, addonPath], { maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    stagingFail("NATIVE_LOAD_FAILED", `${relativePath}: ${error.stderr || error.message}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    stagingFail("NATIVE_LOAD_FAILED", `${relativePath} loader returned invalid JSON: ${error.message}`);
  }
}

export async function inspectNativeBinary(filename, label = filename) {
  const handle = await open(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)).catch((error) => stagingFail("NATIVE_FILESYSTEM_ERROR", error.message));
  try {
    const before = await handle.stat();
    stagingAssert(before.isFile() && before.nlink === 1, "NATIVE_HARD_LINK_FORBIDDEN", `${label} must be an unlinked regular file`);
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    stagingAssert(sameIdentity(before, after), "NATIVE_RUNTIME_CHANGED", `${label} changed while inspecting binary header`);
    const header = buffer.subarray(0, bytesRead);
    return parseNativeHeader(header, label);
  } finally {
    await handle.close();
  }
}

async function inspectWasmBinary(filename, label) {
  const handle = await open(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)).catch((error) => stagingFail("NATIVE_FILESYSTEM_ERROR", error.message));
  try {
    const before = await handle.stat();
    stagingAssert(before.isFile() && before.nlink === 1, "NATIVE_HARD_LINK_FORBIDDEN", `${label} must be an unlinked regular file`);
    const magic = Buffer.alloc(4);
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
    const after = await handle.stat();
    stagingAssert(sameIdentity(before, after), "NATIVE_RUNTIME_CHANGED", `${label} changed while inspecting WASM header`);
    stagingAssert(bytesRead === 4 && magic.equals(Buffer.from([0x00, 0x61, 0x73, 0x6d])), "NATIVE_FORMAT_UNRECOGNIZED", `${label} is not a WebAssembly module`);
    return { format: "wasm" };
  } finally {
    await handle.close();
  }
}

export function parseNativeHeader(buffer, label = "native binary") {
  stagingAssert(Buffer.isBuffer(buffer) && buffer.length >= 4, "NATIVE_FORMAT_UNRECOGNIZED", `${label} is too short to identify`);
  if (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) return parseElf(buffer, label);
  if (buffer[0] === 0x4d && buffer[1] === 0x5a) return parsePe(buffer, label);
  const littleMagic = buffer.readUInt32LE(0);
  const bigMagic = buffer.readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf].includes(littleMagic) || [0xfeedface, 0xfeedfacf].includes(bigMagic)) return parseMachO(buffer, label, [0xfeedface, 0xfeedfacf].includes(littleMagic));
  stagingFail("NATIVE_FORMAT_UNRECOGNIZED", `${label} is not an ELF, PE, or Mach-O binary`);
}

function parseElf(buffer, label) {
  stagingAssert(buffer.length >= 20, "NATIVE_FORMAT_UNRECOGNIZED", `${label} has an incomplete ELF header`);
  const endian = buffer[5];
  stagingAssert(endian === 1 || endian === 2, "NATIVE_FORMAT_UNRECOGNIZED", `${label} has unknown ELF byte order`);
  const machine = endian === 1 ? buffer.readUInt16LE(18) : buffer.readUInt16BE(18);
  return { format: "elf", platform: "linux", arch: architectureForMachine(machine, label) };
}

function parsePe(buffer, label) {
  stagingAssert(buffer.length >= 0x40, "NATIVE_FORMAT_UNRECOGNIZED", `${label} has an incomplete PE header`);
  const offset = buffer.readUInt32LE(0x3c);
  stagingAssert(offset + 6 <= buffer.length && buffer.subarray(offset, offset + 4).equals(Buffer.from("PE\0\0")), "NATIVE_FORMAT_UNRECOGNIZED", `${label} has an invalid PE signature`);
  return { format: "pe", platform: "win32", arch: architectureForMachine(buffer.readUInt16LE(offset + 4), label) };
}

function parseMachO(buffer, label, littleEndian) {
  stagingAssert(buffer.length >= 8, "NATIVE_FORMAT_UNRECOGNIZED", `${label} has an incomplete Mach-O header`);
  const cpuType = littleEndian ? buffer.readInt32LE(4) : buffer.readInt32BE(4);
  const architecture = new Map([[0x01000007, "x64"], [0x0100000c, "arm64"]]).get(cpuType);
  stagingAssert(architecture != null, "NATIVE_ARCH_UNSUPPORTED", `${label} has unsupported Mach-O CPU type ${cpuType}`);
  return { format: "mach-o", platform: "darwin", arch: architecture };
}

function architectureForMachine(machine, label) {
  const architecture = new Map([[62, "x64"], [0x8664, "x64"], [183, "arm64"], [0xaa64, "arm64"]]).get(machine);
  stagingAssert(architecture != null, "NATIVE_ARCH_UNSUPPORTED", `${label} has unsupported machine type ${machine}`);
  return architecture;
}

function packageNameForArtifactPath(relativePath) {
  const parts = relativePath.split("/");
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (parts[index] !== "node_modules") continue;
    const scopeOrName = parts[index + 1];
    const name = scopeOrName?.startsWith("@") ? `${scopeOrName}/${parts[index + 2] ?? ""}` : scopeOrName;
    if (name === "better-sqlite3" || name === "node-pty" || name === "sharp" || name === "blake3-wasm") return name;
    if (scopeOrName === "@img" && parts[index + 2]?.startsWith("sharp-")) return "sharp";
  }
  return null;
}

function validateTarget(target, runtime) {
  stagingAssert(isPlainObject(target), "NATIVE_TARGET_INVALID", "target must be an object");
  stagingAssert(["darwin", "linux", "win32"].includes(target.platform), "NATIVE_TARGET_INVALID", "target platform is unsupported");
  stagingAssert(["arm64", "x64"].includes(target.arch), "NATIVE_TARGET_INVALID", "target arch is unsupported");
  stagingAssert(typeof target.nodeAbi === "string" && /^\d{1,4}$/u.test(target.nodeAbi), "NATIVE_TARGET_INVALID", "target nodeAbi is invalid");
  stagingAssert(["none", "glibc", "musl", "msvcrt"].includes(target.libc), "NATIVE_TARGET_INVALID", "target libc is unsupported");
  stagingAssert(target.platform === runtime?.platform && target.arch === runtime?.arch && target.nodeAbi === runtime?.nodeAbi, "NATIVE_RUNTIME_TARGET_MISMATCH", "native target must exactly match the executing Node platform, arch, and ABI");
}

function validateNativeMetadata(nativeTarget, target, relativePath) {
  stagingAssert(isPlainObject(nativeTarget), "NATIVE_METADATA_MISSING", `nativeTarget metadata is required: ${relativePath}`);
  for (const key of ["platform", "arch", "nodeAbi", "libc"]) {
    stagingAssert(nativeTarget[key] === target[key], "NATIVE_METADATA_MISMATCH", `${relativePath} nativeTarget.${key} does not match target`);
  }
}

function artifactFormat(relativePath) {
  const extension = path.posix.extname(relativePath).toLowerCase();
  return extension === ".node" ? "node-addon" : extension === ".wasm" ? "wasm-module" : extension === ".exe" || relativePath.endsWith(NODE_PTY_HELPER_SUFFIX) ? "executable" : "shared-library";
}

function runtimeBinaryClass(relativePath) {
  const extension = path.posix.extname(relativePath).toLowerCase();
  if (extension === ".wasm") return "wasm-resource";
  if (relativePath.endsWith(NODE_PTY_HELPER_SUFFIX)) return "executable-native";
  return NATIVE_EXTENSIONS.has(extension) ? "native-binary" : null;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.nlink === right.nlink;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
