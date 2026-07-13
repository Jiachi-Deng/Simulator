import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertNativeBuildsAllowed, inspectNativeRuntime, parseNativeHeader } from "../src/native-inventory.mjs";

const target = { platform: "darwin", arch: "arm64", nodeAbi: "137", libc: "none" };
const runtime = { platform: "darwin", arch: "arm64", nodeAbi: "137" };
const loaded = { ok: true, nodeVersion: "v24.14.1", nodeAbi: "137", platform: "darwin", arch: "arm64" };

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

test("records target platform, architecture, and Node ABI for required native packages", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "open-design-native-"));
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
  const metadata = Object.fromEntries(files.map((relative) => [relative, { nativeTarget: { format: "node-addon", ...target } }]));
  const copied = await Promise.all(files.map(async (relative) => ({
    path: relative,
    sha256: createHash("sha256").update(await readFile(path.join(root, relative))).digest("hex"),
    sourceCtimeMs: Date.now(),
  })));
  const inventory = await inspectNativeRuntime({ artifactRoot: root, metadata, target, runtime, buildEvidence: { buildStartedAtMs: Date.now() - 1000, copied }, loadAddon: async () => loaded });
  assert.deepEqual(inventory.map((entry) => entry.packageName), ["better-sqlite3", "node-pty", "sharp"]);
  assert.ok(inventory.every((entry) => entry.platform === "darwin" && entry.arch === "arm64" && entry.nodeAbi === "137"));
  assert.ok(inventory.every((entry) => entry.freshFromBuild && entry.load?.nodeVersion === "v24.14.1"));
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
