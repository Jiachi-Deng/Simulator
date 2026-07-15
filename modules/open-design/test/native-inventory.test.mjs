import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertNativeBuildsAllowed, inspectNativeRuntime, parseNativeHeader } from "../src/native-inventory.mjs";

const target = { platform: "darwin", arch: "arm64", nodeAbi: "137", libc: "none" };
const runtime = { platform: "darwin", arch: "arm64", nodeAbi: "137" };
const loaded = { ok: true, nodeVersion: "v24.18.0", nodeAbi: "137", platform: "darwin", arch: "arm64" };
const pendingMetadata = JSON.parse(await readFile(new URL("../fixtures/pinned-native-metadata.pending-review.darwin-arm64.json", import.meta.url), "utf8"));
const resourceDecisions = JSON.parse(await readFile(new URL("../resource-decisions.json", import.meta.url), "utf8"));

function arm64MachO() {
  const buffer = Buffer.alloc(32);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeInt32LE(0x0100000c, 4);
  return buffer;
}

test("requires node-pty to be explicitly allowed to build", () => {
  assert.throws(
    () => assertNativeBuildsAllowed({ pnpm: { onlyBuiltDependencies: ["better-sqlite3", "sharp"] } }),
    { code: "NATIVE_BUILD_IGNORED" },
  );
  assert.doesNotThrow(() => assertNativeBuildsAllowed({ pnpm: { onlyBuiltDependencies: ["better-sqlite3", "node-pty", "sharp"] } }));
});

test("pins every target-native path and excludes the complete sharp optimizer closure", () => {
  assert.equal(Object.keys(pendingMetadata).length, 13);
  const decisionById = new Map(resourceDecisions.decisions.map((decision) => [decision.id, decision]));
  for (const [artifactPath, metadata] of Object.entries(pendingMetadata)) {
    assert.match(artifactPath, /(?:better_sqlite3|pty|spawn-helper|sharp-darwin-arm64|libvips-cpp|blake3_js_bg)/u);
    assert.equal(metadata.resourceCategory, "native-binaries");
    assert.deepEqual({ platform: metadata.nativeTarget.platform, arch: metadata.nativeTarget.arch, nodeAbi: metadata.nativeTarget.nodeAbi, libc: metadata.nativeTarget.libc }, target);
    const decision = decisionById.get(metadata.decisionId);
    assert.equal(decision.sourcePath, metadata.sourcePath);
    if (metadata.sourcePath.startsWith("@img/sharp-")) {
      assert.equal(decision.status, "exclude");
      assert.equal(decision.rightsStatus, "not-applicable");
      assert.match(decision.reason, /staging gate removes/u);
    } else {
      assert.equal(decision.status, "include");
      assert.equal(decision.rightsStatus, "cleared");
      assert.ok(decision.license);
      assert.ok(decision.rightsEvidence);
    }
  }
});

test("records target platform, architecture, and Node ABI for required native packages", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "open-design-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [
    { path: "runtime/daemon/node_modules/better-sqlite3/build/Release/better_sqlite3.node", format: "node-addon", bytes: arm64MachO(), mode: 0o644 },
    { path: "runtime/daemon/node_modules/blake3-wasm/dist/wasm/nodejs/blake3_js_bg.wasm", format: "wasm-module", bytes: Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), mode: 0o644 },
    { path: "runtime/daemon/node_modules/node-pty/prebuilds/darwin-arm64/pty.node", format: "node-addon", bytes: arm64MachO(), mode: 0o644 },
    { path: "runtime/daemon/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper", format: "executable", bytes: arm64MachO(), mode: 0o755 },
    { path: "runtime/packages/web-sidecar/node_modules/@img/sharp-darwin-arm64/lib/sharp.node", format: "node-addon", bytes: arm64MachO(), mode: 0o644 },
  ];
  await Promise.all(files.map(async (file) => {
    await mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
    await writeFile(path.join(root, file.path), file.bytes);
    await chmod(path.join(root, file.path), file.mode);
  }));
  const metadata = Object.fromEntries(files.map((file) => [file.path, { nativeTarget: { format: file.format, ...target } }]));
  const copied = await Promise.all(files.map(async (file) => ({
    path: file.path,
    sha256: createHash("sha256").update(await readFile(path.join(root, file.path))).digest("hex"),
    mode: file.mode.toString(8).padStart(4, "0"),
    sourceCtimeMs: Date.now(),
  })));
  const inventory = await inspectNativeRuntime({ artifactRoot: root, metadata, target, runtime, buildEvidence: { buildStartedAtMs: Date.now() - 1000, copied }, loadAddon: async () => loaded });
  assert.deepEqual(inventory.map((entry) => entry.resourceClass), ["native-binary", "wasm-resource", "native-binary", "executable-native", "native-binary"]);
  assert.ok(inventory.every((entry) => entry.platform === "darwin" && entry.arch === "arm64" && entry.nodeAbi === "137"));
  assert.ok(inventory.every((entry) => entry.freshFromBuild));
  assert.ok(inventory.filter((entry) => entry.format === "node-addon").every((entry) => entry.load?.nodeVersion === "v24.18.0"));
  assert.equal(inventory.find((entry) => entry.resourceClass === "executable-native").mode, "0755");
});

test("reports every missing exact native metadata key in one fail-closed preflight", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "open-design-native-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [
    "runtime/daemon/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    "runtime/daemon/node_modules/node-pty/build/Release/pty.node",
    "runtime/packages/web-sidecar/node_modules/@img/sharp-darwin-arm64/lib/sharp.node",
  ];
  await Promise.all(files.map(async (relative) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), arm64MachO());
  }));
  await assert.rejects(
    inspectNativeRuntime({ artifactRoot: root, metadata: {}, target, runtime, buildEvidence: { buildStartedAtMs: Date.now() - 1000, copied: [] }, loadAddon: async () => loaded }),
    (error) => error.code === "NATIVE_METADATA_MISSING" && files.every((relative) => error.message.includes(relative)),
  );
});

test("rejects hard-linked native output and recognizes Mach-O architecture", async (t) => {
  const header = parseNativeHeader(arm64MachO(), "fixture.node");
  assert.deepEqual(header, { format: "mach-o", platform: "darwin", arch: "arm64" });
  const root = await mkdtemp(path.join(os.tmpdir(), "open-design-native-hardlink-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source.node");
  await writeFile(source, arm64MachO());
  await link(source, path.join(root, "alias.node"));
  await assert.rejects(
    inspectNativeRuntime({ artifactRoot: root, metadata: {}, target, runtime, buildEvidence: { buildStartedAtMs: Date.now() - 1000, copied: [] }, loadAddon: async () => loaded }),
    { code: "NATIVE_HARD_LINK_FORBIDDEN" },
  );
});
