import assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { materializeBuildOutput } from "../src/materialize-build-output.mjs";

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
