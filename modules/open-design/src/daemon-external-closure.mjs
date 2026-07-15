import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, readFile, realpath, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";

import { stagingAssert, stagingFail } from "./staging-error.mjs";

export const DAEMON_EXTERNAL_ALLOWLIST = Object.freeze(["better-sqlite3", "node-pty", "blake3-wasm"]);
export const DAEMON_BUNDLE_BANNER = "import { createRequire as __openDesignCreateRequire } from 'node:module'; const require = __openDesignCreateRequire(import.meta.url);";

const EXPECTED_PACKAGES = Object.freeze({
  "better-sqlite3": "12.10.0",
  bindings: "1.5.0",
  "file-uri-to-path": "1.0.0",
  "node-pty": "1.1.0",
  "blake3-wasm": "2.1.5",
});
const DAEMON_PACKAGE = Object.freeze({ name: "@open-design/daemon", version: "0.14.1" });
// The policy runner may use Node 22 while the staged daemon is pinned to Node 24.
const BUILTIN_MODULES = new Set([...builtinModules, "sqlite"].flatMap((name) => [name, `node:${name}`]));

export async function buildDaemonExternalClosure({ checkoutRoot, bundlePath, metafilePath, destinationRoot, buildStartedAtMs, target, packageRoots } = {}) {
  stagingAssert(path.isAbsolute(checkoutRoot ?? "") && path.isAbsolute(bundlePath ?? "") && path.isAbsolute(metafilePath ?? "") && path.isAbsolute(destinationRoot ?? ""), "DAEMON_CLOSURE_ROOT_INVALID", "closure paths must be absolute");
  stagingAssert(Number.isFinite(buildStartedAtMs), "DAEMON_CLOSURE_TIME_INVALID", "build start time is required");
  stagingAssert(target?.platform === "darwin" && target.arch === "arm64", "DAEMON_CLOSURE_TARGET_UNSUPPORTED", "only darwin-arm64 daemon closure is supported");
  const checkoutReal = await realpath(checkoutRoot).catch((error) => stagingFail("DAEMON_CLOSURE_ROOT_INVALID", error.message));
  const bundleReal = await realpath(bundlePath).catch((error) => stagingFail("DAEMON_CLOSURE_REQUIRED_FILE_MISSING", error.message));
  const metafile = await validateDaemonMetafile({ metafilePath, checkoutRoot: checkoutReal, bundlePath: bundleReal, workingDirectory: path.join(checkoutReal, "apps/packaged") });
  await mkdir(destinationRoot, { mode: 0o700 }).catch((error) => stagingFail("DAEMON_CLOSURE_DESTINATION_INVALID", error.message));
  const destinationStat = await lstat(destinationRoot).catch((error) => stagingFail("DAEMON_CLOSURE_DESTINATION_INVALID", error.message));
  stagingAssert(destinationStat.isDirectory() && !destinationStat.isSymbolicLink() && destinationStat.uid === currentUid(), "DAEMON_CLOSURE_DESTINATION_INVALID", "closure destination must be an owner-built real directory");

  const sourceRoots = await resolvePackageRoots({ checkoutRoot: checkoutReal, packageRoots });
  const files = [];
  const nativeOrigins = [];
  try {
    await copyFile({ source: bundlePath, destination: path.join(destinationRoot, "dist/sidecar/index.js"), artifactPath: "dist/sidecar/index.js", buildStartedAtMs, files, nativeOrigins: null });
    for (const definition of closureDefinitions(sourceRoots)) {
      for (const relative of definition.files) await copyFile({ source: path.join(definition.source, relative), destination: path.join(destinationRoot, "node_modules", definition.destination, relative), artifactPath: `node_modules/${definition.destination}/${relative}`, buildStartedAtMs, files, nativeOrigins });
      for (const relative of definition.directories) await copyRuntimeJavaScriptTree({ source: path.join(definition.source, relative), destination: path.join(destinationRoot, "node_modules", definition.destination, relative), artifactPrefix: `node_modules/${definition.destination}/${relative}`, buildStartedAtMs, files, nativeOrigins });
    }
    const helper = path.join(destinationRoot, "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper");
    await chmod(helper, 0o755).catch((error) => stagingFail("DAEMON_CLOSURE_HELPER_INVALID", error.message));
    const helperStat = await lstat(helper).catch((error) => stagingFail("DAEMON_CLOSURE_HELPER_INVALID", error.message));
    stagingAssert(helperStat.isFile() && !helperStat.isSymbolicLink() && helperStat.nlink === 1 && (helperStat.mode & 0o777) === 0o755, "DAEMON_CLOSURE_HELPER_INVALID", "node-pty spawn-helper must be mode 0755");
    await assertClosureTree(destinationRoot);
    return {
      root: destinationRoot,
      bundleSha256: files.find((entry) => entry.path === "dist/sidecar/index.js").sha256,
      metafileSha256: metafile.sha256,
      metafileInputCount: metafile.inputCount,
      metafileOutput: "dist/sidecar/index.js",
      externalAllowlist: [...DAEMON_EXTERNAL_ALLOWLIST],
      files: files.sort(comparePath),
      nativeOrigins: nativeOrigins.sort(comparePath),
      symlinksMaterialized: 0,
      hardlinksMaterialized: 0,
      virtualStorePackagesHoisted: 0,
    };
  } catch (error) {
    await rm(destinationRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function validateDaemonMetafile({ metafilePath, checkoutRoot, bundlePath, workingDirectory = checkoutRoot } = {}) {
  stagingAssert(path.isAbsolute(metafilePath ?? "") && path.isAbsolute(checkoutRoot ?? "") && path.isAbsolute(bundlePath ?? ""), "DAEMON_METAFILE_INVALID", "metafile, checkout and bundle paths must be absolute");
  const [checkoutReal, bundleReal, workingReal] = await Promise.all([
    realpath(checkoutRoot).catch((error) => stagingFail("DAEMON_METAFILE_INVALID", error.message)),
    realpath(bundlePath).catch((error) => stagingFail("DAEMON_METAFILE_INVALID", error.message)),
    realpath(workingDirectory).catch((error) => stagingFail("DAEMON_METAFILE_INVALID", error.message)),
  ]);
  assertContained(checkoutReal, workingReal, "metafile working directory");
  const bytes = await readRegularFile(metafilePath, "DAEMON_METAFILE_INVALID");
  let metafile;
  try {
    metafile = JSON.parse(bytes);
  } catch (error) {
    stagingFail("DAEMON_METAFILE_INVALID", `metafile is not JSON: ${error.message}`);
  }
  stagingAssert(isPlainObject(metafile) && isPlainObject(metafile.inputs) && Object.keys(metafile.inputs).length > 0 && isPlainObject(metafile.outputs), "DAEMON_METAFILE_INVALID", "metafile inputs and outputs are required");
  const outputPaths = Object.keys(metafile.outputs);
  stagingAssert(outputPaths.length === 1 && path.resolve(workingReal, outputPaths[0]) === bundleReal, "DAEMON_METAFILE_OUTPUT_INVALID", "metafile must contain exactly the expected daemon bundle output");
  for (const inputPath of Object.keys(metafile.inputs)) {
    stagingAssert(typeof inputPath === "string" && inputPath.length > 0 && !path.isAbsolute(inputPath), "DAEMON_METAFILE_INPUT_ESCAPE", `metafile input path is invalid: ${inputPath}`);
    const candidate = path.resolve(workingReal, inputPath);
    assertContained(checkoutReal, candidate, inputPath);
    const resolved = await realpath(candidate).catch((error) => stagingFail("DAEMON_METAFILE_INPUT_MISSING", `${inputPath}: ${error.message}`));
    assertContained(checkoutReal, resolved, inputPath);
    await readRegularFile(resolved, "DAEMON_METAFILE_INPUT_INVALID");
  }
  const externals = new Set();
  for (const output of Object.values(metafile.outputs)) {
    stagingAssert(isPlainObject(output) && Array.isArray(output.imports), "DAEMON_METAFILE_INVALID", "metafile output imports are required");
    for (const entry of output.imports) if (entry?.external === true) {
      stagingAssert(typeof entry.path === "string" && entry.path.length > 0, "DAEMON_METAFILE_INVALID", "external import path is invalid");
      externals.add(entry.path);
    }
  }
  const packages = [...externals].filter((specifier) => !isNodeBuiltin(specifier)).sort();
  stagingAssert(JSON.stringify(packages) === JSON.stringify([...DAEMON_EXTERNAL_ALLOWLIST].sort()), "DAEMON_EXTERNAL_UNEXPECTED", `daemon bundle externals must be exactly ${DAEMON_EXTERNAL_ALLOWLIST.join(", ")}; got ${packages.join(", ") || "none"}`);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), inputCount: Object.keys(metafile.inputs).length, externalImports: [...externals].sort() };
}

async function resolvePackageRoots({ checkoutRoot, packageRoots }) {
  const daemonModules = path.join(checkoutRoot, "apps/daemon/node_modules");
  const direct = async (name, source = path.join(daemonModules, name)) => await resolvePackageRoot({ checkoutRoot, name, source });
  if (packageRoots !== undefined) {
    stagingAssert(isPlainObject(packageRoots), "DAEMON_CLOSURE_ROOT_INVALID", "package roots must be an object");
    const resolved = {};
    for (const name of Object.keys(EXPECTED_PACKAGES)) resolved[name] = await resolvePackageRoot({ checkoutRoot, name, source: packageRoots[name] });
    resolved.daemon = await resolveDaemonPackageRoot({ checkoutRoot, source: packageRoots.daemon });
    return resolved;
  }
  const better = await direct("better-sqlite3");
  const virtualStore = path.join(checkoutRoot, "node_modules/.pnpm");
  const bindings = await direct("bindings", path.join(virtualStore, "bindings@1.5.0/node_modules/bindings"));
  return {
    "better-sqlite3": better,
    bindings,
    "file-uri-to-path": await direct("file-uri-to-path", path.join(virtualStore, "file-uri-to-path@1.0.0/node_modules/file-uri-to-path")),
    "node-pty": await direct("node-pty"),
    "blake3-wasm": await direct("blake3-wasm"),
    daemon: await resolveDaemonPackageRoot({ checkoutRoot, source: path.join(checkoutRoot, "apps/daemon") }),
  };
}

async function resolveDaemonPackageRoot({ checkoutRoot, source }) {
  const resolved = await realpath(source).catch((error) => stagingFail("DAEMON_CLOSURE_PACKAGE_MISSING", `@open-design/daemon: ${error.message}`));
  assertContained(checkoutRoot, resolved, "@open-design/daemon");
  const stat = await lstat(resolved).catch((error) => stagingFail("DAEMON_CLOSURE_PACKAGE_MISSING", `@open-design/daemon: ${error.message}`));
  stagingAssert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === currentUid(), "DAEMON_CLOSURE_PACKAGE_INVALID", "@open-design/daemon must resolve to an owner-built real directory");
  const manifest = JSON.parse(await readRegularFile(path.join(resolved, "package.json"), "DAEMON_CLOSURE_PACKAGE_INVALID"));
  stagingAssert(manifest?.name === DAEMON_PACKAGE.name && manifest.version === DAEMON_PACKAGE.version, "DAEMON_CLOSURE_PACKAGE_INVALID", "@open-design/daemon does not match the pinned runtime package");
  return resolved;
}

async function resolvePackageRoot({ checkoutRoot, name, source }) {
  stagingAssert(path.isAbsolute(source ?? ""), "DAEMON_CLOSURE_ROOT_INVALID", `package source is invalid: ${name}`);
  const resolved = await realpath(source).catch((error) => stagingFail("DAEMON_CLOSURE_PACKAGE_MISSING", `${name}: ${error.message}`));
  assertContained(checkoutRoot, resolved, name);
  const stat = await lstat(resolved).catch((error) => stagingFail("DAEMON_CLOSURE_PACKAGE_MISSING", `${name}: ${error.message}`));
  stagingAssert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === currentUid(), "DAEMON_CLOSURE_PACKAGE_INVALID", `${name} must resolve to an owner-built real directory`);
  const manifest = JSON.parse(await readRegularFile(path.join(resolved, "package.json"), "DAEMON_CLOSURE_PACKAGE_INVALID"));
  stagingAssert(manifest?.name === name && manifest.version === EXPECTED_PACKAGES[name], "DAEMON_CLOSURE_PACKAGE_INVALID", `${name} does not match the pinned runtime package`);
  return resolved;
}

function closureDefinitions(roots) {
  return [
    // The bundled server resolves this manifest to locate its own CLI. It is app-owned
    // metadata, not an esbuild external or a third-party package closure.
    { source: roots.daemon, destination: "@open-design/daemon", files: ["package.json"], directories: [] },
    { source: roots["better-sqlite3"], destination: "better-sqlite3", files: ["package.json", "build/Release/better_sqlite3.node"], directories: ["lib"] },
    { source: roots.bindings, destination: "bindings", files: ["package.json", "bindings.js"], directories: [] },
    { source: roots["file-uri-to-path"], destination: "file-uri-to-path", files: ["package.json", "index.js"], directories: [] },
    { source: roots["node-pty"], destination: "node-pty", files: ["package.json", "lib/eventEmitter2.js", "lib/index.js", "lib/interfaces.js", "lib/terminal.js", "lib/types.js", "lib/unixTerminal.js", "lib/utils.js", "prebuilds/darwin-arm64/pty.node", "prebuilds/darwin-arm64/spawn-helper"], directories: [] },
    { source: roots["blake3-wasm"], destination: "blake3-wasm", files: ["package.json", "dist/index.js", "dist/base/disposable.js", "dist/base/hash-fn.js", "dist/base/hash-instance.js", "dist/base/hash-reader.js", "dist/base/index.js", "dist/node/hash-fn.js", "dist/node/hash-instance.js", "dist/node/hash-reader.js", "dist/node/index.js", "dist/node/wasm.js", "dist/wasm/nodejs/blake3_js.js", "dist/wasm/nodejs/blake3_js_bg.wasm", "dist/wasm/nodejs/package.json"], directories: [] },
  ];
}

async function copyRuntimeJavaScriptTree({ source, destination, artifactPrefix, buildStartedAtMs, files, nativeOrigins }) {
  const stat = await lstat(source).catch((error) => stagingFail("DAEMON_CLOSURE_REQUIRED_FILE_MISSING", error.message));
  stagingAssert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === currentUid(), "DAEMON_CLOSURE_SYMLINK_FORBIDDEN", `runtime directory is invalid: ${artifactPrefix}`);
  const directory = await opendir(source).catch((error) => stagingFail("DAEMON_CLOSURE_FILESYSTEM_ERROR", error.message));
  const names = [];
  for await (const entry of directory) names.push(entry.name);
  for (const name of names.sort()) {
    const childSource = path.join(source, name);
    const childArtifact = `${artifactPrefix}/${name}`;
    const child = await lstat(childSource).catch((error) => stagingFail("DAEMON_CLOSURE_FILESYSTEM_ERROR", error.message));
    stagingAssert(!child.isSymbolicLink(), "DAEMON_CLOSURE_SYMLINK_FORBIDDEN", `symlink is forbidden: ${childArtifact}`);
    if (child.isDirectory()) {
      await copyRuntimeJavaScriptTree({ source: childSource, destination: path.join(destination, name), artifactPrefix: childArtifact, buildStartedAtMs, files, nativeOrigins });
    } else if (child.isFile()) {
      if (!name.endsWith(".js") || name.endsWith(".test.js")) continue;
      await copyFile({ source: childSource, destination: path.join(destination, name), artifactPath: childArtifact, buildStartedAtMs, files, nativeOrigins });
    } else {
      stagingFail("DAEMON_CLOSURE_SPECIAL_FILE_FORBIDDEN", `special file is forbidden: ${childArtifact}`);
    }
  }
}

async function copyFile({ source, destination, artifactPath, buildStartedAtMs, files, nativeOrigins }) {
  const bytes = await readRegularFile(source, "DAEMON_CLOSURE_REQUIRED_FILE_MISSING");
  const stat = await lstat(source).catch((error) => stagingFail("DAEMON_CLOSURE_FILE_INVALID", error.message));
  stagingAssert(stat.ctimeMs >= buildStartedAtMs || !isRuntimeBinary(artifactPath), "NATIVE_OUTPUT_STALE", `runtime binary source predates this build: ${artifactPath}`);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 }).catch((error) => stagingFail("DAEMON_CLOSURE_DESTINATION_INVALID", error.message));
  const handle = await open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600).catch((error) => stagingFail("DAEMON_CLOSURE_DESTINATION_INVALID", error.message));
  try {
    await handle.writeFile(bytes);
    const written = await handle.stat();
    stagingAssert(written.isFile() && written.nlink === 1 && written.size === bytes.length, "DAEMON_CLOSURE_DESTINATION_INVALID", `closure output is invalid: ${artifactPath}`);
  } finally {
    await handle.close().catch(() => undefined);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  files.push({ path: artifactPath, sha256 });
  if (nativeOrigins && isRuntimeBinary(artifactPath)) nativeOrigins.push({ path: artifactPath, sha256, sourceCtime: new Date(stat.ctimeMs).toISOString(), mode: fileMode(artifactPath) });
}

async function readRegularFile(filename, code) {
  const stat = await lstat(filename).catch((error) => stagingFail(code, error.message));
  stagingAssert(stat.isFile() && !stat.isSymbolicLink(), code === "DAEMON_METAFILE_INVALID" ? "DAEMON_METAFILE_INVALID" : "DAEMON_CLOSURE_SYMLINK_FORBIDDEN", `regular file is required: ${filename}`);
  stagingAssert(stat.nlink === 1, "DAEMON_CLOSURE_HARD_LINK_FORBIDDEN", `hard-linked file is forbidden: ${filename}`);
  stagingAssert(stat.uid === currentUid(), "DAEMON_CLOSURE_FILE_INVALID", `source file is not owned by the current user: ${filename}`);
  const handle = await open(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)).catch((error) => stagingFail(code, error.message));
  try {
    const before = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    stagingAssert(sameIdentity(before, after), "DAEMON_CLOSURE_SOURCE_CHANGED", `source changed while reading: ${filename}`);
    return bytes;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function assertClosureTree(root) {
  const directory = await opendir(root).catch((error) => stagingFail("DAEMON_CLOSURE_FILESYSTEM_ERROR", error.message));
  for await (const entry of directory) {
    const filename = path.join(root, entry.name);
    const stat = await lstat(filename).catch((error) => stagingFail("DAEMON_CLOSURE_FILESYSTEM_ERROR", error.message));
    stagingAssert(!stat.isSymbolicLink(), "DAEMON_CLOSURE_SYMLINK_FORBIDDEN", `closure contains a symlink: ${filename}`);
    if (stat.isDirectory()) await assertClosureTree(filename);
    else {
      stagingAssert(stat.isFile(), "DAEMON_CLOSURE_SPECIAL_FILE_FORBIDDEN", `closure contains a special file: ${filename}`);
      stagingAssert(stat.nlink === 1, "DAEMON_CLOSURE_HARD_LINK_FORBIDDEN", `closure contains a hard link: ${filename}`);
    }
  }
}

function assertContained(root, candidate, label) {
  const relative = path.relative(root, candidate);
  stagingAssert(relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)), "DAEMON_CLOSURE_ESCAPE", `package path escapes checkout: ${label}`);
}

function isNodeBuiltin(specifier) {
  return BUILTIN_MODULES.has(specifier);
}

function isRuntimeBinary(artifactPath) {
  return artifactPath.endsWith(".node") || artifactPath.endsWith(".wasm") || artifactPath.endsWith("/node-pty/prebuilds/darwin-arm64/spawn-helper");
}

function fileMode(artifactPath) {
  return artifactPath.endsWith("/spawn-helper") ? "0755" : "0644";
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function comparePath(left, right) {
  return Buffer.compare(Buffer.from(left.path), Buffer.from(right.path));
}

function currentUid() {
  stagingAssert(typeof process.getuid === "function", "OWNER_CHECK_UNSUPPORTED", "current platform cannot verify filesystem ownership");
  return process.getuid();
}
