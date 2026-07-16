import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { encodeCanonicalCatalog, verifyModuleReleaseCatalog } from "../../../packages/module-release-trust/src/index.ts";
import { canonicalJsonBytes, digestInventory } from "../src/validate-artifact.mjs";
import {
  buildOpenDesignProductionPackageForTest,
  dryRunOpenDesignCatalogRefresh,
  dryRunOpenDesignProductionPackageForTest,
  OPEN_DESIGN_OFFICIAL_CHANNEL_FILENAME,
  OPEN_DESIGN_PRODUCTION_ARCHIVE_FILENAME,
  OPEN_DESIGN_PRODUCTION_CATALOG_FILENAME,
  OPEN_DESIGN_PRODUCTION_ENVELOPE_FILENAME,
  OPEN_DESIGN_PRODUCTION_METADATA_FILENAME,
  OPEN_DESIGN_PRODUCTION_VERSION,
  OPEN_DESIGN_PRODUCTION_VERSIONS,
  OPEN_DESIGN_REFRESH_FILE_NAMES,
  openDesignProductionFileNames,
  refreshOpenDesignProductionCatalog,
  verifyOpenDesignProductionBundle,
} from "../package/production-package.mjs";

const execFileAsync = promisify(execFile);
const productionCli = fileURLToPath(new URL("../package/production-cli.mjs", import.meta.url));
const supported = process.platform === "darwin" && process.arch === "arm64";
const RELEASE_TAG = "open-design-v0.14.5";
const RC_VERSION = "0.14.6-rc.1";
const RC_RELEASE_TAG = `open-design-v${RC_VERSION}`;
const ISSUED_AT = "2026-07-15T00:00:00.000Z";
const EXPIRES_AT = "2026-07-15T12:00:00.000Z";
const VERIFY_AT = Date.parse(ISSUED_AT) + 1_000;
const KEY_ACTIVE_FROM = "2026-07-01T00:00:00.000Z";
const KEY_ACTIVE_UNTIL = "2026-08-01T00:00:00.000Z";
const KEY_ID = "open-design-release-test-2026";
const REFRESH_ISSUED_AT = "2026-07-15T06:00:00.000Z";
const REFRESH_EXPIRES_AT = "2026-07-15T18:00:00.000Z";
const EXPIRED_REFRESH_ISSUED_AT = "2026-07-16T00:00:00.000Z";
const EXPIRED_REFRESH_EXPIRES_AT = "2026-07-16T12:00:00.000Z";
const OUTPUT_NAMES = [
  OPEN_DESIGN_PRODUCTION_ARCHIVE_FILENAME,
  OPEN_DESIGN_PRODUCTION_CATALOG_FILENAME,
  OPEN_DESIGN_PRODUCTION_ENVELOPE_FILENAME,
  OPEN_DESIGN_OFFICIAL_CHANNEL_FILENAME,
  OPEN_DESIGN_PRODUCTION_METADATA_FILENAME,
];

test("production package emits deterministic Catalog v2, exact-tag metadata, and installer-verified archive", { skip: !supported, timeout: 180_000 }, async (t) => {
  const fixture = await createFixture(t);
  const first = await packageFixture(fixture, path.join(fixture.root, "production-a"), { privateKeyFile: fixture.privateKeyFile });
  const second = await packageFixture(fixture, path.join(fixture.root, "production-b"), {
    privateKeyEnvName: "SIMULATOR_TEST_RELEASE_KEY",
    env: { SIMULATOR_TEST_RELEASE_KEY: fixture.privateKeyPem },
  });

  for (const name of OUTPUT_NAMES) {
    assert.deepEqual(await readFile(path.join(first.output, name)), await readFile(path.join(second.output, name)), `${name} must be byte-identical`);
    assert.equal((await lstat(path.join(first.output, name))).mode & 0o777, 0o600);
  }
  assert.equal((await lstat(first.output)).mode & 0o777, 0o700);
  assert.equal(OUTPUT_NAMES.filter((name) => name.endsWith(".tar.gz")).length, 1);
  assert.equal(JSON.stringify(first).includes("PRIVATE KEY"), false);
  assert.equal(JSON.stringify(first).includes(fixture.privateKeyFile), false);

  const catalogBytes = await readFile(first.catalogPath);
  const catalog = JSON.parse(catalogBytes.toString("utf8"));
  assert.equal(catalog.schemaVersion, 2);
  assert.equal(catalog.releases.length, 1);
  assert.deepEqual(Object.keys(catalog.releases[0]).sort(), ["artifactInstallMetadata", "artifactSizes", "hostVersionRange", "manifest"].sort());
  assert.equal(catalog.releases[0].manifest.version, OPEN_DESIGN_PRODUCTION_VERSION);
  assert.equal(catalog.releases[0].manifest.artifacts[0].url, `https://github.com/Jiachi-Deng/Simulator/releases/download/${RELEASE_TAG}/${OPEN_DESIGN_PRODUCTION_ARCHIVE_FILENAME}`);
  assert.equal(catalog.releases[0].artifactInstallMetadata[0].extractedManifestSha256, first.extractedManifestSha256);

  const wire = JSON.parse(await readFile(first.envelopePath, "utf8"));
  const verified = verifyModuleReleaseCatalog({
    schemaVersion: wire.schemaVersion,
    keyId: wire.keyId,
    catalogBytes: Uint8Array.from(Buffer.from(wire.catalogBytes, "base64")),
    signature: Uint8Array.from(Buffer.from(wire.signature, "base64")),
  }, {
    trustedKeys: [trustedKey(fixture)],
    state: { highestSequence: 0 },
    now: VERIFY_AT,
  });
  assert.equal(verified.ok, true);

  const official = JSON.parse(await readFile(first.officialChannelPath, "utf8"));
  assert.deepEqual(Object.keys(official).sort(), ["catalogUrl", "githubRelease", "moduleId", "platform", "schemaVersion", "trustedKeys", "version"].sort());
  assert.equal(official.catalogUrl, `https://github.com/Jiachi-Deng/Simulator/releases/download/${RELEASE_TAG}/${OPEN_DESIGN_PRODUCTION_ENVELOPE_FILENAME}`);
  assert.deepEqual(official.githubRelease, { owner: "Jiachi-Deng", repository: "Simulator", tag: RELEASE_TAG });
  assert.equal(official.trustedKeys[0].publicKey, Buffer.from(fixture.publicKeyBytes).toString("base64"));

  assert.deepEqual(await verifyBundle(first.output, fixture), {
    ok: true,
    moduleId: "org.simulator.open-design",
    version: "0.14.5",
    platform: "darwin-arm64",
    archiveSha256: first.archiveSha256,
    extractedManifestSha256: first.extractedManifestSha256,
    catalogState: { highestSequence: 1, latestIssuedAt: ISSUED_AT },
  });

  const cli = productionCli;
  const cliVerification = await execFileAsync(process.execPath, [
    cli,
    "--bundle-root", first.output,
    "--module-version", OPEN_DESIGN_PRODUCTION_VERSION,
    "--release-tag", RELEASE_TAG,
    "--key-id", KEY_ID,
    "--key-active-from", KEY_ACTIVE_FROM,
    "--key-active-until", KEY_ACTIVE_UNTIL,
    "--public-key-file", fixture.publicKeyFile,
    "--previous-sequence", "0",
    "--verification-time", String(VERIFY_AT),
    "--verify",
  ]);
  assert.deepEqual(JSON.parse(cliVerification.stdout), await verifyBundle(first.output, fixture));
});

test("RC production identity parameterizes every asset and rejects version/tag/Host drift", { skip: !supported, timeout: 180_000 }, async (t) => {
  const fixture = await createFixture(t);
  assert.deepEqual([...OPEN_DESIGN_PRODUCTION_VERSIONS], ["0.14.5", "0.14.6-rc.1", "0.14.6"]);
  const files = openDesignProductionFileNames(RC_VERSION);
  assert.match(openDesignProductionFileNames("0.14.6").archive, /0\.14\.6-darwin-arm64\.tar\.gz$/);
  const output = path.join(fixture.root, "production-rc");
  const options = {
    ...commonOptions(fixture),
    moduleVersion: RC_VERSION,
    releaseTag: RC_RELEASE_TAG,
    hostVersionRange: ">=0.12.0",
    output,
    privateKeyFile: fixture.privateKeyFile,
  };
  const result = await buildOpenDesignProductionPackageForTest(options, fixture.fixtureDigests);
  const actualNames = await import("node:fs/promises").then(({ readdir }) => readdir(result.output));
  assert.deepEqual(actualNames.sort(), [...files.production].sort());
  assert.equal(path.basename(result.archivePath), files.archive);
  assert.equal(path.basename(result.catalogPath), files.catalog);
  assert.equal(path.basename(result.envelopePath), files.envelope);
  assert.equal(path.basename(result.metadataPath), files.metadata);

  const catalog = JSON.parse(await readFile(result.catalogPath, "utf8"));
  assert.equal(catalog.releases[0].manifest.version, RC_VERSION);
  assert.equal(catalog.releases[0].manifest.artifacts[0].url, `https://github.com/Jiachi-Deng/Simulator/releases/download/${RC_RELEASE_TAG}/${files.archive}`);
  const official = JSON.parse(await readFile(result.officialChannelPath, "utf8"));
  assert.equal(official.version, RC_VERSION);
  assert.equal(official.catalogUrl, `https://github.com/Jiachi-Deng/Simulator/releases/download/${RC_RELEASE_TAG}/${files.envelope}`);
  assert.equal((await verifyOpenDesignProductionBundle({
    bundleRoot: result.output,
    moduleVersion: RC_VERSION,
    releaseTag: RC_RELEASE_TAG,
    trustedKey: trustedKey(fixture),
    priorTrustState: { highestSequence: 0 },
    verificationTimeMs: VERIFY_AT,
  })).version, RC_VERSION);
  const refreshPlan = await dryRunOpenDesignCatalogRefresh({
    bundleRoot: result.output,
    moduleVersion: RC_VERSION,
    releaseTag: RC_RELEASE_TAG,
    catalogSequence: 2,
    catalogIssuedAt: REFRESH_ISSUED_AT,
    catalogExpiresAt: REFRESH_EXPIRES_AT,
    keyId: KEY_ID,
    keyActiveFrom: KEY_ACTIVE_FROM,
    keyActiveUntil: KEY_ACTIVE_UNTIL,
    priorTrustState: { highestSequence: 1, latestIssuedAt: ISSUED_AT },
    verificationTimeMs: Date.parse(REFRESH_ISSUED_AT) + 1_000,
  });
  assert.equal(refreshPlan.version, RC_VERSION);
  assert.deepEqual(refreshPlan.plannedFiles, files.refresh);

  await assert.rejects(
    dryRunOpenDesignProductionPackageForTest({ ...options, output: undefined, moduleVersion: "0.14.7", releaseTag: "open-design-v0.14.7", privateKeyFile: undefined }, fixture.fixtureDigests),
    (error) => error.code === "PACKAGE_MODULE_VERSION_INVALID",
  );
  await assert.rejects(
    dryRunOpenDesignProductionPackageForTest({ ...options, output: undefined, releaseTag: "open-design-v0.14.6", privateKeyFile: undefined }, fixture.fixtureDigests),
    (error) => error.code === "PACKAGE_RELEASE_TAG_INVALID",
  );
  await assert.rejects(
    dryRunOpenDesignProductionPackageForTest({ ...options, output: undefined, hostVersionRange: ">=0.11.0", privateKeyFile: undefined }, fixture.fixtureDigests),
    (error) => error.code === "PACKAGE_CATALOG_INVALID",
  );
  assert.throws(() => openDesignProductionFileNames("0.14.7"), (error) => error.code === "PACKAGE_MODULE_VERSION_INVALID");

  await assert.rejects(execFileAsync(process.execPath, [
    productionCli,
    "--staging-root", fixture.stagingRoot,
    "--node-bin", fixture.nodeBin,
    "--node-license", fixture.nodeLicense,
    "--dry-run",
  ]), (error) => error.stderr.includes("PACKAGE_ARGUMENT_INVALID: required argument is missing: --module-version"));
});

test("production dry-run writes nothing and development staging fails closed", { skip: !supported, timeout: 120_000 }, async (t) => {
  const fixture = await createFixture(t);
  const absentOutput = path.join(fixture.root, "dry-run-must-not-exist");
  const plan = await dryRunOpenDesignProductionPackageForTest(commonOptions(fixture), fixture.fixtureDigests);
  assert.equal(plan.mode, "dry-run");
  assert.deepEqual(plan.writes, []);
  assert.equal(plan.signingRequired, true);
  assert.deepEqual(plan.plannedFiles, OUTPUT_NAMES);
  await assert.rejects(lstat(absentOutput), { code: "ENOENT" });

  const development = await createFixture(t, { distribution: { class: "development-local-only", nonPromotable: true } });
  await assert.rejects(
    dryRunOpenDesignProductionPackageForTest(commonOptions(development), development.fixtureDigests),
    (error) => error.code === "PACKAGE_PUBLIC_MARKER_INVALID",
  );
});

test("production signing key input is external, owner-only, and Ed25519", { skip: !supported, timeout: 180_000 }, async (t) => {
  const fixture = await createFixture(t);
  await chmod(fixture.privateKeyFile, 0o644);
  const weakOutput = path.join(fixture.root, "weak-key-output");
  await assert.rejects(packageFixture(fixture, weakOutput, { privateKeyFile: fixture.privateKeyFile }), (error) => error.code === "PACKAGE_KEY_PERMISSIONS_INVALID");
  await assert.rejects(lstat(weakOutput), { code: "ENOENT" });

  await chmod(fixture.privateKeyFile, 0o600);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" });
  const rsaFile = path.join(fixture.root, "rsa.pem");
  await writeFile(rsaFile, rsa, { mode: 0o600 });
  const rsaOutput = path.join(fixture.root, "rsa-output");
  await assert.rejects(packageFixture(fixture, rsaOutput, { privateKeyFile: rsaFile }), (error) => error.code === "PACKAGE_KEY_INVALID");
  await assert.rejects(lstat(rsaOutput), { code: "ENOENT" });

  const bothOutput = path.join(fixture.root, "both-output");
  await assert.rejects(packageFixture(fixture, bothOutput, {
    privateKeyFile: fixture.privateKeyFile,
    privateKeyEnvName: "SIMULATOR_TEST_RELEASE_KEY",
    env: { SIMULATOR_TEST_RELEASE_KEY: fixture.privateKeyPem },
  }), (error) => error.code === "PACKAGE_KEY_INVALID");
  await assert.rejects(lstat(bothOutput), { code: "ENOENT" });
});

test("production verification rejects catalog, signature, archive, and trust-root tampering", { skip: !supported, timeout: 180_000 }, async (t) => {
  const fixture = await createFixture(t);
  const result = await packageFixture(fixture, path.join(fixture.root, "tamper-bundle"), { privateKeyFile: fixture.privateKeyFile });

  const originalCatalog = await readFile(result.catalogPath);
  const alteredCatalog = Buffer.from(originalCatalog);
  alteredCatalog[0] ^= 0x01;
  await writeFile(result.catalogPath, alteredCatalog, { mode: 0o600 });
  await assert.rejects(verifyBundle(result.output, fixture), (error) => error.code === "PACKAGE_CATALOG_INVALID");
  await writeFile(result.catalogPath, originalCatalog, { mode: 0o600 });

  const originalEnvelope = await readFile(result.envelopePath);
  const wire = JSON.parse(originalEnvelope.toString("utf8"));
  const signature = Buffer.from(wire.signature, "base64");
  signature[0] ^= 0x01;
  wire.signature = signature.toString("base64");
  await writeFile(result.envelopePath, encodeCanonicalCatalog(wire), { mode: 0o600 });
  await assert.rejects(verifyBundle(result.output, fixture), (error) => error.code === "PACKAGE_CATALOG_INVALID");
  await writeFile(result.envelopePath, originalEnvelope, { mode: 0o600 });

  const originalArchive = await readFile(result.archivePath);
  const alteredArchive = Buffer.from(originalArchive);
  alteredArchive[alteredArchive.length - 1] ^= 0x01;
  await writeFile(result.archivePath, alteredArchive, { mode: 0o600 });
  await assert.rejects(verifyBundle(result.output, fixture), (error) => error.code === "PACKAGE_ARCHIVE_INVALID");
  await writeFile(result.archivePath, originalArchive, { mode: 0o600 });

  const attacker = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
  await assert.rejects(verifyOpenDesignProductionBundle({
    bundleRoot: result.output,
    releaseTag: RELEASE_TAG,
    trustedKey: { ...trustedKey(fixture), publicKey: Uint8Array.from(Buffer.from(attacker.x, "base64url")) },
    priorTrustState: { highestSequence: 0 },
    verificationTimeMs: VERIFY_AT,
  }), (error) => error.code === "PACKAGE_CATALOG_INVALID");
});

test("catalog refresh CLI preserves signed release bytes and emits only three replacement assets", { skip: !supported, timeout: 180_000 }, async (t) => {
  const fixture = await createFixture(t);
  const source = await packageFixture(fixture, path.join(fixture.root, "refresh-source"), { privateKeyFile: fixture.privateKeyFile });
  const output = path.join(fixture.root, "refresh-cli-output");
  const cli = productionCli;
  const command = await execFileAsync(process.execPath, [
    cli,
    "--bundle-root", source.output,
    "--output", output,
    "--release-tag", RELEASE_TAG,
    "--catalog-sequence", "2",
    "--catalog-issued-at", REFRESH_ISSUED_AT,
    "--catalog-expires-at", REFRESH_EXPIRES_AT,
    "--key-id", KEY_ID,
    "--key-active-from", KEY_ACTIVE_FROM,
    "--key-active-until", KEY_ACTIVE_UNTIL,
    "--previous-sequence", "1",
    "--previous-issued-at", ISSUED_AT,
    "--verification-time", String(Date.parse(REFRESH_ISSUED_AT) + 1_000),
    "--private-key-file", fixture.privateKeyFile,
    "--refresh",
  ]);
  const result = JSON.parse(command.stdout);
  assert.equal(result.output, await realpath(output));
  assert.equal(command.stdout.includes(fixture.privateKeyFile), false);
  assert.equal(command.stdout.includes("PRIVATE KEY"), false);
  const outputNames = await import("node:fs/promises").then(({ readdir }) => readdir(output));
  assert.deepEqual(outputNames.sort(), [...OPEN_DESIGN_REFRESH_FILE_NAMES].sort());
  assert.equal((await lstat(output)).mode & 0o777, 0o700);
  for (const name of OPEN_DESIGN_REFRESH_FILE_NAMES) assert.equal((await lstat(path.join(output, name))).mode & 0o777, 0o600);
  await assert.rejects(lstat(path.join(output, OPEN_DESIGN_PRODUCTION_ARCHIVE_FILENAME)), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(output, OPEN_DESIGN_OFFICIAL_CHANNEL_FILENAME)), { code: "ENOENT" });

  const oldCatalog = JSON.parse(await readFile(source.catalogPath, "utf8"));
  const newCatalogBytes = await readFile(path.join(output, OPEN_DESIGN_PRODUCTION_CATALOG_FILENAME));
  const newCatalog = JSON.parse(newCatalogBytes.toString("utf8"));
  assert.deepEqual(newCatalog.releases, oldCatalog.releases);
  assert.deepEqual(Buffer.from(encodeCanonicalCatalog(newCatalog.releases)), Buffer.from(encodeCanonicalCatalog(oldCatalog.releases)));
  assert.equal(newCatalog.sequence, 2);
  assert.equal(newCatalog.issuedAt, REFRESH_ISSUED_AT);
  assert.equal(newCatalog.expiresAt, REFRESH_EXPIRES_AT);
  assert.equal(await verifyRefreshedCatalog(output, fixture, REFRESH_ISSUED_AT), true);

  const sourceMetadata = JSON.parse(await readFile(source.metadataPath, "utf8"));
  const refreshedMetadata = JSON.parse(await readFile(path.join(output, OPEN_DESIGN_PRODUCTION_METADATA_FILENAME), "utf8"));
  assert.deepEqual(refreshedMetadata, { ...sourceMetadata, catalog: refreshedMetadata.catalog });
  assert.deepEqual(refreshedMetadata.archive, sourceMetadata.archive);
  assert.equal(refreshedMetadata.catalog.sequence, 2);
  assert.equal(refreshedMetadata.catalog.sha256, sha256(newCatalogBytes));
});

test("catalog refresh accepts a cryptographically valid expired source without skipping archive installation", { skip: !supported, timeout: 180_000 }, async (t) => {
  const fixture = await createFixture(t);
  const source = await packageFixture(fixture, path.join(fixture.root, "expired-refresh-source"), { privateKeyFile: fixture.privateKeyFile });
  const output = path.join(fixture.root, "expired-refresh-output");
  const result = await refreshOpenDesignProductionCatalog(refreshOptions(fixture, source.output, output, {
    catalogIssuedAt: EXPIRED_REFRESH_ISSUED_AT,
    catalogExpiresAt: EXPIRED_REFRESH_EXPIRES_AT,
  }));
  assert.equal(result.verifiedWithModuleInstaller, true);
  assert.equal(result.immutableArchiveSha256, source.archiveSha256);
  assert.equal(result.immutableExtractedManifestSha256, source.extractedManifestSha256);
  assert.equal(await verifyRefreshedCatalog(output, fixture, EXPIRED_REFRESH_ISSUED_AT), true);
});

test("catalog refresh rejects wrong key, archive tamper, and official-channel mismatch without output", { skip: !supported, timeout: 240_000 }, async (t) => {
  const fixture = await createFixture(t);
  const source = await packageFixture(fixture, path.join(fixture.root, "refresh-rejection-source"), { privateKeyFile: fixture.privateKeyFile });

  const attackerPair = generateKeyPairSync("ed25519");
  const attackerKey = path.join(fixture.root, "attacker.pem");
  await writeFile(attackerKey, attackerPair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const wrongKeyOutput = path.join(fixture.root, "wrong-key-refresh");
  await assert.rejects(refreshOpenDesignProductionCatalog({
    ...refreshOptions(fixture, source.output, wrongKeyOutput),
    privateKeyFile: attackerKey,
  }), (error) => error.code === "PACKAGE_REFRESH_KEY_MISMATCH");
  await assert.rejects(lstat(wrongKeyOutput), { code: "ENOENT" });

  const archiveBytes = await readFile(source.archivePath);
  const tamperedArchive = Buffer.from(archiveBytes);
  tamperedArchive[tamperedArchive.length - 1] ^= 0x01;
  await writeFile(source.archivePath, tamperedArchive, { mode: 0o600 });
  const archiveOutput = path.join(fixture.root, "archive-tamper-refresh");
  await assert.rejects(refreshOpenDesignProductionCatalog(refreshOptions(fixture, source.output, archiveOutput)), (error) => error.code === "PACKAGE_ARCHIVE_INVALID");
  await assert.rejects(lstat(archiveOutput), { code: "ENOENT" });
  await writeFile(source.archivePath, archiveBytes, { mode: 0o600 });

  const officialBytes = await readFile(source.officialChannelPath);
  const official = JSON.parse(officialBytes.toString("utf8"));
  official.githubRelease.tag = "other-tag";
  await writeFile(source.officialChannelPath, encodeCanonicalCatalog(official), { mode: 0o600 });
  const officialOutput = path.join(fixture.root, "official-mismatch-refresh");
  await assert.rejects(refreshOpenDesignProductionCatalog(refreshOptions(fixture, source.output, officialOutput)), (error) => error.code === "PACKAGE_OFFICIAL_CHANNEL_INVALID");
  await assert.rejects(lstat(officialOutput), { code: "ENOENT" });
  await writeFile(source.officialChannelPath, officialBytes, { mode: 0o600 });
});

test("catalog refresh rejects rollback/nonmonotonic state and dry-run leaves no partial output", { skip: !supported, timeout: 240_000 }, async (t) => {
  const fixture = await createFixture(t);
  const source = await packageFixture(fixture, path.join(fixture.root, "refresh-state-source"), { privateKeyFile: fixture.privateKeyFile });

  const rollbackOutput = path.join(fixture.root, "rollback-refresh");
  await assert.rejects(refreshOpenDesignProductionCatalog({
    ...refreshOptions(fixture, source.output, rollbackOutput),
    catalogSequence: 1,
  }), (error) => error.code === "PACKAGE_TRUST_STATE_INVALID");
  await assert.rejects(lstat(rollbackOutput), { code: "ENOENT" });

  const nonmonotonicOutput = path.join(fixture.root, "nonmonotonic-refresh");
  await assert.rejects(refreshOpenDesignProductionCatalog({
    ...refreshOptions(fixture, source.output, nonmonotonicOutput),
    catalogIssuedAt: ISSUED_AT,
    catalogExpiresAt: EXPIRES_AT,
    verificationTimeMs: VERIFY_AT,
  }), (error) => error.code === "PACKAGE_CATALOG_INVALID");
  await assert.rejects(lstat(nonmonotonicOutput), { code: "ENOENT" });

  const wrongStateOutput = path.join(fixture.root, "wrong-state-refresh");
  await assert.rejects(refreshOpenDesignProductionCatalog({
    ...refreshOptions(fixture, source.output, wrongStateOutput),
    priorTrustState: { highestSequence: 1, latestIssuedAt: "2026-07-14T23:59:59.000Z" },
  }), (error) => error.code === "PACKAGE_TRUST_STATE_INVALID");
  await assert.rejects(lstat(wrongStateOutput), { code: "ENOENT" });

  const plan = await dryRunOpenDesignCatalogRefresh(refreshOptions(fixture, source.output, undefined, { dryRun: true }));
  assert.equal(plan.mode, "refresh-dry-run");
  assert.deepEqual(plan.writes, []);
  assert.deepEqual(plan.plannedFiles, OPEN_DESIGN_REFRESH_FILE_NAMES);
  assert.equal(plan.immutableArchiveVerified, true);
  assert.equal(plan.verifiedWithModuleInstaller, true);

  const dryCli = productionCli;
  const dryResult = await execFileAsync(process.execPath, [
    dryCli,
    "--bundle-root", source.output,
    "--release-tag", RELEASE_TAG,
    "--catalog-sequence", "2",
    "--catalog-issued-at", REFRESH_ISSUED_AT,
    "--catalog-expires-at", REFRESH_EXPIRES_AT,
    "--key-id", KEY_ID,
    "--key-active-from", KEY_ACTIVE_FROM,
    "--key-active-until", KEY_ACTIVE_UNTIL,
    "--previous-sequence", "1",
    "--previous-issued-at", ISSUED_AT,
    "--refresh",
    "--dry-run",
  ]);
  assert.equal(JSON.parse(dryResult.stdout).mode, "refresh-dry-run");
});

function refreshOptions(fixture, bundleRoot, output, overrides = {}) {
  const { dryRun = false, ...values } = overrides;
  return {
    bundleRoot,
    ...(output === undefined ? {} : { output }),
    releaseTag: RELEASE_TAG,
    catalogSequence: 2,
    catalogIssuedAt: REFRESH_ISSUED_AT,
    catalogExpiresAt: REFRESH_EXPIRES_AT,
    keyId: KEY_ID,
    keyActiveFrom: KEY_ACTIVE_FROM,
    keyActiveUntil: KEY_ACTIVE_UNTIL,
    priorTrustState: { highestSequence: 1, latestIssuedAt: ISSUED_AT },
    verificationTimeMs: Date.parse(values.catalogIssuedAt ?? REFRESH_ISSUED_AT) + 1_000,
    ...(dryRun ? {} : { privateKeyFile: fixture.privateKeyFile }),
    ...values,
  };
}

async function verifyRefreshedCatalog(output, fixture, issuedAt) {
  const catalogBytes = await readFile(path.join(output, OPEN_DESIGN_PRODUCTION_CATALOG_FILENAME));
  const wire = JSON.parse(await readFile(path.join(output, OPEN_DESIGN_PRODUCTION_ENVELOPE_FILENAME), "utf8"));
  assert.deepEqual(Buffer.from(wire.catalogBytes, "base64"), catalogBytes);
  const result = verifyModuleReleaseCatalog({
    schemaVersion: wire.schemaVersion,
    keyId: wire.keyId,
    catalogBytes: Uint8Array.from(catalogBytes),
    signature: Uint8Array.from(Buffer.from(wire.signature, "base64")),
  }, {
    trustedKeys: [trustedKey(fixture)],
    state: { highestSequence: 1, latestIssuedAt: ISSUED_AT },
    now: Date.parse(issuedAt) + 1_000,
  });
  return result.ok;
}

async function createFixture(t, { distribution = { class: "public", nonPromotable: false } } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "open-design-production-test-"));
  await chmod(root, 0o700);
  t.after(async () => {
    await makeTreeWritable(root);
    await rm(root, { recursive: true, force: true });
  });

  const pair = generateKeyPairSync("ed25519");
  const privateKeyPem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const privateKeyFile = path.join(root, "release-key.pem");
  await writeFile(privateKeyFile, privateKeyPem, { mode: 0o600 });
  const publicJwk = pair.publicKey.export({ format: "jwk" });
  const publicKeyBytes = Uint8Array.from(Buffer.from(publicJwk.x, "base64url"));
  const publicKeyFile = path.join(root, "release-key.pub.pem");
  await writeFile(publicKeyFile, pair.publicKey.export({ format: "pem", type: "spki" }), { mode: 0o600 });

  const nodeBin = path.join(root, "node");
  const nodeSource = path.join(root, "node.c");
  await writeFile(nodeSource, `#include <stdio.h>\nint main(void) { puts("{\\\"nodeVersion\\\":\\\"v24.18.0\\\",\\\"nodeAbi\\\":\\\"137\\\",\\\"platform\\\":\\\"darwin\\\",\\\"arch\\\":\\\"arm64\\\"}"); return 0; }\n`);
  await execFileAsync("cc", [nodeSource, "-o", nodeBin]);
  await chmod(nodeBin, 0o700);
  const nodeSha256 = sha256(await readFile(nodeBin));
  const nodeLicense = path.join(root, "LICENSE");
  await writeFile(nodeLicense, "Node.js is licensed for use as follows:\n\nCopyright Node.js contributors.\n", { mode: 0o600 });
  const fixtureDigests = { nodeLicenseSha256: sha256(await readFile(nodeLicense)) };

  const stagingRoot = path.join(root, "staging");
  await mkdir(path.join(stagingRoot, "runtime/daemon/node_modules/node-pty/prebuilds/darwin-arm64"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(stagingRoot, "web/standalone"), { recursive: true, mode: 0o700 });
  const attestation = {
    distribution: structuredClone(distribution),
    toolchain: { nodeVersion: "24.18.0", nodeAbi: "137", platform: "darwin", arch: "arm64", nodeExecutableSha256: nodeSha256 },
  };
  await writeFile(path.join(stagingRoot, "build-attestation.json"), canonicalJsonBytes(attestation));
  await writeFile(path.join(stagingRoot, "runtime/daemon/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"), "spawn-helper-production-fixture\n");
  await writeFile(path.join(stagingRoot, "web/standalone/payload.bin"), deterministicBytes(8 * 1024));
  await writeSealedInventory(stagingRoot, distribution);
  await sealTree(stagingRoot);
  return { root, stagingRoot, nodeBin, nodeLicense, nodeSha256, fixtureDigests, privateKeyPem, privateKeyFile, publicKeyBytes, publicKeyFile };
}

function commonOptions(fixture) {
  return {
    stagingRoot: fixture.stagingRoot,
    nodeBin: fixture.nodeBin,
    nodeLicense: fixture.nodeLicense,
    releaseTag: RELEASE_TAG,
    catalogSequence: 1,
    catalogIssuedAt: ISSUED_AT,
    catalogExpiresAt: EXPIRES_AT,
    hostVersionRange: ">=0.1.0",
    keyId: KEY_ID,
    keyActiveFrom: KEY_ACTIVE_FROM,
    keyActiveUntil: KEY_ACTIVE_UNTIL,
    verificationTimeMs: VERIFY_AT,
  };
}

function packageFixture(fixture, output, keyOptions) {
  return buildOpenDesignProductionPackageForTest({ ...commonOptions(fixture), output, ...keyOptions }, fixture.fixtureDigests);
}

function trustedKey(fixture) {
  return { keyId: KEY_ID, publicKey: fixture.publicKeyBytes, activeFrom: KEY_ACTIVE_FROM, activeUntil: KEY_ACTIVE_UNTIL };
}

function verifyBundle(bundleRoot, fixture) {
  return verifyOpenDesignProductionBundle({
    bundleRoot,
    releaseTag: RELEASE_TAG,
    trustedKey: trustedKey(fixture),
    priorTrustState: { highestSequence: 0 },
    verificationTimeMs: VERIFY_AT,
  });
}

async function writeSealedInventory(stagingRoot, distribution) {
  const relativePaths = [
    "build-attestation.json",
    "runtime/daemon/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
    "web/standalone/payload.bin",
  ];
  const files = [];
  for (const relativePath of relativePaths) {
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
  await writeFile(path.join(stagingRoot, "artifact-manifest.json"), canonicalJsonBytes(inventory));
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
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    await chmod(root, 0o600);
    return;
  }
  await chmod(root, 0o700);
  const handle = await opendir(root);
  for await (const entry of handle) await makeTreeWritable(path.join(root, entry.name));
}

function deterministicBytes(size) {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 17 + 29) & 0xff;
  return bytes;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
