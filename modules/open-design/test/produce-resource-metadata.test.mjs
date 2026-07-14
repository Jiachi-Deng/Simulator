import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { produceResourceMetadata } from "../src/produce-resource-metadata.mjs";
import { canonicalJsonBytes } from "../src/validate-artifact.mjs";

const moduleRoot = new URL("../", import.meta.url);
const load = async (name) => JSON.parse(await readFile(new URL(name, moduleRoot), "utf8"));
const provenance = await load("provenance.json");
const policy = await load("artifact-policy.json");
const decisions = await load("resource-decisions.json");
const target = { platform: "darwin", arch: "arm64", nodeAbi: "137", libc: "none" };

test("produces canonical metadata for every real staged resource path", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "open-design-resource-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "runtime/daemon/node_modules/node-pty");
  const nativePath = "runtime/daemon/node_modules/node-pty/prebuilds/darwin-arm64/pty.node";
  const imagePath = "web/standalone/apps/web/public/logo.svg";
  await Promise.all([
    mkdir(path.join(packageRoot, "prebuilds/darwin-arm64"), { recursive: true }),
    mkdir(path.dirname(path.join(root, imagePath)), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "node-pty", version: "1.1.0", license: "MIT" })),
    writeFile(path.join(root, nativePath), "native"),
    writeFile(path.join(root, imagePath), "svg"),
  ]);

  const result = await produceResourceMetadata({ artifactRoot: root, provenance, policy, decisions, target });
  assert.deepEqual(Object.keys(result.document.resources), [nativePath, imagePath]);
  assert.deepEqual(result.document.resources[nativePath], {
    resourceCategory: "native-binaries",
    sourcePath: "node-pty@1.1.0/prebuilds/darwin-arm64/pty.node",
    decisionId: "native-node-pty-1.1.0",
    nativeTarget: { format: "node-addon", platform: "darwin", arch: "arm64", nodeAbi: "137", libc: "none" },
  });
  assert.equal(result.document.resources[imagePath].sourcePath, "apps/web/public/logo.svg");
  assert.match(result.document.resources[imagePath].decisionId, /^unreviewed-images-[0-9a-f]{16}$/u);
  assert.equal(result.sha256, createHash("sha256").update(canonicalJsonBytes(result.document)).digest("hex"));
  assert.equal(result.bytes.includes(Buffer.from(root)), false);
  assert.deepEqual(result.evidence, { resourceCount: 2, categories: { images: 1, "native-binaries": 1 } });
});
