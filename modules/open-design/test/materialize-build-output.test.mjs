import assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { hoistMaterializedPnpmAliases, materializeBuildOutput, normalizeRequiredServerFiles, normalizeStandaloneServer } from "../src/materialize-build-output.mjs";

async function fixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "open-design-materialize-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const source = path.join(parent, "source");
  const destination = path.join(parent, "destination");
  await mkdir(path.join(source, "store/package"), { recursive: true });
  return { parent, source, destination };
}

test("materializes contained package links and records the original native digest", async (t) => {
  const { source, destination } = await fixture(t);
  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await writeFile(path.join(source, "store/package/addon.node"), "native-bytes");
  await mkdir(path.join(source, "node_modules"));
  await symlink("../store/package", path.join(source, "node_modules/example"));
  const result = await materializeBuildOutput({ sourceRoot: source, destinationRoot: destination, buildStartedAtMs: started });
  const output = path.join(destination, "node_modules/example/addon.node");
  assert.equal((await lstat(output)).isSymbolicLink(), false);
  assert.equal(await readFile(output, "utf8"), "native-bytes");
  assert.equal(result.symlinksMaterialized, 1);
  assert.deepEqual(result.nativeOrigins.map((entry) => entry.path), ["node_modules/example/addon.node", "store/package/addon.node"]);
  assert.match(result.nativeOrigins[0].sha256, /^[0-9a-f]{64}$/u);
});

test("rejects escaping symlinks and stale native sources while unlinking private hard links", async (t) => {
  const escaping = await fixture(t);
  await writeFile(path.join(escaping.parent, "outside"), "outside");
  await symlink("../outside", path.join(escaping.source, "escape"));
  await assert.rejects(materializeBuildOutput({ sourceRoot: escaping.source, destinationRoot: escaping.destination, buildStartedAtMs: 0 }), { code: "MATERIALIZE_SYMLINK_ESCAPE" });

  const hardlinked = await fixture(t);
  const original = path.join(hardlinked.source, "file.js");
  await writeFile(original, "content");
  await link(original, path.join(hardlinked.source, "alias.js"));
  const hardlinkResult = await materializeBuildOutput({ sourceRoot: hardlinked.source, destinationRoot: hardlinked.destination, buildStartedAtMs: 0 });
  assert.equal(hardlinkResult.hardlinksMaterialized, 2);
  assert.equal((await lstat(path.join(hardlinked.destination, "file.js"))).nlink, 1);
  assert.equal((await lstat(path.join(hardlinked.destination, "alias.js"))).nlink, 1);

  const stale = await fixture(t);
  await writeFile(path.join(stale.source, "stale.node"), "native");
  await assert.rejects(materializeBuildOutput({ sourceRoot: stale.source, destinationRoot: stale.destination, buildStartedAtMs: Date.now() + 10_000 }), { code: "NATIVE_OUTPUT_STALE" });
});

test("materializes pnpm virtual-store aliases at the root for symlink-free ESM resolution", async (t) => {
  const { source, destination } = await fixture(t);
  await mkdir(path.join(source, "node_modules/.pnpm/node_modules/zod"), { recursive: true });
  await writeFile(path.join(source, "node_modules/.pnpm/node_modules/zod/index.js"), "export const ok = true;\n");
  const result = await materializeBuildOutput({ sourceRoot: source, destinationRoot: destination, buildStartedAtMs: 0 });
  const hoisted = await hoistMaterializedPnpmAliases({ materialized: result, buildStartedAtMs: 0 });
  assert.equal(hoisted.packagesHoisted, 1);
  assert.equal(result.virtualStorePackagesHoisted, 1);
  assert.equal(await readFile(path.join(destination, "node_modules/zod/index.js"), "utf8"), "export const ok = true;\n");
  assert.equal((await lstat(path.join(destination, "node_modules/zod/index.js"))).nlink, 1);
});

const privateRoots = {
  checkoutRoot: "/private/tmp/build-123/checkout",
  workspaceRoot: "/private/tmp/build-123",
  sourceRoot: "/private/tmp/build-123/checkout/apps/web/.next/standalone",
};

function serverWithConfig(config) {
  return `const nextConfig = ${JSON.stringify(config)};\nmodule.exports = { nextConfig };\n`;
}

test("rewrites standalone nextConfig paths and removes build-machine origins", () => {
  const input = serverWithConfig({ outputFileTracingRoot: privateRoots.checkoutRoot, turbopack: { root: privateRoots.checkoutRoot }, allowedDevOrigins: ["http://192.168.1.12:3000", "http://localhost:3000"] });
  const output = normalizeStandaloneServer(input, privateRoots);
  assert.equal(output, 'const nextConfig = {"outputFileTracingRoot":".","turbopack":{"root":"."},"allowedDevOrigins":[]};\nmodule.exports = { nextConfig };\n');
  assert.equal(output.includes("192.168.1.12"), false);
  assert.equal(output.includes("/private/tmp"), false);
});

test("parses braces and escaped quotes inside JSON strings", () => {
  const input = serverWithConfig({ outputFileTracingRoot: privateRoots.checkoutRoot, turbopack: { root: privateRoots.checkoutRoot }, allowedDevOrigins: ["http://10.0.0.4:3000"], note: "brace } and quote \\\"" });
  const output = normalizeStandaloneServer(input, privateRoots);
  assert.match(output, /"note":/u);
  assert.equal(output.includes("brace } and quote"), true);
});

test("fails closed for duplicate, missing, malformed, and wrong-type nextConfig", () => {
  const valid = { outputFileTracingRoot: privateRoots.checkoutRoot, turbopack: { root: privateRoots.checkoutRoot }, allowedDevOrigins: [] };
  assert.throws(() => normalizeStandaloneServer(`${serverWithConfig(valid)}const nextConfig = {};`, privateRoots), { code: "MATERIALIZE_NEXT_CONFIG_INVALID" });
  assert.throws(() => normalizeStandaloneServer("module.exports = {};", privateRoots), { code: "MATERIALIZE_NEXT_CONFIG_INVALID" });
  assert.throws(() => normalizeStandaloneServer('const nextConfig = {"outputFileTracingRoot":"/private/tmp/build-123/checkout",};', privateRoots), { code: "MATERIALIZE_NEXT_CONFIG_INVALID" });
  assert.throws(() => normalizeStandaloneServer(serverWithConfig({ ...valid, turbopack: "/private/tmp/build-123/checkout" }), privateRoots), { code: "MATERIALIZE_NEXT_CONFIG_INVALID" });
  assert.throws(() => normalizeStandaloneServer(serverWithConfig({ ...valid, outputFileTracingRoot: "/private/attacker/checkout" }), privateRoots), { code: "MATERIALIZE_NEXT_CONFIG_INVALID" });
});

test("rejects extra private absolute paths and produces deterministic output", () => {
  const malicious = { outputFileTracingRoot: privateRoots.checkoutRoot, turbopack: { root: privateRoots.checkoutRoot }, allowedDevOrigins: [], extra: `${privateRoots.workspaceRoot}/secret` };
  assert.throws(() => normalizeStandaloneServer(serverWithConfig(malicious), privateRoots), { code: "MATERIALIZE_PRIVATE_PATH_RESIDUAL" });
  const input = serverWithConfig({ outputFileTracingRoot: privateRoots.checkoutRoot, turbopack: { root: privateRoots.checkoutRoot }, allowedDevOrigins: ["http://172.16.0.8:3000"] });
  assert.equal(normalizeStandaloneServer(input, privateRoots), normalizeStandaloneServer(input, privateRoots));
});

test("normalizes required-server-files build roots and removes build-only metadata", () => {
  const input = JSON.stringify({
    version: 1,
    appDir: `${privateRoots.checkoutRoot}/apps/web`,
    config: {
      outputFileTracingRoot: privateRoots.checkoutRoot,
      turbopack: { root: `${privateRoots.checkoutRoot}/apps/web` },
      experimental: { turbopackRoot: privateRoots.checkoutRoot },
      configOrigin: `${privateRoots.checkoutRoot}/apps/web/next.config.mjs`,
    },
    configFile: `${privateRoots.checkoutRoot}/apps/web/next.config.mjs`,
    files: ["apps/web/server.js"],
  });
  const output = JSON.parse(normalizeRequiredServerFiles(input, privateRoots));
  assert.equal(output.appDir, "apps/web");
  assert.equal(output.config.outputFileTracingRoot, ".");
  assert.equal(output.config.turbopack.root, ".");
  assert.equal(output.config.experimental.turbopackRoot, ".");
  assert.equal(Object.hasOwn(output.config, "configOrigin"), false);
  assert.equal(Object.hasOwn(output, "configFile"), false);
  assert.doesNotMatch(JSON.stringify(output), /private\/tmp/u);
});

test("fails closed for malformed or incomplete required-server-files JSON", () => {
  assert.throws(() => normalizeRequiredServerFiles("{}", privateRoots), { code: "MATERIALIZE_REQUIRED_SERVER_FILES_INVALID" });
  assert.throws(() => normalizeRequiredServerFiles("{\"appDir\":\"apps/web\",\"config\":null}", privateRoots), { code: "MATERIALIZE_REQUIRED_SERVER_FILES_INVALID" });
  assert.throws(() => normalizeRequiredServerFiles("{\"appDir\":\"apps/web\",\"config\":{\"outputFileTracingRoot\":\"/private/attacker\"}}", privateRoots), { code: "MATERIALIZE_NEXT_CONFIG_INVALID" });
  assert.throws(() => normalizeRequiredServerFiles("not-json", privateRoots), { code: "MATERIALIZE_REQUIRED_SERVER_FILES_INVALID" });
});

test("materializes standalone server and rejects private path residue in any text output", async (t) => {
  const { source, destination } = await fixture(t);
  await mkdir(path.join(source, "apps/web"), { recursive: true });
  await mkdir(path.join(source, "apps/web/.next"), { recursive: true });
  await writeFile(path.join(source, "apps/web/server.js"), serverWithConfig({ outputFileTracingRoot: privateRoots.checkoutRoot, turbopack: { root: privateRoots.checkoutRoot }, allowedDevOrigins: ["http://192.168.1.12:3000"] }));
  await writeFile(path.join(source, "apps/web/.next/required-server-files.json"), JSON.stringify({ appDir: `${privateRoots.checkoutRoot}/apps/web`, config: { outputFileTracingRoot: privateRoots.checkoutRoot, configOrigin: `${privateRoots.checkoutRoot}/apps/web/next.config.mjs` }, configFile: `${privateRoots.checkoutRoot}/apps/web/next.config.mjs` }));
  await writeFile(path.join(source, "apps/web/other.js"), "const clean = true;\n");
  await materializeBuildOutput({ sourceRoot: source, destinationRoot: destination, buildStartedAtMs: 0, privateRoots });
  const server = await readFile(path.join(destination, "apps/web/server.js"), "utf8");
  const required = JSON.parse(await readFile(path.join(destination, "apps/web/.next/required-server-files.json"), "utf8"));
  assert.match(server, /outputFileTracingRoot":"\."/u);
  assert.equal(required.appDir, "apps/web");
  assert.equal(required.config.outputFileTracingRoot, ".");
  assert.doesNotMatch(server, /private|192\.168\.1\.12/u);
});
