import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";

import { produceSbom } from "../src/produce-sbom.mjs";
import { validateSbom } from "../src/stage-open-design.mjs";

const moduleRoot = new URL("../", import.meta.url);
const load = async (name) => JSON.parse(await readFile(new URL(name, moduleRoot), "utf8"));
const baseProvenance = await load("provenance.json");
const policy = await load("artifact-policy.json");
const target = { platform: "darwin", arch: "arm64", nodeAbi: "137", libc: "none" };

test("produces a deterministic SPDX document from the pinned lock and staged package manifests", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "open-design-sbom-"));
  const sourceRoot = path.join(root, "source");
  const artifactRoot = path.join(root, "artifact");
  await Promise.all([mkdir(sourceRoot), mkdir(artifactRoot)]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const provenance = structuredClone(baseProvenance);
  const lock = { lockfileVersion: "9.0", packages: {} };
  for (const entry of provenance.sbom.requiredPackages) {
    lock.packages[`${entry.name}@${entry.version}`] = { resolution: { integrity: `sha512-${Buffer.from(entry.contentSha512, "hex").toString("base64")}` } };
    const packageRoot = path.join(artifactRoot, "runtime/packages/node_modules", ...entry.name.split("/"));
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: entry.name, version: entry.version, license: entry.licenseDeclared }));
  }
  const lockBytes = Buffer.from(stringify(lock), "utf8");
  provenance.lockfile.sha256 = createHash("sha256").update(lockBytes).digest("hex");
  await writeFile(path.join(sourceRoot, "pnpm-lock.yaml"), lockBytes);

  const first = await produceSbom({ sourceRoot, artifactRoot, provenance, target });
  const second = await produceSbom({ sourceRoot, artifactRoot, provenance, target });
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.document.packages.length, 8);
  assert.equal(first.document.relationships.length, 8);
  assert.equal(first.bytes.includes(Buffer.from(root)), false);
  assert.equal(validateSbom({ sbom: first.document, sha256: first.sha256, provenance, policy }).packages.length, 8);

  lock.packages[`${provenance.sbom.requiredPackages[0].name}@${provenance.sbom.requiredPackages[0].version}`].resolution.integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
  const changedBytes = Buffer.from(stringify(lock), "utf8");
  provenance.lockfile.sha256 = createHash("sha256").update(changedBytes).digest("hex");
  await writeFile(path.join(sourceRoot, "pnpm-lock.yaml"), changedBytes);
  await assert.rejects(produceSbom({ sourceRoot, artifactRoot, provenance, target }), { code: "SBOM_CONTENT_DIGEST_MISMATCH" });
});
