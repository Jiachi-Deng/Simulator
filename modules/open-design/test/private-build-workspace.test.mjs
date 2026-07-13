import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createHermeticBuildEnvironment, createPrivateBuildWorkspace, ensurePrivateDirectory, verifyPostBuildWorkspace } from "../src/private-build-workspace.mjs";
import { EXPECTED_NEXT_ENV_BASE, EXPECTED_NEXT_ENV_GENERATED } from "../src/verify-upstream.mjs";

const execFileAsync = promisify(execFile);
const moduleRoot = new URL("../", import.meta.url);
const baseProvenance = JSON.parse(await readFile(new URL("provenance.json", moduleRoot), "utf8"));
const manifestText = await readFile(new URL("fixtures/upstream-package.open-design-v0.14.1.json", moduleRoot), "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "open-design-private-build-"));
  await chmod(parent, 0o700);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const source = path.join(parent, "source");
  const workParent = path.join(parent, "work");
  await mkdir(path.join(source, "apps/web"), { recursive: true });
  const lockfile = "lockfileVersion: '9.0'\n";
  const workspaceFile = "packages:\n  - apps/*\n";
  await Promise.all([
    writeFile(path.join(source, "package.json"), manifestText),
    writeFile(path.join(source, "pnpm-lock.yaml"), lockfile),
    writeFile(path.join(source, "pnpm-workspace.yaml"), workspaceFile),
    writeFile(path.join(source, "apps/web/next-env.d.ts"), EXPECTED_NEXT_ENV_BASE),
    writeFile(path.join(source, ".gitignore"), "node_modules/\n.next/\ndist/\n"),
  ]);
  await git(source, ["init", "--quiet"]);
  await git(source, ["config", "user.email", "test@example.invalid"]);
  await git(source, ["config", "user.name", "Fixture"]);
  await git(source, ["add", "."]);
  await git(source, ["commit", "--quiet", "-m", "fixture"]);
  const provenance = structuredClone(baseProvenance);
  provenance.source.commit = (await git(source, ["rev-parse", "HEAD"])).trim();
  provenance.lockfile.sha256 = sha256(lockfile);
  for (const input of provenance.buildInputs) {
    if (input.path === "pnpm-lock.yaml") input.sha256 = sha256(lockfile);
    if (input.path === "pnpm-workspace.yaml") input.sha256 = sha256(workspaceFile);
  }
  return { parent, source, workParent, provenance };
}

test("creates an owner-only detached checkout isolated from ignored user-source inputs", async (t) => {
  const { source, workParent, provenance } = await fixture(t);
  await Promise.all([
    mkdir(path.join(source, "node_modules/poison"), { recursive: true }),
    mkdir(path.join(source, "apps/web/.next/poison"), { recursive: true }),
    mkdir(path.join(source, "apps/web/dist/poison"), { recursive: true }),
  ]);
  const workspace = await createPrivateBuildWorkspace({ sourceRoot: source, workParent, provenance });
  t.after(() => workspace.cleanup().catch(() => undefined));
  assert.notEqual(workspace.checkoutRoot, source);
  assert.equal((await git(workspace.checkoutRoot, ["branch", "--show-current"])).trim(), "");
  assert.equal((await git(workspace.checkoutRoot, ["diff", "--name-only"])).trim(), "package.json");
  assert.equal((await stat(workspace.root)).mode & 0o077, 0);
  await assert.rejects(stat(path.join(workspace.checkoutRoot, "node_modules")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(source, "package.json"), "utf8"), manifestText);
});

test("constructs a no-inheritance build environment and rejects public work parents", async (t) => {
  const { parent, source, workParent, provenance } = await fixture(t);
  const workspace = await createPrivateBuildWorkspace({ sourceRoot: source, workParent, provenance });
  t.after(() => workspace.cleanup().catch(() => undefined));
  process.env.OPEN_DESIGN_TEST_SECRET = "must-not-leak";
  t.after(() => { delete process.env.OPEN_DESIGN_TEST_SECRET; });
  const env = createHermeticBuildEnvironment({ workspace, nodeBin: "/toolchain/bin/node", provenance });
  assert.equal(env.OPEN_DESIGN_TEST_SECRET, undefined);
  assert.equal(env.HOME, workspace.homeRoot);
  assert.equal(env.PATH, "/toolchain/bin:/usr/bin:/bin");

  const publicParent = path.join(parent, "public-work");
  await mkdir(publicParent, { mode: 0o755 });
  await assert.rejects(ensurePrivateDirectory(publicParent), { code: "PRIVATE_DIRECTORY_INVALID" });
});

test("post-build verification accepts only fresh outputs and the exact Next generated change", async (t) => {
  const { source, workParent, provenance } = await fixture(t);
  const workspace = await createPrivateBuildWorkspace({ sourceRoot: source, workParent, provenance });
  t.after(() => workspace.cleanup().catch(() => undefined));
  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await Promise.all([
    mkdir(path.join(workspace.checkoutRoot, "apps/web/.next/standalone"), { recursive: true }),
    mkdir(path.join(workspace.checkoutRoot, "apps/web/.next/static"), { recursive: true }),
    mkdir(workspace.daemonDeployRoot),
    mkdir(workspace.webDeployRoot),
    writeFile(path.join(workspace.checkoutRoot, "apps/web/next-env.d.ts"), EXPECTED_NEXT_ENV_GENERATED),
  ]);
  const result = await verifyPostBuildWorkspace({ workspace, provenance, buildStartedAtMs: started });
  assert.equal(result.requiredOutputs.length, 4);

  await writeFile(path.join(workspace.checkoutRoot, "pnpm-lock.yaml"), "tampered\n");
  await assert.rejects(verifyPostBuildWorkspace({ workspace, provenance, buildStartedAtMs: started }), { code: "BUILD_SOURCE_MUTATED" });
});

async function git(cwd, args) {
  return (await execFileAsync("git", args, { cwd })).stdout;
}
