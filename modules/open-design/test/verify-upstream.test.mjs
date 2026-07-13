import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { EXPECTED_NEXT_ENV_GENERATED, EXPECTED_NEXT_ENV_BASE, verifyToolchain, verifyUpstream } from "../src/verify-upstream.mjs";

const execFileAsync = promisify(execFile);

async function sourceFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "open-design-upstream-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "apps/web"), { recursive: true });
  const lockfile = "lockfileVersion: '9.0'\n";
  await Promise.all([
    writeFile(path.join(root, "apps/web/next-env.d.ts"), EXPECTED_NEXT_ENV_BASE),
    writeFile(path.join(root, "pnpm-lock.yaml"), lockfile),
    writeFile(path.join(root, "package.json"), `${JSON.stringify({
      name: "open-design",
      version: "0.14.1",
      packageManager: "pnpm@10.33.2",
      engines: { node: "~24", pnpm: ">=10.33.2 <11" },
      pnpm: { onlyBuiltDependencies: ["better-sqlite3", "node-pty", "sharp"] },
    }, null, 2)}\n`),
  ]);
  await git(root, ["init", "--quiet"]);
  await git(root, ["config", "user.email", "test@example.invalid"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "--quiet", "-m", "fixture"]);
  await git(root, ["remote", "add", "origin", "https://github.com/nexu-io/open-design.git"]);
  await git(root, ["tag", "open-design-v0.14.1"]);
  const commit = (await git(root, ["rev-parse", "HEAD"])).trim();
  return {
    root,
    provenance: {
      repository: "https://github.com/nexu-io/open-design",
      source: { refType: "tag", ref: "open-design-v0.14.1", commit },
      upstreamManifest: { path: "package.json", name: "open-design", version: "0.14.1", packageManager: "pnpm@10.33.2" },
      lockfile: { path: "pnpm-lock.yaml", sha256: createHash("sha256").update(lockfile).digest("hex") },
      buildToolchainExpectations: { node: "~24", pnpm: ">=10.33.2 <11" },
    },
  };
}

test("verifies exact repository, commit/tag, toolchain, lock hash, and a clean checkout", async (t) => {
  const { root, provenance } = await sourceFixture(t);
  const result = await verifyUpstream({ sourceRoot: root, provenance, nodeVersion: "v24.4.0", pnpmVersion: "10.33.2" });
  assert.equal(result.cleanliness.status, "clean");
  assert.equal(result.lockfile.sha256, provenance.lockfile.sha256);
});

test("allows only the exact known Next-generated next-env.d.ts change", async (t) => {
  const { root, provenance } = await sourceFixture(t);
  await writeFile(path.join(root, "apps/web/next-env.d.ts"), EXPECTED_NEXT_ENV_GENERATED);
  const allowed = await verifyUpstream({ sourceRoot: root, provenance, nodeVersion: "24.4.0", pnpmVersion: "10.33.2" });
  assert.equal(allowed.cleanliness.allowedGeneratedChange, true);
  await writeFile(path.join(root, "unexpected.txt"), "nope\n");
  await assert.rejects(
    verifyUpstream({ sourceRoot: root, provenance, nodeVersion: "24.4.0", pnpmVersion: "10.33.2" }),
    { code: "SOURCE_DIRTY" },
  );
});

test("fails closed for an unpinned Node version or a non-exact pnpm version", () => {
  const manifest = { packageManager: "pnpm@10.33.2", engines: { node: "~24", pnpm: ">=10.33.2 <11" } };
  const provenance = { upstreamManifest: { packageManager: "pnpm@10.33.2" }, buildToolchainExpectations: { node: "~24", pnpm: ">=10.33.2 <11" } };
  assert.throws(() => verifyToolchain({ manifest, provenance, nodeVersion: "v22.20.0", pnpmVersion: "10.33.2" }), { code: "NODE_VERSION_MISMATCH" });
  assert.throws(() => verifyToolchain({ manifest, provenance, nodeVersion: "v24.0.0", pnpmVersion: "10.33.3" }), { code: "PNPM_VERSION_MISMATCH" });
});

async function git(cwd, args) {
  return (await execFileAsync("git", args, { cwd })).stdout;
}
