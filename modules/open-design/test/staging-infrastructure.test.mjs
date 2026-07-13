import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { copyStagingInputs } from "../src/staging-copier.mjs";
import { createBuildAttestation, createBuildPlan, runBuildPlan, validateSbom, writeArtifactManifest } from "../src/stage-open-design.mjs";
import { canonicalJsonBytes } from "../src/validate-artifact.mjs";

const moduleRoot = new URL("../", import.meta.url);
const policy = JSON.parse(await readFile(new URL("artifact-policy.json", moduleRoot), "utf8"));
const provenance = JSON.parse(await readFile(new URL("provenance.json", moduleRoot), "utf8"));
const sbom = JSON.parse(await readFile(new URL("fixtures/minimal-sbom.spdx.json", moduleRoot), "utf8"));

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

test("copies only the target node-pty prebuild and excludes foreign and third-party payloads", async (t) => {
  const { source, staging } = await roots(t);
  const files = [
    "node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
    "node_modules/node-pty/prebuilds/darwin-x64/pty.node",
    "node_modules/node-pty/prebuilds/win32-arm64/pty.node",
    "node_modules/node-pty/third_party/conpty/win10-arm64/conpty.dll",
  ];
  await Promise.all(files.map(async (relative) => {
    await mkdir(path.dirname(path.join(source, relative)), { recursive: true });
    await writeFile(path.join(source, relative), relative);
  }));
  const result = await copyStagingInputs({
    stagingRoot: staging,
    policy,
    target: { platform: "darwin", arch: "arm64" },
    inputs: [{ label: "daemon", source, destination: "runtime/daemon" }],
  });
  assert.deepEqual(result.copied.map((entry) => entry.path), ["runtime/daemon/node_modules/node-pty/prebuilds/darwin-arm64/pty.node"]);
  assert.equal(result.excluded.length, 3);
});

test("build plan invokes exact pnpm through exact Node in a private checkout and records order", async () => {
  const workspace = { checkoutRoot: "/private/build/checkout", homeRoot: "/private/build/home", tempRoot: "/private/build/tmp", cacheRoot: "/private/build/cache", storeRoot: "/private/build/store", daemonBundleRoot: "/private/build/daemon-bundle", daemonClosureRoot: "/private/build/daemon-closure", webDeployRoot: "/private/build/web", normalizedRoot: "/private/build/normalized" };
  const provenance = { buildContract: { environmentPolicy: { inherit: [], force: { CI: "1", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", npm_config_update_notifier: "false", OD_WEB_OUTPUT_MODE: "standalone" } } } };
  const plan = createBuildPlan({ workspace, stagingRoot: "/stage", nodeBin: "/toolchain/node", pnpmBin: "/toolchain/pnpm.cjs", provenance });
  assert.equal(plan.commands[0].command, "/toolchain/node");
  assert.deepEqual(plan.commands[0].args, ["/toolchain/pnpm.cjs", "install", "--frozen-lockfile"]);
  assert.equal(plan.commands.find((entry) => entry.args.includes("@open-design/web") && entry.args.includes("build")).env.OD_WEB_OUTPUT_MODE, "standalone");
  assert.deepEqual(plan.commands.at(-3).args, ["/toolchain/pnpm.cjs", "rebuild", "better-sqlite3", "node-pty"]);
  assert.deepEqual(plan.commands.at(-2).args.slice(0, 10), ["/toolchain/pnpm.cjs", "--filter", "@open-design/packaged", "exec", "esbuild", "/private/build/checkout/apps/daemon/dist/sidecar/index.js", "--bundle", "--platform=node", "--format=esm", "--target=node24"]);
  assert.ok(plan.commands.at(-2).args.includes("--banner:js=import { createRequire as __openDesignCreateRequire } from 'node:module'; const require = __openDesignCreateRequire(import.meta.url);"));
  assert.deepEqual(plan.commands.at(-2).args.filter((value) => value.startsWith("--external:")), ["--external:better-sqlite3", "--external:node-pty", "--external:blake3-wasm"]);
  assert.equal(plan.commands.at(-2).args.at(-2), "--outfile=/private/build/daemon-bundle/dist/sidecar/index.js");
  assert.equal(plan.commands.at(-2).args.at(-1), "--metafile=/private/build/daemon-bundle/esbuild-meta.json");
  assert.equal(plan.commands.at(-1).args.at(-2), "--outfile=/private/build/web/dist/sidecar/index.js");
  assert.equal(plan.commands.at(-1).args.at(-1), "--metafile=/private/build/web/esbuild-meta.json");
  const seen = [];
  await runBuildPlan(plan, async (command, args, options) => { seen.push({ command, args, options }); });
  assert.deepEqual(seen.map((entry) => entry.args), plan.commands.map((entry) => entry.args));
});

test("produces identical attestation bytes across private paths, times, and native ctimes", async () => {
  const makeWorkspace = (root) => ({
    root,
    checkoutRoot: `${root}/checkout`, homeRoot: `${root}/home`, tempRoot: `${root}/tmp`, cacheRoot: `${root}/cache`, storeRoot: `${root}/store`,
    daemonBundleRoot: `${root}/daemon-bundle`, daemonClosureRoot: `${root}/daemon-closure`, webDeployRoot: `${root}/web`, normalizedRoot: `${root}/normalized`,
  });
  const verification = { toolchain: {
    nodeVersion: "v24.14.1", nodeAbi: "137", platform: "darwin", arch: "arm64", nodeExecutableSha256: "a".repeat(64),
    pnpmVersion: "10.33.2", pnpmExecutableSha256: "b".repeat(64),
  } };
  const sbomEvidence = validateSbom({ sbom, sha256: "c".repeat(64), provenance, policy });
  const create = async (root, sourceCtime) => {
    const workspace = makeWorkspace(root);
    const plan = createBuildPlan({ workspace, stagingRoot: "/staging", nodeBin: "/toolchain/node", pnpmBin: "/toolchain/pnpm.cjs", provenance });
    const commandEvidence = await runBuildPlan(plan, async () => undefined, verification.toolchain.nodeExecutableSha256);
    const normalization = {
      outputs: [
        { role: "next-standalone", prefix: "web/standalone", symlinksMaterialized: 1, hardlinksMaterialized: 0, virtualStorePackagesHoisted: 0, nativeOrigins: [] },
        { role: "web-sidecar-closure", prefix: "runtime/packages/web-sidecar", symlinksMaterialized: 1, hardlinksMaterialized: 0, virtualStorePackagesHoisted: 0, nativeOrigins: [] },
        { role: "daemon-esm-bundle-external-closure", prefix: "runtime/daemon", symlinksMaterialized: 0, hardlinksMaterialized: 0, virtualStorePackagesHoisted: 0, nativeOrigins: [{ path: "addon.node", sha256: "d".repeat(64), sourceCtime, mode: "0644" }] },
      ],
      daemonClosure: { bundleSha256: "e".repeat(64), metafileSha256: "f".repeat(64), metafileInputCount: 1, externalAllowlist: ["better-sqlite3", "node-pty", "blake3-wasm"], files: [{ path: "dist/sidecar/index.js", sha256: "e".repeat(64) }] },
    };
    return createBuildAttestation({
      provenance, verification, environment: plan.environment, commandEvidence,
      postBuild: { checkedAt: sourceCtime, buildStartedAt: sourceCtime, requiredOutputs: [`${workspace.checkoutRoot}/apps/web/.next/standalone`, `${workspace.checkoutRoot}/apps/web/.next/static`, workspace.daemonBundleRoot, workspace.webDeployRoot] },
      normalization,
      nativeInventory: [{ packageName: "better-sqlite3", path: "runtime/daemon/addon.node", format: "node-addon", platform: "darwin", arch: "arm64", nodeAbi: "137", libc: "none", binaryFormat: "mach-o", resourceClass: "native-binary", mode: "0644", sha256: "d".repeat(64), sourceCtime, freshFromBuild: true, load: null }],
      runtimeVerification: { method: "sealed-candidate-loopback-v1", candidateMustBeSealed: true, entries: [{ entryPath: "runtime/daemon/dist/sidecar/index.js", entrySha256: "e".repeat(64) }, { entryPath: "runtime/packages/web-sidecar/dist/sidecar/index.js", entrySha256: "1".repeat(64) }], expected: { daemonVersion: "0.14.1", webStatusMinimum: 200 } },
      sbomEvidence,
      externalInputs: [{ name: "package.json", sha256: "2".repeat(64) }],
    });
  };
  const first = await create("/private/build-one", "2026-07-13T00:00:00.000Z");
  const second = await create("/private/build-two", "2026-07-13T01:00:00.000Z");
  assert.deepEqual(canonicalJsonBytes(first), canonicalJsonBytes(second));
  assert.equal(JSON.stringify(first).includes("sourceCtime"), false);
  assert.equal(JSON.stringify(first).includes("startedAt"), false);
  assert.equal(JSON.stringify(first).includes("pid"), false);
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

test("requires exact SBOM package, lock, checksum, license and notice coverage", () => {
  const valid = validateSbom({ sbom, sha256: "a".repeat(64), provenance, policy });
  assert.equal(valid.packages.length, 8);
  assert.equal(valid.documentSha256, "a".repeat(64));
  for (const mutate of [
    (value) => { value.packages = []; },
    (value) => { value.packages[0].checksums[0].checksumValue = "0".repeat(128); },
    (value) => { value.packages[0].licenseDeclared = "NOASSERTION"; },
    (value) => { value.packages[0].comment = "notice=UNKNOWN"; },
    (value) => { value.annotations[0].comment = "pnpm-lock.yaml sha256:unknown"; },
  ]) {
    const changed = structuredClone(sbom);
    mutate(changed);
    assert.throws(() => validateSbom({ sbom: changed, sha256: "a".repeat(64), provenance, policy }));
  }
});
