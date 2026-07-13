import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, opendir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAtomicStagingTarget, sealAndPublish, writeExclusiveCanonicalJson } from "../src/atomic-publisher.mjs";
import { canonicalJson, digestInventory } from "../src/validate-artifact.mjs";

async function parentFixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "open-design-publish-"));
  await chmod(parent, 0o700);
  t.after(async () => {
    await chmod(parent, 0o700).catch(() => undefined);
    const final = path.join(parent, "artifact");
    await makeWritable(final).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  });
  return parent;
}

async function makeWritable(filename) {
  const fileStat = await lstat(filename);
  if (!fileStat.isDirectory()) {
    await chmod(filename, 0o600);
    return;
  }
  await chmod(filename, 0o700);
  const directory = await opendir(filename);
  for await (const entry of directory) await makeWritable(path.join(filename, entry.name));
}

async function stagedInventory(root) {
  const payload = Buffer.from("runtime\n");
  await mkdir(path.join(root, "runtime"));
  await writeFile(path.join(root, "runtime/server.js"), payload, { mode: 0o755 });
  const inventory = {
    schemaVersion: 1,
    source: { ref: "tag", commit: "a".repeat(40) },
    target: { platform: "darwin", arch: "arm64", nodeAbi: "137", libc: "none" },
    files: [
      { path: "artifact-manifest.json", bytes: 0, sha256: "0".repeat(64) },
      { path: "runtime/server.js", bytes: payload.length, sha256: createHash("sha256").update(payload).digest("hex") },
    ],
  };
  const manifest = inventory.files[0];
  for (let previous = -1; manifest.bytes !== previous;) {
    previous = manifest.bytes;
    manifest.bytes = Buffer.byteLength(`${canonicalJson(inventory)}\n`);
  }
  manifest.sha256 = digestInventory(inventory);
  await writeFile(path.join(root, "artifact-manifest.json"), `${canonicalJson(inventory)}\n`);
  return inventory;
}

test("seals a verified unique temp tree and atomically publishes without replacement", async (t) => {
  const parent = await parentFixture(t);
  const finalRoot = path.join(parent, "artifact");
  const target = await createAtomicStagingTarget(finalRoot);
  const inventory = await stagedInventory(target.tempRoot);
  const result = await sealAndPublish({ target, inventory });
  assert.deepEqual(result, { root: finalRoot, atomic: true, sealed: true, durability: "fsync-complete" });
  assert.equal((await stat(finalRoot)).mode & 0o222, 0);
  assert.equal((await stat(path.join(finalRoot, "runtime/server.js"))).mode & 0o222, 0);
  assert.equal(await readFile(path.join(finalRoot, "runtime/server.js"), "utf8"), "runtime\n");
  await assert.rejects(createAtomicStagingTarget(finalRoot), { code: "PUBLISH_TARGET_EXISTS" });
});

test("fails before publish when final bytes differ from inventory", async (t) => {
  const parent = await parentFixture(t);
  const finalRoot = path.join(parent, "artifact");
  const target = await createAtomicStagingTarget(finalRoot);
  t.after(() => target.cleanup().catch(() => undefined));
  const inventory = await stagedInventory(target.tempRoot);
  await writeFile(path.join(target.tempRoot, "runtime/server.js"), "tampered\n");
  await assert.rejects(sealAndPublish({ target, inventory }), { code: "PUBLISH_INVENTORY_MISMATCH" });
  await assert.rejects(lstat(finalRoot), { code: "ENOENT" });
});

test("rejects a group-readable publish parent and uses exclusive canonical JSON writes", async (t) => {
  const parent = await parentFixture(t);
  await chmod(parent, 0o755);
  await assert.rejects(createAtomicStagingTarget(path.join(parent, "artifact")), { code: "PUBLISH_PARENT_INVALID" });
  await chmod(parent, 0o700);
  const output = path.join(parent, "attestation.json");
  await writeExclusiveCanonicalJson(output, { z: 1, a: 2 });
  assert.equal(await readFile(output, "utf8"), '{"a":2,"z":1}\n');
  await assert.rejects(writeExclusiveCanonicalJson(output, { a: 2 }), { code: "ATTESTATION_WRITE_FAILED" });
});
