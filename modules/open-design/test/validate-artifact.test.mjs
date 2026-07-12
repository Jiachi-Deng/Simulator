import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateArtifact } from "../src/validate-artifact.mjs";

const root = new URL("../", import.meta.url);
const load = async (name) => JSON.parse(await readFile(new URL(name, root), "utf8"));
const base = {
  provenance: await load("provenance.json"),
  policy: await load("artifact-policy.json"),
  decisions: await load("resource-decisions.json"),
  inventory: await load("fixtures/minimal-valid.inventory.json")
};

function mutate(mutator) {
  const input = structuredClone(base);
  mutator(input);
  return validateArtifact(input);
}

function has(result, code) {
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === code), `expected ${code}, got ${JSON.stringify(result.errors)}`);
}

test("accepts the minimal pinned artifact inventory", () => assert.deepEqual(validateArtifact(base), { ok: true, errors: [] }));

test("rejects path traversal and absolute paths", () => {
  for (const badPath of ["runtime/daemon/../../secret", "/runtime/daemon/secret", "runtime\\daemon\\secret"]) {
    has(mutate(({ inventory }) => inventory.files.push({ path: badPath, kind: "runtime", dependencyScope: "production" })), "PATH_TRAVERSAL");
  }
});

test("rejects escaping symlink metadata", () => {
  has(mutate(({ inventory }) => inventory.files.push({ path: "runtime/daemon/link", kind: "runtime", type: "symlink", symlinkTarget: "../../../outside", dependencyScope: "production" })), "SYMLINK_ESCAPE");
});

test("rejects nested Electron and installer/updater/test/cache paths", () => {
  for (const badPath of [
    "runtime/packages/node_modules/electron/index.js",
    "runtime/packages/product/installer/setup.js",
    "runtime/daemon/updater/index.js",
    "web/standalone/.next/cache/data.bin",
    "runtime/daemon/tests/unit.js"
  ]) has(mutate(({ inventory }) => inventory.files.push({ path: badPath, kind: "runtime", dependencyScope: "production" })), "FORBIDDEN_PATH");
});

test("requires license, SBOM, provenance and artifact manifest", () => {
  for (const required of base.policy.requiredFiles) {
    has(mutate(({ inventory }) => { inventory.files = inventory.files.filter((file) => file.path !== required); }), "REQUIRED_FILE_MISSING");
  }
});

test("rejects non-pinned and mismatched source refs", () => {
  has(mutate(({ provenance }) => { provenance.source.refType = "branch"; provenance.source.ref = "main"; provenance.source.commit = "HEAD"; }), "SOURCE_NOT_PINNED");
  has(mutate(({ inventory }) => { inventory.source.commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; }), "SOURCE_MISMATCH");
});

test("rejects unexpected or uncleared resources", () => {
  has(mutate(({ inventory }) => inventory.files.push({ path: "web/public/unclassified.png", kind: "runtime", dependencyScope: "artifact" })), "UNEXPECTED_RESOURCE");
  has(mutate(({ inventory }) => inventory.files.push({ path: "web/public/font.woff2", kind: "resource", resourceCategory: "fonts", decisionId: "missing", dependencyScope: "artifact" })), "UNEXPECTED_RESOURCE");
  has(mutate(({ inventory }) => inventory.files.push({ path: "web/public/font.woff2", kind: "resource", resourceCategory: "fonts", decisionId: "fonts-upstream", dependencyScope: "artifact" })), "RESOURCE_EXCLUDED");
});

test("requires native resource decision and complete ABI declarations", () => {
  has(mutate(({ inventory }) => inventory.files.push({ path: "runtime/packages/addon.node", kind: "runtime", dependencyScope: "production" })), "NATIVE_RESOURCE_UNDECLARED");
  has(mutate(({ decisions, inventory }) => {
    decisions.decisions.push({ id: "approved-native", category: "native-binaries", sourcePath: "runtime/packages/addon.node", status: "include", rightsStatus: "cleared", license: "MIT", reason: "Reviewed dependency output" });
    inventory.files.push({ path: "runtime/packages/addon.node", kind: "resource", resourceCategory: "native-binaries", decisionId: "approved-native", dependencyScope: "production", nativeAbi: { platform: "darwin", arch: "arm64", nodeAbi: "137" } });
  }), "NATIVE_ABI_MISSING");
});

test("rejects development dependencies", () => {
  has(mutate(({ inventory }) => inventory.files.push({ path: "runtime/packages/dev-only.js", kind: "runtime", dependencyScope: "development" })), "DEPENDENCY_SCOPE_FORBIDDEN");
});
