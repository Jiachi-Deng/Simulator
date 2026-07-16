import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PINNED_COMMIT = "2225647726d5387bb24e9539fdb577958b6d88c6";
const moduleRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const fixture = path.join(moduleRoot, "test", "fixtures", "ordinary-runtime-probe.e2e.ts");

test("V0-V12 run against the exact pinned OpenDesign daemon and V13 remains an independent Host gate", async (t) => {
  if (process.env.OD_RUN_PINNED_ORDINARY_RUNTIME_PROBE !== "1") {
    t.skip("set OD_RUN_PINNED_ORDINARY_RUNTIME_PROBE=1 for the explicit pinned-source integration gate");
    return;
  }

  const source = process.env.OD_PINNED_OPEN_DESIGN_DIR;
  assert.ok(source, "OD_PINNED_OPEN_DESIGN_DIR is required");
  const nodeBin = process.env.OD_NODE24_BIN || process.execPath;
  const pnpmCli = process.env.OD_PNPM_CLI || (await execFileAsync("which", ["pnpm"])).stdout.trim();
  assert.ok(pnpmCli, "OD_PNPM_CLI is required when pnpm is not on PATH");
  const { stdout: nodeVersion } = await execFileAsync(nodeBin, ["--version"]);
  assert.match(nodeVersion.trim(), /^v24\./, "pinned OpenDesign requires Node 24");

  const { stdout: commit } = await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"]);
  assert.equal(commit.trim(), PINNED_COMMIT);
  const { stdout: trackedChanges } = await execFileAsync("git", [
    "-C",
    source,
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]);
  assert.equal(trackedChanges, "", "pinned OpenDesign checkout has tracked changes");
  const provenance = JSON.parse(await readFile(path.join(moduleRoot, "provenance.json"), "utf8"));
  assert.equal(provenance.source.commit, PINNED_COMMIT);

  const target = path.join(source, "apps", "daemon", "tests", "simulator-ordinary-runtime-probe.test.ts");
  await copyFile(fixture, target, constants.COPYFILE_EXCL);
  t.after(() => rm(target, { force: true }));

  const env = {
    ...process.env,
    PATH: `${path.dirname(nodeBin)}:${process.env.PATH || ""}`,
  };
  await execFileAsync(nodeBin, [
    pnpmCli,
    "--filter",
    "@open-design/daemon",
    "exec",
    "tsc",
    "-p",
    "tsconfig.tests.json",
    "--noEmit",
  ], {
    cwd: source,
    env,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
  });
  const upstream = await execFileAsync(nodeBin, [
    pnpmCli,
    "--filter",
    "@open-design/daemon",
    "exec",
    "vitest",
    "run",
    "-c",
    "vitest.config.ts",
    "tests/simulator-ordinary-runtime-probe.test.ts",
  ], {
    cwd: path.join(source, "apps", "daemon"),
    env,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
  });
  assert.match(upstream.stdout, /Tests\s+13 passed \(13\)/);
  t.diagnostic(`pinned OpenDesign ${PINNED_COMMIT}: V0-V12 13/13 passed`);

  const hostEnv = { ...process.env };
  delete hostEnv.NODE_TEST_CONTEXT;
  const host = await execFileAsync(process.execPath, [
    "--test",
    path.join(moduleRoot, "test", "simulator-host-runtime.test.mjs"),
  ], {
    cwd: moduleRoot,
    env: hostEnv,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 60_000,
  });
  assert.match(host.stdout, /# tests 20/);
  assert.match(host.stdout, /# pass 20/);
  assert.match(host.stdout, /# fail 0/);
  t.diagnostic("Simulator Host V13: 20/20 passed independently");
});
