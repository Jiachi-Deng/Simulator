import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { digestCanonicalJson, digestInventory, loadRuntimeSchemas, validateArtifact } from "../src/validate-artifact.mjs";

const root = new URL("../", import.meta.url);
const load = async (name) => JSON.parse(await readFile(new URL(name, root), "utf8"));
const base = {
  provenance: await load("provenance.json"),
  policy: await load("artifact-policy.json"),
  decisions: await load("resource-decisions.json"),
  attestation: await load("fixtures/minimal-build-attestation.json"),
  inventory: await load("fixtures/minimal-valid.inventory.json"),
  schemas: await loadRuntimeSchemas()
};
const digest = "a".repeat(64);
const execFileAsync = promisify(execFile);
const validatorPath = fileURLToPath(new URL("../src/validate-artifact.mjs", import.meta.url));
const cliArgs = [
  "--provenance", fileURLToPath(new URL("../provenance.json", import.meta.url)),
  "--policy", fileURLToPath(new URL("../artifact-policy.json", import.meta.url)),
  "--decisions", fileURLToPath(new URL("../resource-decisions.json", import.meta.url)),
  "--attestation", fileURLToPath(new URL("../fixtures/minimal-build-attestation.json", import.meta.url)),
  "--inventory", fileURLToPath(new URL("../fixtures/minimal-valid.inventory.json", import.meta.url))
];

function mutate(mutator) {
  const input = structuredClone(base);
  mutator(input);
  return validateArtifact(input);
}

function has(result, code) {
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === code), `expected ${code}, got ${JSON.stringify(result.errors)}`);
}

function runtimeFile(path, overrides = {}) {
  return { schemaVersion: 1, path, type: "file", artifactKind: "runtime-package", component: "runtime-package", dependencyScope: "production", bytes: 10, sha256: digest, ...overrides };
}

function publicFile(path, overrides = {}) {
  return { schemaVersion: 1, path, type: "file", artifactKind: "web-static", component: "next-public", dependencyScope: "artifact", bytes: 10, sha256: digest, ...overrides };
}

function approveResource(input, { id, category, sourcePath, license = "MIT" }) {
  input.decisions.decisions.push({
    id, category, sourcePath, status: "include", rightsStatus: "cleared", license,
    rightsEvidence: { type: "license-file", reference: `${sourcePath}.LICENSE`, sha256: digest }, reason: "Reviewed for artifact inclusion"
  });
}

function refreshManifestDigest(inventory) {
  inventory.files.find((file) => file.path === "artifact-manifest.json").sha256 = digestInventory(inventory);
}

function refreshAttestationAndManifest(input) {
  input.inventory.files.find((file) => file.path === "build-attestation.json").sha256 = digestCanonicalJson(input.attestation);
  refreshManifestDigest(input.inventory);
}

test("accepts the minimal pinned artifact inventory", () => assert.deepEqual(validateArtifact(base), { ok: true, errors: [] }));

test("validator CLI rejects unknown, duplicate and missing-value arguments", async () => {
  const rejectsCli = async (args, code) => {
    await assert.rejects(execFileAsync(process.execPath, [validatorPath, ...args]), (error) => error.stderr.includes(`${code}:`));
  };
  await rejectsCli([...cliArgs, "--unknown", "value"], "ARGUMENT_UNKNOWN");
  await rejectsCli([...cliArgs, "--policy", cliArgs[3]], "ARGUMENT_DUPLICATE");
  await rejectsCli([...cliArgs.slice(0, -2), "--inventory"], "ARGUMENT_MISSING");
});

test("executes strict schemas for every document and inventory file", () => {
  for (const name of ["provenance", "policy", "decisions", "attestation", "inventory"]) {
    has(mutate((input) => { input[name].unknownField = true; }), "SCHEMA_INVALID");
    has(mutate((input) => { input[name].schemaVersion = 2; }), "SCHEMA_INVALID");
  }
  has(mutate(({ inventory }) => { inventory.files[0].type = "directory"; }), "SCHEMA_INVALID");
  has(mutate(({ inventory }) => { inventory.files[0].schemaVersion = 2; }), "SCHEMA_INVALID");
  has(mutate(({ inventory }) => { inventory.files[0].unknownField = true; }), "SCHEMA_INVALID");
  has(mutate(({ inventory }) => { delete inventory.files[0].bytes; }), "SCHEMA_INVALID");
});

test("requires legal and metadata paths to be correctly bound regular files", () => {
  for (const required of base.policy.requiredFiles) {
    has(mutate(({ inventory }) => { inventory.files = inventory.files.filter((file) => file.path !== required.path); }), "REQUIRED_FILE_MISSING");
  }
  has(mutate(({ inventory }) => {
    const license = inventory.files.find((file) => file.path === "legal/LICENSE");
    license.type = "symlink";
    license.symlinkTarget = "../provenance.json";
  }), "REQUIRED_FILE_INVALID");
  has(mutate(({ inventory }) => { inventory.files.find((file) => file.path === "legal/SBOM.spdx.json").artifactKind = "metadata"; }), "REQUIRED_FILE_INVALID");
  has(mutate(({ inventory }) => { inventory.files.find((file) => file.path === "legal/SBOM.spdx.json").schemaId = "generic-json"; }), "CONTENT_BINDING_INVALID");
  has(mutate(({ inventory }) => { delete inventory.files.find((file) => file.path === "provenance.json").sourceCommit; }), "CONTENT_BINDING_INVALID");
  has(mutate(({ inventory }) => { inventory.files.find((file) => file.path === "artifact-manifest.json").contentSchemaVersion = 2; }), "CONTENT_BINDING_INVALID");
  has(mutate(({ inventory }) => { inventory.files.find((file) => file.path === "provenance.json").sha256 = digest; }), "CONTENT_DIGEST_MISMATCH");
  has(mutate(({ inventory }) => { inventory.files.find((file) => file.path === "web/standalone/server.js").bytes += 1; }), "CONTENT_DIGEST_MISMATCH");
});

test("binds a resource decision to exact normalized sourcePath and category", () => {
  has(mutate((input) => {
    approveResource(input, { id: "font", category: "fonts", sourcePath: "assets/font.woff2" });
    input.inventory.files.push(runtimeFile("web/public/font.woff2", { artifactKind: "web-static", component: "next-public", dependencyScope: "artifact", resourceCategory: "fonts", decisionId: "font", sourcePath: "other/font.woff2" }));
  }), "RESOURCE_DECISION_MISMATCH");
  has(mutate((input) => {
    approveResource(input, { id: "image", category: "images", sourcePath: "assets/logo.png" });
    input.inventory.files.push(runtimeFile("web/public/logo.png", { artifactKind: "web-static", component: "next-public", dependencyScope: "artifact", resourceCategory: "fonts", decisionId: "image", sourcePath: "assets/logo.png" }));
  }), "RESOURCE_DECISION_MISMATCH");
  has(mutate(({ decisions }) => { decisions.decisions[0].sourcePath = "design-templates/**"; }), "DECISION_SOURCE_INVALID");
});

test("requires exact approved metadata decisions for resource-category paths", () => {
  const cases = [
    ["web/public/plugins/tool.txt", "plugins"],
    ["web/public/skills/guide.txt", "skills"],
    ["web/public/templates/base.txt", "templates"],
    ["web/public/design-systems/tokens.json", "images"],
    ["web/public/assets/data.txt", "images"]
  ];
  for (const [artifactPath, category] of cases) {
    has(mutate(({ inventory }) => { inventory.files.push(publicFile(artifactPath)); }), "UNEXPECTED_RESOURCE");
    has(mutate((input) => {
      const sourcePath = `review/${artifactPath}`;
      input.decisions.decisions.push({ id: `pending-${category}`, category, sourcePath, status: "review", rightsStatus: "pending", license: null, rightsEvidence: null, reason: "Not approved" });
      input.inventory.files.push(publicFile(artifactPath, { resourceCategory: category, sourcePath, decisionId: `pending-${category}` }));
    }), "RESOURCE_EXCLUDED");
  }
});

test("include+cleared decisions require a license and rights evidence", () => {
  has(mutate(({ decisions }) => {
    decisions.decisions[0] = { ...decisions.decisions[0], status: "include", rightsStatus: "cleared", license: null, rightsEvidence: null };
  }), "RIGHTS_EVIDENCE_MISSING");
  has(mutate(({ decisions }) => {
    decisions.decisions[0] = { ...decisions.decisions[0], status: "include", rightsStatus: "cleared", license: "MIT", rightsEvidence: null };
  }), "RIGHTS_EVIDENCE_MISSING");
});

test("rejects traversal and escaping symlink metadata", () => {
  for (const badPath of ["runtime/packages/../../secret", "/runtime/packages/secret", "runtime\\packages\\secret"]) {
    has(mutate(({ inventory }) => inventory.files.push(runtimeFile(badPath))), "PATH_TRAVERSAL");
  }
  has(mutate(({ inventory }) => inventory.files.push(runtimeFile("runtime/packages/link", { type: "symlink", symlinkTarget: "../../../outside" }))), "SYMLINK_ESCAPE");
});

test("rejects Electron, updater, cache, tests, snapshots and dev bins case-insensitively", () => {
  for (const badPath of [
    "runtime/packages/vendor/ElEcTrOn.App/Contents/main.js",
    "runtime/packages/vendor/electron-helper/main.js",
    "runtime/packages/.cache/data.bin",
    "runtime/packages/cache/data.bin",
    "runtime/packages/app-update/latest.yml",
    "runtime/packages/latest-linux.yml",
    "runtime/packages/__snapshots__/output.js",
    "runtime/packages/test/unit.js",
    "runtime/packages/node_modules/.bin/tsx"
  ]) has(mutate(({ inventory }) => inventory.files.push(runtimeFile(badPath))), "FORBIDDEN_PATH");
});

test("dependencyScope alone cannot authorize an entry", () => {
  has(mutate(({ inventory }) => inventory.files.push(runtimeFile("outside/allowed.js"))), "PATH_NOT_ALLOWED");
  has(mutate(({ inventory }) => inventory.files.push(runtimeFile("web/standalone/server.js"))), "PROFILE_MISMATCH");
  has(mutate(({ inventory }) => inventory.files.push(runtimeFile("runtime/packages/dev.js", { dependencyScope: "development" }))), "DEPENDENCY_SCOPE_FORBIDDEN");
});

test("rejects Unicode NFC and case-fold path collisions", () => {
  has(mutate(({ inventory }) => {
    inventory.files.push(runtimeFile("web/static/Caf\u00e9.js", { artifactKind: "web-static", component: "next-static", dependencyScope: "artifact" }));
    inventory.files.push(runtimeFile("web/static/CAF\u00c9.js", { artifactKind: "web-static", component: "next-static", dependencyScope: "artifact" }));
  }), "DUPLICATE_PATH");
  has(mutate(({ inventory }) => {
    inventory.files.push(runtimeFile("web/static/Stra\u00dfe.js", { artifactKind: "web-static", component: "next-static", dependencyScope: "artifact" }));
    inventory.files.push(runtimeFile("web/static/STRASSE.js", { artifactKind: "web-static", component: "next-static", dependencyScope: "artifact" }));
  }), "DUPLICATE_PATH");
  has(mutate(({ inventory }) => {
    inventory.files.push(runtimeFile("web/static/\u1fb3.js", { artifactKind: "web-static", component: "next-static", dependencyScope: "artifact" }));
    inventory.files.push(runtimeFile("web/static/\u03b1\u03b9.js", { artifactKind: "web-static", component: "next-static", dependencyScope: "artifact" }));
  }), "DUPLICATE_PATH");
  has(mutate(({ inventory }) => inventory.files.push(runtimeFile("web/static/Cafe\u0301.js", { artifactKind: "web-static", component: "next-static", dependencyScope: "artifact" }))), "PATH_TRAVERSAL");
});

test("models native targets by kind and matches the artifact target", () => {
  has(mutate((input) => {
    approveResource(input, { id: "addon", category: "native-binaries", sourcePath: "packages/addon.node" });
    input.inventory.files.push(runtimeFile("runtime/packages/addon.node", { artifactKind: "native-binary", resourceCategory: "native-binaries", decisionId: "addon", sourcePath: "packages/addon.node", nativeTarget: { format: "node-addon", platform: "darwin", arch: "arm64", libc: "none" } }));
  }), "NATIVE_ABI_MISSING");
  assert.equal(mutate((input) => {
    approveResource(input, { id: "tool", category: "native-binaries", sourcePath: "packages/tool.exe" });
    const file = runtimeFile("runtime/packages/tool.exe", { artifactKind: "native-binary", resourceCategory: "native-binaries", decisionId: "tool", sourcePath: "packages/tool.exe", nativeTarget: { format: "executable", platform: "darwin", arch: "arm64", libc: "none" } });
    input.inventory.files.push(file);
    input.attestation.native.push({ packageName: "sharp", path: file.path, format: "executable", platform: "darwin", arch: "arm64", nodeAbi: "137", libc: "none", binaryFormat: "mach-o", sha256: file.sha256, sourceCtime: "2026-07-13T00:00:00.000Z", freshFromBuild: true, load: null });
    input.attestation.build.normalization.nativeOrigins.push({ path: file.path, sha256: file.sha256, sourceCtime: "2026-07-13T00:00:00.000Z" });
    refreshAttestationAndManifest(input);
  }).ok, true, "non-Node executable must not require nodeAbi");
  has(mutate((input) => {
    approveResource(input, { id: "addon", category: "native-binaries", sourcePath: "packages/addon.node" });
    input.inventory.files.push(runtimeFile("runtime/packages/addon.node", { artifactKind: "native-binary", resourceCategory: "native-binaries", decisionId: "addon", sourcePath: "packages/addon.node", nativeTarget: { format: "node-addon", platform: "linux", arch: "arm64", libc: "glibc", nodeAbi: "137" } }));
  }), "NATIVE_TARGET_MISMATCH");
  has(mutate(({ inventory }) => { inventory.target.platform = "solaris"; }), "SCHEMA_INVALID");
});

test("enforces entry, path, string, file and total byte limits", () => {
  has(mutate(({ policy }) => { policy.limits.maxEntries = 5; }), "ENTRY_LIMIT_EXCEEDED");
  has(mutate(({ policy }) => { policy.limits.maxPathBytes = 8; }), "PATH_LIMIT_EXCEEDED");
  has(mutate(({ policy }) => { policy.limits.maxStringBytes = 8; }), "STRING_LIMIT_EXCEEDED");
  has(mutate(({ policy }) => { policy.limits.maxFileBytes = 99; }), "FILE_LIMIT_EXCEEDED");
  has(mutate(({ policy }) => { policy.limits.maxTotalBytes = 100; }), "TOTAL_SIZE_EXCEEDED");
});

test("rejects non-pinned and mismatched source refs", () => {
  has(mutate(({ provenance }) => { provenance.source.ref = "main"; }), "SOURCE_NOT_PINNED");
  has(mutate(({ inventory }) => { inventory.source.commit = "b".repeat(40); }), "SOURCE_MISMATCH");
});

test("binds patch, exact toolchain, target and every staged Node addon to attestation", () => {
  has(mutate(({ attestation }) => { attestation.patch.sha256 = "f".repeat(64); }), "ATTESTATION_PATCH_MISMATCH");
  has(mutate(({ attestation }) => { attestation.toolchain.nodeExecutableSha256 = "f".repeat(64); }), "ATTESTATION_TOOLCHAIN_MISMATCH");
  has(mutate(({ attestation }) => { attestation.sourceCommit = "f".repeat(40); }), "ATTESTATION_SOURCE_MISMATCH");
  has(mutate((input) => {
    approveResource(input, { id: "addon-attestation", category: "native-binaries", sourcePath: "packages/addon.node" });
    input.inventory.files.push(runtimeFile("runtime/packages/addon.node", {
      artifactKind: "native-binary", resourceCategory: "native-binaries", decisionId: "addon-attestation", sourcePath: "packages/addon.node",
      nativeTarget: { format: "node-addon", platform: "darwin", arch: "arm64", libc: "none", nodeAbi: "137" },
    }));
  }), "ATTESTATION_NATIVE_MISMATCH");
  has(mutate(({ attestation }) => { attestation.smoke.daemon.status.pid += 1; }), "ATTESTATION_SMOKE_MISMATCH");
});
