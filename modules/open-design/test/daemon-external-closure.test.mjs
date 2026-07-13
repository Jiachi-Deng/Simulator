import assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildDaemonExternalClosure, DAEMON_EXTERNAL_ALLOWLIST, validateDaemonMetafile } from "../src/daemon-external-closure.mjs";

const target = { platform: "darwin", arch: "arm64" };

async function fixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "open-design-daemon-closure-"));
  const checkout = path.join(parent, "checkout");
  const output = path.join(parent, "closure");
  const bundle = path.join(checkout, "daemon-bundle/dist/sidecar/index.js");
  const metafile = path.join(checkout, "daemon-bundle/esbuild-meta.json");
  const roots = Object.fromEntries(["better-sqlite3", "bindings", "file-uri-to-path", "node-pty", "blake3-wasm", "daemon"].map((name) => [name, path.join(checkout, "packages", name)]));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await Promise.all(Object.entries(roots).map(async ([name, root]) => {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: name === "daemon" ? "@open-design/daemon" : name, version: { "better-sqlite3": "12.10.0", bindings: "1.5.0", "file-uri-to-path": "1.0.0", "node-pty": "1.1.0", "blake3-wasm": "2.1.5", daemon: "0.14.1" }[name] }));
  }));
  const buildStartedAtMs = Date.now() - 1_000;
  await writeFiles(checkout, {
    "daemon-bundle/dist/sidecar/index.js": "import 'better-sqlite3';\n",
    "daemon-bundle/esbuild-meta.json": JSON.stringify(metafileFor(DAEMON_EXTERNAL_ALLOWLIST)),
    "packages/better-sqlite3/lib/index.js": "module.exports = {};\n",
    "packages/better-sqlite3/build/Release/better_sqlite3.node": "better-native",
    "packages/bindings/bindings.js": "module.exports = () => {};\n",
    "packages/file-uri-to-path/index.js": "module.exports = () => '';\n",
    "packages/node-pty/lib/index.js": "module.exports = {};\n",
    "packages/node-pty/lib/index.js.map": "must-not-copy",
    "packages/node-pty/prebuilds/darwin-arm64/pty.node": "pty-native",
    "packages/node-pty/prebuilds/darwin-arm64/spawn-helper": "helper",
    "packages/blake3-wasm/dist/index.js": "module.exports = require('./node');\n",
    "packages/blake3-wasm/dist/base/index.js": "module.exports = {};\n",
    "packages/blake3-wasm/dist/node/index.js": "module.exports = {};\n",
    "packages/blake3-wasm/dist/wasm/nodejs/blake3_js.js": "module.exports = {};\n",
    "packages/blake3-wasm/dist/wasm/nodejs/blake3_js_bg.wasm": "wasm",
    "packages/blake3-wasm/dist/wasm/nodejs/package.json": "{}\n",
    "packages/htmlparser2/index.js": "must-not-copy",
    "packages/entities/index.js": "must-not-copy",
  });
  return { checkout, output, bundle, metafile, roots, buildStartedAtMs };
}

test("creates a fixed ordinary-file daemon external closure with native and WASM runtime evidence", async (t) => {
  const input = await fixture(t);
  const result = await buildDaemonExternalClosure({ checkoutRoot: input.checkout, bundlePath: input.bundle, metafilePath: input.metafile, destinationRoot: input.output, buildStartedAtMs: input.buildStartedAtMs, target, packageRoots: input.roots });
  assert.deepEqual(result.externalAllowlist, DAEMON_EXTERNAL_ALLOWLIST);
  assert.equal(result.files.some((entry) => entry.path.includes("htmlparser2") || entry.path.includes("entities")), false);
  assert.equal(result.files.some((entry) => entry.path === "node_modules/@open-design/daemon/package.json"), true);
  assert.equal(result.files.some((entry) => entry.path.endsWith(".map")), false);
  assert.deepEqual(result.nativeOrigins.map((entry) => entry.path), ["node_modules/better-sqlite3/build/Release/better_sqlite3.node", "node_modules/node-pty/prebuilds/darwin-arm64/pty.node"]);
  assert.equal((await lstat(path.join(input.output, "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"))).mode & 0o777, 0o755);
  assert.equal(await readFile(path.join(input.output, "node_modules/blake3-wasm/dist/wasm/nodejs/blake3_js_bg.wasm"), "utf8"), "wasm");
  assert.match(result.metafileSha256, /^[0-9a-f]{64}$/u);
});

test("rejects metafile tampering and unexpected package externals", async (t) => {
  const input = await fixture(t);
  await writeFile(input.metafile, JSON.stringify(metafileFor([...DAEMON_EXTERNAL_ALLOWLIST, "entities"])));
  await assert.rejects(validateDaemonMetafile({ metafilePath: input.metafile }), { code: "DAEMON_EXTERNAL_UNEXPECTED" });
  await writeFile(input.metafile, "not-json");
  await assert.rejects(validateDaemonMetafile({ metafilePath: input.metafile }), { code: "DAEMON_METAFILE_INVALID" });
  await writeFile(input.metafile, JSON.stringify(metafileFor([...DAEMON_EXTERNAL_ALLOWLIST, "node:not-a-builtin"])));
  await assert.rejects(validateDaemonMetafile({ metafilePath: input.metafile }), { code: "DAEMON_EXTERNAL_UNEXPECTED" });
});

test("fails closed for missing runtime payloads, links, and unsupported target", async (t) => {
  const missing = await fixture(t);
  await rm(path.join(missing.roots["blake3-wasm"], "dist/wasm/nodejs/blake3_js_bg.wasm"));
  await assert.rejects(build(missing), { code: "DAEMON_CLOSURE_REQUIRED_FILE_MISSING" });

  const linked = await fixture(t);
  const lib = path.join(linked.roots["better-sqlite3"], "lib/index.js");
  await rm(lib);
  await symlink("../package.json", lib);
  await assert.rejects(build(linked), { code: "DAEMON_CLOSURE_SYMLINK_FORBIDDEN" });

  const hardlinked = await fixture(t);
  const file = path.join(hardlinked.roots["node-pty"], "lib/index.js");
  await link(file, path.join(hardlinked.roots["node-pty"], "lib/alias.js"));
  await assert.rejects(build(hardlinked), { code: "DAEMON_CLOSURE_HARD_LINK_FORBIDDEN" });

  const wrongTarget = await fixture(t);
  await assert.rejects(build(wrongTarget, { platform: "linux", arch: "arm64" }), { code: "DAEMON_CLOSURE_TARGET_UNSUPPORTED" });

  const escaped = await fixture(t);
  escaped.roots.bindings = path.join(path.dirname(escaped.checkout), "outside-bindings");
  await mkdir(escaped.roots.bindings);
  await writeFile(path.join(escaped.roots.bindings, "package.json"), JSON.stringify({ name: "bindings", version: "1.5.0" }));
  await assert.rejects(build(escaped), { code: "DAEMON_CLOSURE_ESCAPE" });
});

async function build(input, buildTarget = target) {
  return await buildDaemonExternalClosure({ checkoutRoot: input.checkout, bundlePath: input.bundle, metafilePath: input.metafile, destinationRoot: input.output, buildStartedAtMs: input.buildStartedAtMs, target: buildTarget, packageRoots: input.roots });
}

function metafileFor(externals) {
  return { outputs: { "daemon-bundle/dist/sidecar/index.js": { imports: [...externals.map((specifier) => ({ path: specifier, external: true })), { path: "node:fs", external: true }, { path: "node:sqlite", external: true }] } } };
}

async function writeFiles(root, files) {
  await Promise.all(Object.entries(files).map(async ([relative, content]) => {
    const filename = path.join(root, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, content);
  }));
}
