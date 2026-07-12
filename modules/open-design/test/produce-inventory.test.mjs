import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { canonicalJson, loadRuntimeSchemas } from "../src/validate-artifact.mjs";
import { InventoryProductionError, produceInventory } from "../src/produce-inventory.mjs";
import { readFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);
const moduleRoot = new URL("../", import.meta.url);
const load = async (name) => JSON.parse(await readFile(new URL(name, moduleRoot), "utf8"));
const base = {
  provenance: await load("provenance.json"),
  policy: await load("artifact-policy.json"),
  decisions: await load("resource-decisions.json"),
  schemas: await loadRuntimeSchemas(),
  target: { platform: "darwin", arch: "arm64", nodeAbi: "137", libc: "none" }
};

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "open-design-inventory-"));
  await Promise.all([
    mkdir(path.join(root, "web/standalone"), { recursive: true }),
    mkdir(path.join(root, "runtime/daemon/dist"), { recursive: true }),
    mkdir(path.join(root, "legal"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(path.join(root, "web/standalone/server.js"), "server\n"),
    writeFile(path.join(root, "runtime/daemon/dist/cli.js"), "daemon\n"),
    writeFile(path.join(root, "legal/LICENSE"), "Apache License\n"),
    writeFile(path.join(root, "legal/SBOM.spdx.json"), "{}\n"),
    writeFile(path.join(root, "provenance.json"), canonicalJson(base.provenance))
  ]);
  return root;
}

async function run(root, overrides = {}) {
  return produceInventory({ ...structuredClone(base), stagingRoot: root, metadata: {}, ...overrides });
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => error instanceof InventoryProductionError && error.code === code, `expected ${code}`);
}

test("produces byte-identical canonical JSON and validates it", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await run(root);
  const second = await run(root);
  assert.equal(first.json, second.json);
  assert.deepEqual(first.inventory.files.map((file) => file.path), [...first.inventory.files.map((file) => file.path)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
});

test("rejects a staged file occupying the generated manifest path", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "artifact-manifest.json"), "stale\n");
  await rejectsCode(run(root), "OUTPUT_PATH_OCCUPIED");
});

test("rejects leaf and intermediate directory symlinks", async (t) => {
  const leafRoot = await fixture();
  const directoryRoot = await fixture();
  t.after(() => Promise.all([rm(leafRoot, { recursive: true, force: true }), rm(directoryRoot, { recursive: true, force: true })]));
  await symlink("server.js", path.join(leafRoot, "web/standalone/alias.js"));
  await rejectsCode(run(leafRoot), "SYMLINK_FORBIDDEN");
  await symlink("standalone", path.join(directoryRoot, "web/linked"));
  await rejectsCode(run(directoryRoot), "SYMLINK_FORBIDDEN");
});

test("rejects hard-link aliases", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await link(path.join(root, "web/standalone/server.js"), path.join(root, "web/standalone/server-copy.js"));
  await rejectsCode(run(root), "HARD_LINK_ALIAS");
});

test("rejects fifo and other non-regular leaves", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("mkfifo", [path.join(root, "runtime/daemon/dist/input")]);
  await rejectsCode(run(root), "SPECIAL_FILE_FORBIDDEN");
});

test("rejects Electron, updater and cache extras through existing policy", async (t) => {
  for (const relative of ["runtime/packages/electron/main.js", "runtime/packages/updater/update.js", "runtime/packages/cache/data.bin"]) {
    const root = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), "extra\n");
    await rejectsCode(run(root), "ARTIFACT_INVALID");
  }
});

test("detects replacement and modification during collection", async (t) => {
  const replaceRoot = await fixture();
  const modifyRoot = await fixture();
  t.after(() => Promise.all([rm(replaceRoot, { recursive: true, force: true }), rm(modifyRoot, { recursive: true, force: true })]));
  let replaced = false;
  await rejectsCode(run(replaceRoot, { hook: async ({ phase, path: artifactPath }) => {
    if (!replaced && phase === "afterOpen" && artifactPath === "web/standalone/server.js") {
      replaced = true;
      const original = path.join(replaceRoot, artifactPath);
      await rename(original, `${original}.old`);
      await writeFile(original, "replacement\n");
    }
  } }), "FILE_CHANGED");
  let modified = false;
  await rejectsCode(run(modifyRoot, { hook: async ({ phase, path: artifactPath }) => {
    if (!modified && phase === "afterRead" && artifactPath === "web/standalone/server.js") {
      modified = true;
      await writeFile(path.join(modifyRoot, artifactPath), "modified in place with a different size\n");
    }
  } }), "FILE_CHANGED");
});

test("detects an intermediate component replaced during collection", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  let replaced = false;
  await rejectsCode(run(root, { hook: async ({ phase, path: artifactPath }) => {
    if (!replaced && phase === "afterOpen" && artifactPath === "web/standalone/server.js") {
      replaced = true;
      const directory = path.join(root, "web/standalone");
      await rename(directory, `${directory}.old`);
      await symlink("standalone.old", directory);
    }
  } }), "SYMLINK_FORBIDDEN");
});

test("requires exact resource metadata and rejects unknown metadata", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "web/public"), { recursive: true });
  await writeFile(path.join(root, "web/public/logo.png"), "png\n");
  await rejectsCode(run(root), "METADATA_MISSING");
  await rejectsCode(run(root, { metadata: { "web/public/missing.png": { resourceCategory: "images", sourcePath: "assets/missing.png", decisionId: "missing" } } }), "UNEXPECTED_METADATA");
  await rejectsCode(run(root, { metadata: { "web/public/logo.png": { resourceCategory: "images", sourcePath: "assets/logo.png", decisionId: "logo", unknown: true } } }), "METADATA_INVALID");
});

test("rejects oversized files before hashing", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const policy = structuredClone(base.policy);
  policy.limits.maxFileBytes = 4;
  await rejectsCode(run(root, { policy }), "FILE_LIMIT_EXCEEDED");
});

test("rejects NFKC full-case-fold collisions and path byte limits", async (t) => {
  const collisionRoot = await fixture();
  const limitRoot = await fixture();
  t.after(() => Promise.all([rm(collisionRoot, { recursive: true, force: true }), rm(limitRoot, { recursive: true, force: true })]));
  await Promise.all([
    writeFile(path.join(collisionRoot, "web/standalone/\u2460.js"), "a"),
    writeFile(path.join(collisionRoot, "web/standalone/1.js"), "b")
  ]);
  await rejectsCode(run(collisionRoot), "PATH_COLLISION");
  const policy = structuredClone(base.policy);
  policy.limits.maxPathBytes = 10;
  await rejectsCode(run(limitRoot, { policy }), "PATH_LIMIT_EXCEEDED");
});
