import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { copyStagingInputs } from "../src/staging-copier.mjs";
import { createBuildPlan, runBuildPlan, writeArtifactManifest } from "../src/stage-open-design.mjs";

const moduleRoot = new URL("../", import.meta.url);
const policy = JSON.parse(await readFile(new URL("artifact-policy.json", moduleRoot), "utf8"));

async function roots(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "open-design-copier-"));
  const source = path.join(root, "source");
  const staging = path.join(root, "staging");
  await mkdir(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { source, staging };
}

test("copies only policy-allowed production files and excludes maps and dev artifacts", async (t) => {
  const { source, staging } = await roots(t);
  await mkdir(path.join(source, "tests"));
  await Promise.all([
    writeFile(path.join(source, "server.js"), "server\n"),
    writeFile(path.join(source, "client.js.map"), "map\n"),
    writeFile(path.join(source, "tests/spec.js"), "test\n"),
  ]);
  const result = await copyStagingInputs({
    stagingRoot: staging,
    policy,
    inputs: [{ label: "standalone", source, destination: "web/standalone" }],
  });
  assert.deepEqual(result.copied.map((entry) => entry.path), ["web/standalone/server.js"]);
  assert.deepEqual(result.excluded.map((entry) => entry.path).sort(), ["web/standalone/client.js.map", "web/standalone/tests"]);
  assert.equal(await readFile(path.join(staging, "web/standalone/server.js"), "utf8"), "server\n");
});

test("rejects symlink and hard-link staging sources", async (t) => {
  const symlinkFixture = await roots(t);
  await writeFile(path.join(symlinkFixture.source, "server.js"), "server\n");
  await symlink("server.js", path.join(symlinkFixture.source, "link.js"));
  await assert.rejects(
    copyStagingInputs({ stagingRoot: symlinkFixture.staging, policy, inputs: [{ label: "symlink", source: symlinkFixture.source, destination: "web/standalone" }] }),
    { code: "STAGING_SYMLINK_FORBIDDEN" },
  );

  const hardlinkFixture = await roots(t);
  const original = path.join(hardlinkFixture.source, "server.js");
  await writeFile(original, "server\n");
  await link(original, path.join(hardlinkFixture.source, "server-copy.js"));
  await assert.rejects(
    copyStagingInputs({ stagingRoot: hardlinkFixture.staging, policy, inputs: [{ label: "hardlink", source: hardlinkFixture.source, destination: "web/standalone" }] }),
    { code: "STAGING_HARD_LINK_FORBIDDEN" },
  );
});

test("build plan invokes exact pnpm through exact Node in a private checkout and records order", async () => {
  const workspace = { checkoutRoot: "/private/build/checkout", homeRoot: "/private/build/home", tempRoot: "/private/build/tmp", cacheRoot: "/private/build/cache", storeRoot: "/private/build/store", daemonDeployRoot: "/private/build/daemon", webDeployRoot: "/private/build/web" };
  const provenance = { buildContract: { environmentPolicy: { inherit: [], force: { CI: "1", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", npm_config_update_notifier: "false", OD_WEB_OUTPUT_MODE: "standalone" } } } };
  const plan = createBuildPlan({ workspace, stagingRoot: "/stage", nodeBin: "/toolchain/node", pnpmBin: "/toolchain/pnpm.cjs", provenance });
  assert.equal(plan.commands[0].command, "/toolchain/node");
  assert.deepEqual(plan.commands[0].args, ["/toolchain/pnpm.cjs", "install", "--frozen-lockfile"]);
  assert.equal(plan.commands.find((entry) => entry.args.includes("@open-design/web") && entry.args.includes("build")).env.OD_WEB_OUTPUT_MODE, "standalone");
  assert.deepEqual(plan.commands.at(-1).args.slice(1, 5), ["--filter", "@open-design/web", "deploy", "--prod"]);
  const seen = [];
  await runBuildPlan(plan, async (command, args, options) => { seen.push({ command, args, options }); });
  assert.deepEqual(seen.map((entry) => entry.args), plan.commands.map((entry) => entry.args));
});

test("writes the producer-owned artifact manifest with O_EXCL semantics", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "open-design-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const json = "{\"files\":[]}\n";
  const produced = { json, inventory: { files: [{ path: "artifact-manifest.json", bytes: Buffer.byteLength(json) }] } };
  await writeArtifactManifest(root, produced);
  assert.equal(await readFile(path.join(root, "artifact-manifest.json"), "utf8"), json);
  await assert.rejects(writeArtifactManifest(root, produced), { code: "MANIFEST_WRITE_FAILED" });
});
