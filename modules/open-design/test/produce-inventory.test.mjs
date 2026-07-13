import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { canonicalJson, loadRuntimeSchemas } from "../src/validate-artifact.mjs";
import { InventoryProductionError, produceInventory } from "../src/produce-inventory.mjs";
import { readFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);
const moduleRoot = new URL("../", import.meta.url);
const producerPath = fileURLToPath(new URL("../src/produce-inventory.mjs", import.meta.url));
const load = async (name) => JSON.parse(await readFile(new URL(name, moduleRoot), "utf8"));
const base = {
  provenance: await load("provenance.json"),
  policy: await load("artifact-policy.json"),
  decisions: await load("resource-decisions.json"),
  attestation: await load("fixtures/minimal-build-attestation.json"),
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
    writeFile(path.join(root, "provenance.json"), canonicalJson(base.provenance)),
    writeFile(path.join(root, "build-attestation.json"), canonicalJson(base.attestation))
  ]);
  return root;
}

async function run(root, overrides = {}) {
  return produceInventory({ ...structuredClone(base), stagingRoot: root, metadata: {}, ...overrides });
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => error instanceof InventoryProductionError && error.code === code, `expected ${code}`);
}

async function cliFixture(root) {
  const configRoot = await mkdtemp(path.join(os.tmpdir(), "open-design-cli-"));
  const metadata = path.join(configRoot, "metadata.json");
  const target = path.join(configRoot, "target.json");
  await Promise.all([writeFile(metadata, "{}\n"), writeFile(target, `${JSON.stringify(base.target)}\n`)]);
  return {
    configRoot,
    args: ["--staging-root", root, "--metadata", metadata, "--target", target]
  };
}

async function rejectsCli(args, code) {
  await assert.rejects(execFileAsync(process.execPath, [producerPath, ...args]), (error) => error.stderr.includes(`${code}:`));
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

test("rejects additions, deletions, replacements and post-collection modifications", async (t) => {
  for (const mutation of ["add", "delete", "replace", "modify"]) {
    const root = await fixture();
    const replacement = path.join(os.tmpdir(), `open-design-replacement-${process.pid}-${mutation}`);
    t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(replacement, { force: true })]));
    let changed = false;
    await rejectsCode(run(root, { hook: async ({ phase }) => {
      if (changed || phase !== "afterCollection") return;
      changed = true;
      const server = path.join(root, "web/standalone/server.js");
      if (mutation === "add") await writeFile(path.join(root, "web/standalone/new.js"), "new\n");
      if (mutation === "delete") await unlink(server);
      if (mutation === "replace") {
        await writeFile(replacement, "server\n");
        await rename(replacement, server);
      }
      if (mutation === "modify") await writeFile(server, "changed after collection\n");
    } }), "STAGING_CHANGED");
  }
});

test("rejects a collected file changed after the final hash traversal", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  let changed = false;
  await rejectsCode(run(root, { hook: async ({ phase }) => {
    if (!changed && phase === "afterFinalHash") {
      changed = true;
      await writeFile(path.join(root, "web/standalone/server.js"), "changed after final hash\n");
    }
  } }), "STAGING_CHANGED");
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

test("classifies resource paths independently of extension", async (t) => {
  for (const relative of ["web/public/plugins/tool.txt", "web/public/skills/guide.txt", "web/public/templates/base.txt", "web/public/design-systems/tokens.json", "web/public/assets/data.txt"]) {
    const root = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), "resource\n");
    await rejectsCode(run(root), "METADATA_MISSING");
  }
});

test("resource-path metadata still requires an exact approved decision", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactPath = "web/public/assets/data.txt";
  await mkdir(path.dirname(path.join(root, artifactPath)), { recursive: true });
  await writeFile(path.join(root, artifactPath), "resource\n");
  await rejectsCode(run(root, { metadata: { [artifactPath]: { resourceCategory: "images", sourcePath: "assets/data.txt", decisionId: "not-approved" } } }), "ARTIFACT_INVALID");
});

test("enforces a global entry limit while iterating directories", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const policy = structuredClone(base.policy);
  policy.limits.maxEntries = 2;
  await rejectsCode(run(root, { policy }), "ENTRY_LIMIT_EXCEEDED");
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

test("CLI writes manifest JSON only to stdout and rejects every --output path", async (t) => {
  const root = await fixture();
  const { configRoot, args } = await cliFixture(root);
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(configRoot, { recursive: true, force: true })]));
  const result = await execFileAsync(process.execPath, [producerPath, ...args]);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).files.some((file) => file.path === "artifact-manifest.json"), true);
  await assert.rejects(readFile(path.join(root, "artifact-manifest.json"), "utf8"));
  for (const output of ["-", path.join(root, "artifact-manifest.json"), path.join(os.tmpdir(), "artifact-manifest.json")]) {
    await rejectsCli([...args, "--output", output], "ARGUMENT_UNKNOWN");
  }
  await rejectsCli([...args, "--output"], "ARGUMENT_UNKNOWN");
});

test("CLI rejects unknown, duplicate and missing-value arguments", async (t) => {
  const root = await fixture();
  const { configRoot, args } = await cliFixture(root);
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(configRoot, { recursive: true, force: true })]));
  await rejectsCli([...args, "--unknown", "value"], "ARGUMENT_UNKNOWN");
  await rejectsCli([...args, "--target", args.at(-1)], "ARGUMENT_DUPLICATE");
  await rejectsCli([...args.slice(0, -2), "--target"], "ARGUMENT_MISSING");
});
