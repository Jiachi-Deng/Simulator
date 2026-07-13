import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { applySimulatorPatch } from "../src/apply-simulator-patch.mjs";
import { assertNativeBuildsAllowed } from "../src/native-inventory.mjs";
import { EXPECTED_NEXT_ENV_GENERATED, EXPECTED_NEXT_ENV_BASE, verifyToolchain, verifyUpstream } from "../src/verify-upstream.mjs";

const execFileAsync = promisify(execFile);
const moduleRoot = new URL("../", import.meta.url);
const pinnedProvenance = JSON.parse(await readFile(new URL("provenance.json", moduleRoot), "utf8"));
const pinnedManifestText = await readFile(new URL("fixtures/upstream-package.open-design-v0.14.1.json", moduleRoot), "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function sourceFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "open-design-upstream-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "apps/web"), { recursive: true });
  const lockfile = "lockfileVersion: '9.0'\n";
  const workspace = "packages:\n  - apps/*\n";
  await Promise.all([
    writeFile(path.join(root, "apps/web/next-env.d.ts"), EXPECTED_NEXT_ENV_BASE),
    writeFile(path.join(root, "pnpm-lock.yaml"), lockfile),
    writeFile(path.join(root, "pnpm-workspace.yaml"), workspace),
    writeFile(path.join(root, "package.json"), pinnedManifestText),
  ]);
  await git(root, ["init", "--quiet"]);
  await git(root, ["config", "user.email", "test@example.invalid"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "--quiet", "-m", "fixture"]);
  await git(root, ["remote", "add", "origin", "https://github.com/nexu-io/open-design.git"]);
  await git(root, ["tag", "open-design-v0.14.1"]);
  const commit = (await git(root, ["rev-parse", "HEAD"])).trim();
  const provenance = structuredClone(pinnedProvenance);
  provenance.source.commit = commit;
  provenance.lockfile.sha256 = sha256(lockfile);
  for (const input of provenance.buildInputs) {
    if (input.path === "pnpm-lock.yaml") input.sha256 = sha256(lockfile);
    if (input.path === "pnpm-workspace.yaml") input.sha256 = sha256(workspace);
  }
  return { root, provenance };
}

const exactToolchain = Object.freeze({
  nodeVersion: "v24.14.1",
  nodeAbi: "137",
  platform: "darwin",
  arch: "arm64",
  nodeExecutable: "/toolchain/node",
  nodeExecutableSha256: pinnedProvenance.buildToolchainExpectations.nodeExecutableSha256,
  pnpmVersion: "10.33.2",
  pnpmExecutable: "/toolchain/pnpm.cjs",
  pnpmExecutableSha256: pinnedProvenance.buildToolchainExpectations.pnpmExecutableSha256,
});

test("verifies exact repository, commit/tag, real manifest, inputs, lock and toolchain", async (t) => {
  const { root, provenance } = await sourceFixture(t);
  const result = await verifyUpstream({ sourceRoot: root, provenance, inspectToolchain: async () => exactToolchain });
  assert.equal(result.cleanliness.status, "clean");
  assert.equal(result.manifestDigest.sha256, pinnedProvenance.upstreamManifest.sha256);
  assert.equal(result.lockfile.sha256, provenance.lockfile.sha256);
  assert.equal(result.toolchain.nodeAbi, "137");
});

test("real pinned manifest fails node-pty policy until the single approved patch is applied", async (t) => {
  const { root, provenance } = await sourceFixture(t);
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.throws(() => assertNativeBuildsAllowed(manifest), { code: "NATIVE_BUILD_IGNORED" });
  const applied = await applySimulatorPatch({ checkoutRoot: root, provenance });
  assert.deepEqual(applied.changedPaths, ["package.json"]);
  assert.equal(applied.postimageSha256, pinnedProvenance.simulatorPatch.postimageSha256);
  assert.doesNotThrow(() => assertNativeBuildsAllowed(applied.manifest));
});

test("allows only the exact known Next-generated next-env.d.ts change", async (t) => {
  const { root, provenance } = await sourceFixture(t);
  await writeFile(path.join(root, "apps/web/next-env.d.ts"), EXPECTED_NEXT_ENV_GENERATED);
  const allowed = await verifyUpstream({ sourceRoot: root, provenance, inspectToolchain: async () => exactToolchain });
  assert.equal(allowed.cleanliness.allowedGeneratedChange, true);
  await writeFile(path.join(root, "unexpected.txt"), "nope\n");
  await assert.rejects(
    verifyUpstream({ sourceRoot: root, provenance, inspectToolchain: async () => exactToolchain }),
    { code: "SOURCE_DIRTY" },
  );
});

test("fails closed for Node patch, ABI, platform and executable digest drift", () => {
  const manifest = JSON.parse(pinnedManifestText);
  const cases = [
    ["NODE_VERSION_MISMATCH", { nodeVersion: "v24.14.0" }],
    ["NODE_ABI_MISMATCH", { nodeAbi: "136" }],
    ["TOOLCHAIN_PLATFORM_MISMATCH", { arch: "x64" }],
    ["NODE_EXECUTABLE_MISMATCH", { nodeExecutableSha256: "0".repeat(64) }],
    ["PNPM_VERSION_MISMATCH", { pnpmVersion: "10.33.3" }],
    ["PNPM_EXECUTABLE_MISMATCH", { pnpmExecutableSha256: "0".repeat(64) }],
  ];
  for (const [code, override] of cases) {
    assert.throws(() => verifyToolchain({ manifest, provenance: pinnedProvenance, toolchain: { ...exactToolchain, ...override } }), { code });
  }
});

test("rejects a changed real manifest even when name/version fields still match", async (t) => {
  const { root, provenance } = await sourceFixture(t);
  const manifest = JSON.parse(pinnedManifestText);
  manifest.description = "tampered";
  await writeFile(path.join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await git(root, ["add", "package.json"]);
  await git(root, ["commit", "--quiet", "-m", "tamper"]);
  provenance.source.commit = (await git(root, ["rev-parse", "HEAD"])).trim();
  await git(root, ["tag", "--force", "open-design-v0.14.1"]);
  await assert.rejects(
    verifyUpstream({ sourceRoot: root, provenance, inspectToolchain: async () => exactToolchain }),
    { code: "UPSTREAM_MANIFEST_HASH_MISMATCH" },
  );
});

async function git(cwd, args) {
  return (await execFileAsync("git", args, { cwd })).stdout;
}
