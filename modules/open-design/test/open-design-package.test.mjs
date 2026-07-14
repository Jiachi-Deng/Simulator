import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, opendir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";

import { list as listTar } from "tar";

import { verifyModuleReleaseCatalog } from "../../../packages/module-release-trust/src/index.ts";
import { canonicalJsonBytes, digestInventory } from "../src/validate-artifact.mjs";
import {
  buildOpenDesignDevelopmentPackage,
  buildOpenDesignDevelopmentPackageForTest,
  DEVELOPMENT_ONLY_ARCHIVE_URL,
  DEVELOPMENT_ONLY_CATALOG_URL,
  OPEN_DESIGN_AUXILIARY_EXECUTABLES,
  OPEN_DESIGN_ENTRYPOINT,
  OPEN_DESIGN_MODULE_ID,
  OPEN_DESIGN_MODULE_PLATFORM,
  OPEN_DESIGN_MODULE_VERSION,
} from "../package/open-design-package.mjs";
import {
  DEVELOPMENT_ONLY_KEY_ACTIVE_FROM,
  DEVELOPMENT_ONLY_KEY_ACTIVE_UNTIL,
  DEVELOPMENT_ONLY_KEY_ID,
  DEVELOPMENT_ONLY_TEST_CATALOG_ISSUED_AT,
  developmentOnlyPublicKeyBytes,
} from "../package/development-key.mjs";

const execFileAsync = promisify(execFile);
const supported = process.platform === "darwin" && process.arch === "arm64";
const LONG_PAX_FIXTURE_PATH = "web/standalone/node_modules/.pnpm/next@16.2.6_@opentelemetry+api@1.9.1_@playwright+test@1.60.0_react-dom@18.3.1_react@18.3.1__react@18.3.1/node_modules/next/dist/build/static-paths/app/extract-pathname-route-param-segments-from-loader-tree.js";

test("development package is deterministic, signed, owner-only, and installer-verified", { skip: !supported, timeout: 120_000 }, async (t) => {
  const fixture = await createPackageFixture(t);
  const first = await packageFixture(fixture, path.join(fixture.root, "bundle-a"));
  const second = await packageFixture(fixture, path.join(fixture.root, "bundle-b"));
  const names = [
    path.basename(first.archivePath),
    "module-manifest.json",
    "catalog.json",
    "catalog-envelope.json",
    "artifact-metadata.json",
    "bundle-descriptor.json",
  ];
  for (const name of names) {
    assert.deepEqual(await readFile(path.join(first.output, name)), await readFile(path.join(second.output, name)), `${name} must be byte-identical`);
  }
  assert.equal(first.archiveSha256, second.archiveSha256);
  assert.equal(first.archiveSize, second.archiveSize);
  assert.equal(first.extractedManifestSha256, second.extractedManifestSha256);
  assert.equal(first.verifiedWithModuleInstaller, true);

  assert.equal((await lstat(first.output)).mode & 0o777, 0o700);
  for (const name of names) assert.equal((await lstat(path.join(first.output, name))).mode & 0o777, 0o600);

  const manifest = JSON.parse(await readFile(first.manifestPath, "utf8"));
  assert.deepEqual(manifest, {
    artifacts: [{
      auxiliaryExecutables: [...OPEN_DESIGN_AUXILIARY_EXECUTABLES],
      entrypoint: OPEN_DESIGN_ENTRYPOINT,
      platform: OPEN_DESIGN_MODULE_PLATFORM,
      sha256: first.archiveSha256,
      url: DEVELOPMENT_ONLY_ARCHIVE_URL,
    }],
    capabilities: ["workspace.read", "workspace.write"],
    id: OPEN_DESIGN_MODULE_ID,
    schemaVersion: 1,
    version: OPEN_DESIGN_MODULE_VERSION,
  });

  const descriptor = JSON.parse(await readFile(first.bundleDescriptorPath, "utf8"));
  assert.deepEqual(Object.keys(descriptor).sort(), ["developmentOnly", "install", "moduleId", "nonPromotable", "release", "resources", "schemaVersion", "trustedKey"]);
  assert.equal(descriptor.schemaVersion, 2);
  assert.equal(descriptor.developmentOnly, true);
  assert.equal(descriptor.nonPromotable, true);
  assert.equal(descriptor.moduleId, OPEN_DESIGN_MODULE_ID);
  assert.deepEqual(descriptor.release, { platform: OPEN_DESIGN_MODULE_PLATFORM, version: OPEN_DESIGN_MODULE_VERSION });
  assert.deepEqual(descriptor.install, { extractedManifestSha256: first.extractedManifestSha256, hostVersionRange: "*" });
  assert.deepEqual(Object.keys(descriptor.resources).sort(), ["archive", "catalog"]);
  assert.equal(Object.hasOwn(descriptor, "manifest"), false);
  assert.equal(descriptor.trustedKey.developmentOnly, true);
  assert.deepEqual({ url: descriptor.resources.catalog.url, path: descriptor.resources.catalog.path }, { url: DEVELOPMENT_ONLY_CATALOG_URL, path: "catalog-envelope.json" });
  assert.deepEqual({ url: descriptor.resources.archive.url, path: descriptor.resources.archive.path }, { url: DEVELOPMENT_ONLY_ARCHIVE_URL, path: path.basename(first.archivePath) });
  assert.equal(descriptor.resources.archive.sha256, first.archiveSha256);
  assert.equal(descriptor.resources.archive.size, first.archiveSize);
  const artifactMetadata = JSON.parse(await readFile(first.artifactMetadataPath, "utf8"));
  assert.equal(artifactMetadata.archiveSha256, first.archiveSha256);
  assert.equal(artifactMetadata.archiveSize, first.archiveSize);
  assert.equal(artifactMetadata.extractedManifestSha256, first.extractedManifestSha256);
  assert.deepEqual(artifactMetadata.provenance.velaPlatformPackage, {
    binaries: fixture.velaBinaries.map((binary) => ({
      packagePath: binary.packagePath,
      sha256: binary.sha256,
      size: binary.size,
      targetPath: binary.targetPath,
    })),
    developmentOnly: true,
    license: "UNLICENSED",
    nonPromotable: true,
    npmTarballSha1: fixture.velaFixtureDigests.tarballSha1,
    npmTarballSize: fixture.velaTarballSize,
    packageName: "@powerformer/vela-cli-darwin-arm64",
    verification: "npm-tarball-sha1-and-unpacked-binary-sha256",
    version: "0.0.21",
  });

  const catalogBytes = await readFile(first.catalogPath);
  const wire = JSON.parse(await readFile(first.envelopePath, "utf8"));
  assert.deepEqual(Buffer.from(wire.catalogBytes, "base64"), catalogBytes);
  const verified = verifyModuleReleaseCatalog({
    schemaVersion: wire.schemaVersion,
    keyId: wire.keyId,
    catalogBytes: Uint8Array.from(catalogBytes),
    signature: Uint8Array.from(Buffer.from(wire.signature, "base64")),
  }, {
    trustedKeys: [{
      keyId: DEVELOPMENT_ONLY_KEY_ID,
      publicKey: developmentOnlyPublicKeyBytes(),
      activeFrom: DEVELOPMENT_ONLY_KEY_ACTIVE_FROM,
      activeUntil: DEVELOPMENT_ONLY_KEY_ACTIVE_UNTIL,
    }],
    state: { highestSequence: 0 },
    now: Date.parse(DEVELOPMENT_ONLY_TEST_CATALOG_ISSUED_AT) + 1_000,
  });
  assert.equal(verified.ok, true);

  const cleanEnvironmentVerification = verifyModuleReleaseCatalog({
    schemaVersion: wire.schemaVersion,
    keyId: wire.keyId,
    catalogBytes: Uint8Array.from(catalogBytes),
    signature: Uint8Array.from(Buffer.from(wire.signature, "base64")),
  }, {
    trustedKeys: [{
      keyId: DEVELOPMENT_ONLY_KEY_ID,
      publicKey: developmentOnlyPublicKeyBytes(),
      activeFrom: DEVELOPMENT_ONLY_KEY_ACTIVE_FROM,
      activeUntil: DEVELOPMENT_ONLY_KEY_ACTIVE_UNTIL,
    }],
    state: { highestSequence: 0 },
    now: Date.parse(DEVELOPMENT_ONLY_TEST_CATALOG_ISSUED_AT) + (24 * 60 * 60 * 1_000) - 1_000,
  });
  assert.equal(cleanEnvironmentVerification.ok, true, "the deterministic M1 catalog must remain usable for clean-environment acceptance");

  const entries = [];
  await listTar({ file: first.archivePath, gzip: true, strict: true, onentry: (entry) => entries.push(entry) });
  const executablePaths = new Set([OPEN_DESIGN_ENTRYPOINT, ...OPEN_DESIGN_AUXILIARY_EXECUTABLES]);
  for (const entry of entries) {
    assert.match(entry.type, /^(?:Directory|File|OldFile)$/u);
    const archivePath = entry.path.replace(/\/$/u, "");
    assert.equal(entry.uid ?? 0, 0);
    assert.equal(entry.gid ?? 0, 0);
    assert.equal(entry.uname ?? "", "");
    assert.equal(entry.gname ?? "", "");
    assert.equal(entry.mtime?.getTime() ?? 0, 0);
    if (entry.type === "Directory") assert.equal(entry.mode, 0o700);
    else assert.equal(entry.mode, executablePaths.has(archivePath.slice("module/".length)) ? 0o700 : 0o600);
  }
  assert.deepEqual(
    entries.filter((entry) => entry.type !== "Directory" && entry.mode === 0o700).map((entry) => entry.path.slice("module/".length)).sort(),
    [...executablePaths].sort(),
  );
  const rawTypes = rawTarTypeFlags(await readFile(first.archivePath));
  assert.ok(rawTypes.includes("x"), "long fixture path must exercise deterministic POSIX PAX metadata");
  assert.equal(rawTypes.every((type) => type === "0" || type === "5" || type === "x"), true);
});

test("catalog signature and sealed staging tamper both fail closed", { skip: !supported, timeout: 120_000 }, async (t) => {
  const fixture = await createPackageFixture(t);
  const result = await packageFixture(fixture, path.join(fixture.root, "signed-bundle"));
  const wire = JSON.parse(await readFile(result.envelopePath, "utf8"));
  const signature = Buffer.from(wire.signature, "base64");
  signature[0] ^= 0x01;
  const tampered = verifyModuleReleaseCatalog({
    schemaVersion: 1,
    keyId: wire.keyId,
    catalogBytes: Uint8Array.from(Buffer.from(wire.catalogBytes, "base64")),
    signature: Uint8Array.from(signature),
  }, {
    trustedKeys: [{ keyId: DEVELOPMENT_ONLY_KEY_ID, publicKey: developmentOnlyPublicKeyBytes(), activeFrom: DEVELOPMENT_ONLY_KEY_ACTIVE_FROM, activeUntil: DEVELOPMENT_ONLY_KEY_ACTIVE_UNTIL }],
    state: { highestSequence: 0 },
    now: Date.parse(DEVELOPMENT_ONLY_TEST_CATALOG_ISSUED_AT) + 1_000,
  });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.diagnostics[0].code, "SIGNATURE_INVALID");

  const payload = path.join(fixture.stagingRoot, "web/standalone/payload.bin");
  const bytes = await readFile(payload);
  bytes[0] ^= 0x01;
  await chmod(payload, 0o600);
  await writeFile(payload, bytes);
  await chmod(payload, 0o444);
  const output = path.join(fixture.root, "tampered-staging-output");
  await assert.rejects(packageFixture(fixture, output), (error) => error.code === "PUBLISH_INVENTORY_MISMATCH");
  await assert.rejects(lstat(output), { code: "ENOENT" });
});

test("development authorization and permanent non-promotable markers are mandatory", { skip: !supported, timeout: 120_000 }, async (t) => {
  const fixture = await createPackageFixture(t);
  const unauthorized = path.join(fixture.root, "unauthorized");
  await assert.rejects(buildOpenDesignDevelopmentPackage({
    stagingRoot: fixture.stagingRoot,
    nodeBin: fixture.nodeBin,
    nodeLicense: fixture.nodeLicense,
    output: unauthorized,
  }), (error) => error.code === "PACKAGE_DEVELOPMENT_ONLY");
  await assert.rejects(lstat(unauthorized), { code: "ENOENT" });

  const publicFixture = await createPackageFixture(t, { distribution: { class: "public", nonPromotable: false } });
  const publicOutput = path.join(publicFixture.root, "public-output");
  await assert.rejects(packageFixture(publicFixture, publicOutput), (error) => error.code === "PACKAGE_DEVELOPMENT_MARKER_INVALID");
  await assert.rejects(lstat(publicOutput), { code: "ENOENT" });
});

async function createPackageFixture(t, { distribution = { class: "development-local-only", nonPromotable: true } } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "open-design-package-test-"));
  await chmod(root, 0o700);
  t.after(async () => {
    await makeTreeWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const nodeBin = path.join(root, "node");
  const nodeSource = path.join(root, "node.c");
  await writeFile(nodeSource, `#include <stdio.h>\nint main(void) { puts("{\\\"nodeVersion\\\":\\\"v24.14.1\\\",\\\"nodeAbi\\\":\\\"137\\\",\\\"platform\\\":\\\"darwin\\\",\\\"arch\\\":\\\"arm64\\\"}"); return 0; }\n`);
  await execFileAsync("cc", [nodeSource, "-o", nodeBin]);
  await chmod(nodeBin, 0o700);
  const nodeSha256 = sha256(await readFile(nodeBin));
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
  const velaBinaries = [
    { packagePath: "bin/vela", targetPath: "resources/open-design/bin/vela", size: fixtureMachO.length, sha256: fixtureBinarySha256 },
    { packagePath: "bin/libexec/opencode/opencode", targetPath: "resources/open-design/bin/libexec/opencode/opencode", size: fixtureMachO.length, sha256: fixtureBinarySha256 },
  ];

  const stagingRoot = path.join(root, "staging");
  await mkdir(path.join(stagingRoot, "runtime/daemon/node_modules/node-pty/prebuilds/darwin-arm64"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(stagingRoot, "web/standalone"), { recursive: true, mode: 0o700 });
  const attestation = {
    distribution: structuredClone(distribution),
    toolchain: {
      nodeVersion: "24.14.1",
      nodeAbi: "137",
      platform: "darwin",
      arch: "arm64",
      nodeExecutableSha256: nodeSha256,
    },
  };
  await writeFile(path.join(stagingRoot, "build-attestation.json"), canonicalJsonBytes(attestation));
  await writeFile(path.join(stagingRoot, "runtime/daemon/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"), Buffer.from("spawn-helper-fixture-2026-07-14\n"));
  await writeFile(path.join(stagingRoot, "web/standalone/payload.bin"), deterministicBytes(8 * 1024));
  await mkdir(path.dirname(path.join(stagingRoot, LONG_PAX_FIXTURE_PATH)), { recursive: true, mode: 0o700 });
  await writeFile(path.join(stagingRoot, LONG_PAX_FIXTURE_PATH), "pax-path-fixture\n");
  await writeSealedInventory(stagingRoot, distribution);
  await sealTree(stagingRoot);
  return {
    root,
    stagingRoot,
    nodeBin,
    nodeLicense,
    velaPlatformPackageRoot,
    velaPlatformTarball,
    velaTarballSize: tarballBytes.length,
    velaFixtureDigests,
    velaBinaries,
  };
}

async function writeSealedInventory(stagingRoot, distribution) {
  const paths = [
    "build-attestation.json",
    "runtime/daemon/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
    "web/standalone/payload.bin",
    LONG_PAX_FIXTURE_PATH,
  ];
  const files = [];
  for (const relativePath of paths) {
    const bytes = await readFile(path.join(stagingRoot, ...relativePath.split("/")));
    files.push({ path: relativePath, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const self = { path: "artifact-manifest.json", bytes: 0, sha256: "0".repeat(64) };
  files.push(self);
  const inventory = {
    schemaVersion: 1,
    distribution: structuredClone(distribution),
    target: { platform: "darwin", arch: "arm64", nodeAbi: "137" },
    files,
  };
  while (true) {
    const size = canonicalJsonBytes(inventory).length;
    if (self.bytes === size) break;
    self.bytes = size;
  }
  self.sha256 = digestInventory(inventory);
  const bytes = canonicalJsonBytes(inventory);
  assert.equal(bytes.length, self.bytes);
  await writeFile(path.join(stagingRoot, "artifact-manifest.json"), bytes);
}

async function sealTree(root) {
  async function visit(directory) {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(filename);
        await chmod(filename, 0o555);
      } else {
        await chmod(filename, filename.endsWith("spawn-helper") ? 0o555 : 0o444);
      }
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

function deterministicBytes(length) {
  const chunks = [];
  for (let index = 0; Buffer.concat(chunks).length < length; index += 1) chunks.push(createHash("sha256").update(`fixture-${index}`).digest());
  return Buffer.concat(chunks).subarray(0, length);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function rawTarTypeFlags(archiveBytes) {
  const tarBytes = gunzipSync(archiveBytes);
  const types = [];
  for (let offset = 0; offset + 512 <= tarBytes.length;) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim();
    const size = sizeText === "" ? 0 : Number.parseInt(sizeText, 8);
    types.push(String.fromCharCode(header[156]));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return types;
}
