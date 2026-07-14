import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, opendir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { ModuleInstaller } from "../../../packages/module-installer/src/index.ts";
import { canonicalJsonBytes, digestInventory } from "../src/validate-artifact.mjs";
import {
  buildOpenDesignDevelopmentPackage,
  buildOpenDesignDevelopmentPackageForTest,
} from "../package/open-design-package.mjs";
import { DEVELOPMENT_ONLY_TEST_CATALOG_ISSUED_AT } from "../package/development-key.mjs";

const execFileAsync = promisify(execFile);
const supported = process.platform === "darwin" && process.arch === "arm64";

test("symlink and oversize staging fixtures fail without publishing output", { skip: !supported, timeout: 120_000 }, async (t) => {
  const symlinkFixture = await createFixture(t);
  await chmod(symlinkFixture.stagingRoot, 0o700);
  await symlink("web/standalone/payload.bin", path.join(symlinkFixture.stagingRoot, "payload-link"));
  await chmod(symlinkFixture.stagingRoot, 0o555);
  const symlinkOutput = path.join(symlinkFixture.root, "symlink-output");
  await assert.rejects(packageFixture(symlinkFixture, symlinkOutput), (error) => error.code === "PACKAGE_STAGING_ENTRY_INVALID");
  await assert.rejects(lstat(symlinkOutput), { code: "ENOENT" });

  const oversizeFixture = await createFixture(t);
  await chmod(oversizeFixture.stagingRoot, 0o700);
  const oversized = path.join(oversizeFixture.stagingRoot, "oversized.bin");
  await writeFile(oversized, "x");
  await truncate(oversized, 64 * 1024 * 1024 + 1);
  await chmod(oversized, 0o444);
  await chmod(oversizeFixture.stagingRoot, 0o555);
  const oversizeOutput = path.join(oversizeFixture.root, "oversize-output");
  await assert.rejects(packageFixture(oversizeFixture, oversizeOutput), (error) => error.code === "PACKAGE_FILE_LIMIT_EXCEEDED");
  await assert.rejects(lstat(oversizeOutput), { code: "ENOENT" });
});

test("tampered archive is rejected by the existing ModuleInstaller", { skip: !supported, timeout: 120_000 }, async (t) => {
  const fixture = await createFixture(t);
  const result = await packageFixture(fixture, path.join(fixture.root, "bundle"));
  const archive = await readFile(result.archivePath);
  archive[Math.floor(archive.length / 2)] ^= 0x01;
  const tamperedArchive = path.join(fixture.root, "tampered.tar.gz");
  await writeFile(tamperedArchive, archive, { mode: 0o600 });
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  const artifactMetadata = JSON.parse(await readFile(result.artifactMetadataPath, "utf8"));
  const installer = new ModuleInstaller(path.join(fixture.root, "tampered-installer"));
  await assert.rejects(installer.install({
    archivePath: tamperedArchive,
    descriptor: {
      verified: true,
      manifest,
      artifact: manifest.artifacts[0],
      extractedManifestSha256: artifactMetadata.extractedManifestSha256,
      format: "tar.gz",
    },
  }), (error) => error.code === "ARCHIVE_HASH_MISMATCH");
});

test("Vela package provenance and fixed production digests fail closed", { skip: !supported, timeout: 120_000 }, async (t) => {
  const fixture = await createFixture(t);
  const fixedPolicyOutput = path.join(fixture.root, "fixed-policy-output");
  await assert.rejects(buildOpenDesignDevelopmentPackage({
    stagingRoot: fixture.stagingRoot,
    nodeBin: fixture.nodeBin,
    nodeLicense: fixture.nodeLicense,
    velaPlatformPackageRoot: fixture.velaPlatformPackageRoot,
    velaPlatformTarball: fixture.velaPlatformTarball,
    catalogIssuedAt: DEVELOPMENT_ONLY_TEST_CATALOG_ISSUED_AT,
    output: fixedPolicyOutput,
    developmentLocalOnly: true,
    allowUnreviewedLocalArtifact: true,
  }), (error) => error.code === "PACKAGE_VELA_TARBALL_DIGEST_MISMATCH");
  await assert.rejects(lstat(fixedPolicyOutput), { code: "ENOENT" });

  const originalVela = await readFile(fixture.velaPath);
  originalVela[0] ^= 0x01;
  await writeFile(fixture.velaPath, originalVela, { mode: 0o700 });
  const tamperedBinaryOutput = path.join(fixture.root, "tampered-vela-output");
  await assert.rejects(packageFixture(fixture, tamperedBinaryOutput), (error) => error.code === "PACKAGE_VELA_INVALID" || error.code === "PACKAGE_VELA_DIGEST_MISMATCH");
  await assert.rejects(lstat(tamperedBinaryOutput), { code: "ENOENT" });

  await writeFile(fixture.velaPath, await readFile(fixture.opencodePath), { mode: 0o700 });
  const packageJsonPath = path.join(fixture.velaPlatformPackageRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  packageJson.license = "MIT";
  await writeFile(packageJsonPath, JSON.stringify(packageJson), { mode: 0o600 });
  const licenseOutput = path.join(fixture.root, "license-output");
  await assert.rejects(packageFixture(fixture, licenseOutput), (error) => error.code === "PACKAGE_VELA_INVALID");
  await assert.rejects(lstat(licenseOutput), { code: "ENOENT" });
});

async function createFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "open-design-package-security-"));
  await chmod(root, 0o700);
  t.after(async () => {
    await makeTreeWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const nodeBin = path.join(root, "node");
  const source = path.join(root, "node.c");
  await writeFile(source, `#include <stdio.h>\nint main(void) { puts("{\\\"nodeVersion\\\":\\\"v24.14.1\\\",\\\"nodeAbi\\\":\\\"137\\\",\\\"platform\\\":\\\"darwin\\\",\\\"arch\\\":\\\"arm64\\\"}"); return 0; }\n`);
  await execFileAsync("cc", [source, "-o", nodeBin]);
  await chmod(nodeBin, 0o700);
  const nodeLicense = path.join(root, "LICENSE");
  await writeFile(nodeLicense, "Node.js is licensed for use as follows:\n\nCopyright Node.js contributors.\n", { mode: 0o600 });
  const velaPlatformPackageRoot = path.join(root, "vela-platform/package");
  const velaPath = path.join(velaPlatformPackageRoot, "bin/vela");
  const opencodePath = path.join(velaPlatformPackageRoot, "bin/libexec/opencode/opencode");
  await mkdir(path.dirname(opencodePath), { recursive: true, mode: 0o700 });
  const fixtureMachO = await readFile(nodeBin);
  await writeFile(velaPath, fixtureMachO, { mode: 0o700 });
  await writeFile(opencodePath, fixtureMachO, { mode: 0o700 });
  await writeFile(path.join(velaPlatformPackageRoot, "package.json"), JSON.stringify({
    name: "@powerformer/vela-cli-darwin-arm64",
    version: "0.0.21",
    license: "UNLICENSED",
    os: ["darwin"],
    cpu: ["arm64"],
    files: ["bin/vela", "bin/libexec/opencode/opencode"],
  }));
  const velaPlatformTarball = path.join(root, "powerformer-vela-cli-darwin-arm64-0.0.21.tgz");
  const tarballBytes = gzipSync(Buffer.from("test-only Vela platform tarball fixture\n"), { level: 9 });
  await writeFile(velaPlatformTarball, tarballBytes, { mode: 0o600 });
  const fixtureBinarySha256 = sha256(fixtureMachO);
  const velaFixtureDigests = {
    tarballSha1: createHash("sha1").update(tarballBytes).digest("hex"),
    velaSha256: fixtureBinarySha256,
    opencodeSha256: fixtureBinarySha256,
  };
  const stagingRoot = path.join(root, "staging");
  await mkdir(path.join(stagingRoot, "runtime/daemon/node_modules/node-pty/prebuilds/darwin-arm64"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(stagingRoot, "web/standalone"), { recursive: true, mode: 0o700 });
  const distribution = { class: "development-local-only", nonPromotable: true };
  const attestation = {
    distribution,
    toolchain: {
      nodeVersion: "24.14.1",
      nodeAbi: "137",
      platform: "darwin",
      arch: "arm64",
      nodeExecutableSha256: sha256(await readFile(nodeBin)),
    },
  };
  await writeFile(path.join(stagingRoot, "build-attestation.json"), canonicalJsonBytes(attestation));
  await writeFile(path.join(stagingRoot, "runtime/daemon/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"), "spawn-helper\n");
  await writeFile(path.join(stagingRoot, "web/standalone/payload.bin"), createHash("sha512").update("payload").digest());
  const filePaths = ["build-attestation.json", "runtime/daemon/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper", "web/standalone/payload.bin"];
  const files = [];
  for (const relativePath of filePaths) {
    const bytes = await readFile(path.join(stagingRoot, ...relativePath.split("/")));
    files.push({ path: relativePath, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const self = { path: "artifact-manifest.json", bytes: 0, sha256: "0".repeat(64) };
  files.push(self);
  const inventory = { schemaVersion: 1, distribution, target: { platform: "darwin", arch: "arm64", nodeAbi: "137" }, files };
  while (true) {
    const size = canonicalJsonBytes(inventory).length;
    if (self.bytes === size) break;
    self.bytes = size;
  }
  self.sha256 = digestInventory(inventory);
  await writeFile(path.join(stagingRoot, "artifact-manifest.json"), canonicalJsonBytes(inventory));
  await sealTree(stagingRoot);
  return {
    root,
    nodeBin,
    nodeLicense,
    stagingRoot,
    velaPlatformPackageRoot,
    velaPlatformTarball,
    velaPath,
    opencodePath,
    velaFixtureDigests,
  };
}

async function sealTree(root) {
  async function visit(directory) {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(filename);
        await chmod(filename, 0o555);
      } else await chmod(filename, filename.endsWith("spawn-helper") ? 0o555 : 0o444);
    }
  }
  await visit(root);
  await chmod(root, 0o555);
}

async function makeTreeWritable(root) {
  const info = await lstat(root).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (info == null) return;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    await chmod(root, 0o600);
    return;
  }
  await chmod(root, 0o700);
  const handle = await opendir(root);
  for await (const entry of handle) await makeTreeWritable(path.join(root, entry.name));
}

function packageFixture(fixture, output) {
  return buildOpenDesignDevelopmentPackageForTest({
    stagingRoot: fixture.stagingRoot,
    nodeBin: fixture.nodeBin,
    nodeLicense: fixture.nodeLicense,
    velaPlatformPackageRoot: fixture.velaPlatformPackageRoot,
    velaPlatformTarball: fixture.velaPlatformTarball,
    output,
    developmentLocalOnly: true,
    allowUnreviewedLocalArtifact: true,
  }, fixture.velaFixtureDigests);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
