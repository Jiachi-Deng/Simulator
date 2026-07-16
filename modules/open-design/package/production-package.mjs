import {
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseModuleManifest } from "../../../packages/module-contract/src/index.ts";
import { decodeCatalogEnvelope } from "../../../packages/module-downloader/src/wire.ts";
import { hashExtractedTree } from "../../../packages/module-installer/src/filesystem.ts";
import { ModuleInstaller, DEFAULT_INSTALL_LIMITS } from "../../../packages/module-installer/src/index.ts";
import {
  encodeCanonicalCatalog,
  verifyModuleReleaseCatalog,
} from "../../../packages/module-release-trust/src/index.ts";

import { loadRuntimeSchemas, validateArtifact } from "../src/validate-artifact.mjs";
import { stagingAssert, stagingFail } from "../src/staging-error.mjs";
import {
  OPEN_DESIGN_AUXILIARY_EXECUTABLES,
  OPEN_DESIGN_ENTRYPOINT,
  OPEN_DESIGN_EXECUTABLES,
  OPEN_DESIGN_MIN_HOST_VERSION_RANGE,
  OPEN_DESIGN_MODULE_ID,
  OPEN_DESIGN_MODULE_PLATFORM,
  OPEN_DESIGN_PACKAGE_PRIMITIVES,
} from "./open-design-package.mjs";

/*
 * Clean-room reference mapping (concepts only; no Proma code copied):
 * - Proma/apps/electron/scripts/package-open-design-host-app.ts: dry-run planning,
 *   deterministic archive production, and catalog-bound archive size/hash.
 * - Proma/apps/electron/scripts/sign-host-app-catalog.ts: separate signing and
 *   verification stages, Ed25519 signatures, and fail-closed tamper handling.
 * - Proma/apps/electron/scripts/inspect-host-app-release-readiness.ts: exact-tag
 *   GitHub Release URL checks instead of mutable latest/download URLs.
 * Simulator adds its own sealed-staging, public-rights, Catalog v2 tree-hash,
 * owner-only secret input, and ModuleInstaller round-trip requirements.
 */

const {
  assertAbsent,
  assertDirectoryContainsOnly,
  collectArchiveEntries,
  copyRegularInput,
  copySnapshotTree,
  createDeterministicArchive,
  createNodeRuntimePolicy,
  fsyncDirectory,
  hashRegularFile,
  inspectNodeInput,
  normalizeAndVerifyAssembly,
  preflightSealedStaging,
  prepareOutputTarget,
  readJsonFromSnapshot,
  sha256Bytes,
  verifyBundleFiles,
  verifySealedStaging,
  writeExclusiveBytes,
} = OPEN_DESIGN_PACKAGE_PRIMITIVES;

export const OPEN_DESIGN_PRODUCTION_VERSION = "0.14.5";
export const OPEN_DESIGN_PRODUCTION_VERSIONS = Object.freeze([
  "0.14.5",
  "0.14.6-rc.1",
  "0.14.6",
]);
export const OPEN_DESIGN_RELEASE_OWNER = "Jiachi-Deng";
export const OPEN_DESIGN_RELEASE_REPOSITORY = "Simulator";
export const OPEN_DESIGN_OFFICIAL_CHANNEL_FILENAME = "open-design-official-channel.json";

export function openDesignProductionFileNames(moduleVersion = OPEN_DESIGN_PRODUCTION_VERSION) {
  const version = normalizeModuleVersion(moduleVersion);
  const archive = `${OPEN_DESIGN_MODULE_ID}-${version}-${OPEN_DESIGN_MODULE_PLATFORM}.tar.gz`;
  const catalog = `${OPEN_DESIGN_MODULE_ID}-${version}-catalog-v2.json`;
  const envelope = `${OPEN_DESIGN_MODULE_ID}-${version}-catalog-v2-envelope.json`;
  const metadata = `${OPEN_DESIGN_MODULE_ID}-${version}-release-metadata.json`;
  return Object.freeze({
    archive,
    catalog,
    envelope,
    officialChannel: OPEN_DESIGN_OFFICIAL_CHANNEL_FILENAME,
    metadata,
    production: Object.freeze([archive, catalog, envelope, OPEN_DESIGN_OFFICIAL_CHANNEL_FILENAME, metadata]),
    refresh: Object.freeze([catalog, envelope, metadata]),
  });
}

const DEFAULT_PRODUCTION_FILES = openDesignProductionFileNames();
export const OPEN_DESIGN_PRODUCTION_ARCHIVE_FILENAME = DEFAULT_PRODUCTION_FILES.archive;
export const OPEN_DESIGN_PRODUCTION_CATALOG_FILENAME = DEFAULT_PRODUCTION_FILES.catalog;
export const OPEN_DESIGN_PRODUCTION_ENVELOPE_FILENAME = DEFAULT_PRODUCTION_FILES.envelope;
export const OPEN_DESIGN_PRODUCTION_METADATA_FILENAME = DEFAULT_PRODUCTION_FILES.metadata;

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = path.dirname(packageRoot);
const runtimeSourceRoot = path.join(moduleRoot, "runtime");
const FIXED_NODE_POLICY = createNodeRuntimePolicy({
  version: "24.18.0",
  licenseSha256: "148eacf7863ef4329224a29398623077200a27194aa075569faf4a0a85566ca5",
});
const TAG_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,254})$/u;
const KEY_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const HOST_VERSION_RANGE_PATTERN = /^(?:\*|(?:\^|~|>=|<=|>|<)?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\s+(?:>=|<=|>|<)(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))?)$/u;
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
export const OPEN_DESIGN_REFRESH_FILE_NAMES = DEFAULT_PRODUCTION_FILES.refresh;
const REFERENCE_MAPPING = Object.freeze([
  "Proma package-open-design-host-app: dry-run, deterministic archive, catalog-bound size/hash",
  "Proma sign-host-app-catalog: separate Ed25519 sign/verify and tamper rejection",
  "Proma inspect-host-app-release-readiness: exact-tag GitHub Release URLs",
]);

export async function dryRunOpenDesignProductionPackage(options = {}) {
  return preflightProductionPackage(options, { nodePolicy: FIXED_NODE_POLICY, validatePublicStaging: validatePublicStagingFromRepository });
}

export async function buildOpenDesignProductionPackage(options = {}) {
  return buildProductionPackage(options, { nodePolicy: FIXED_NODE_POLICY, validatePublicStaging: validatePublicStagingFromRepository });
}

// Test-only seam for compact, self-contained sealed fixtures. Neither the
// production entrypoint nor CLI can bypass the repository public-rights gate.
export async function dryRunOpenDesignProductionPackageForTest(options, fixtureDigests) {
  return preflightProductionPackage(options, {
    nodePolicy: createNodeRuntimePolicy({ version: "24.18.0", licenseSha256: fixtureDigests?.nodeLicenseSha256 }),
    validatePublicStaging: async () => undefined,
  });
}

export async function buildOpenDesignProductionPackageForTest(options, fixtureDigests) {
  return buildProductionPackage(options, {
    nodePolicy: createNodeRuntimePolicy({ version: "24.18.0", licenseSha256: fixtureDigests?.nodeLicenseSha256 }),
    validatePublicStaging: async () => undefined,
  });
}

export async function dryRunOpenDesignCatalogRefresh(options = {}) {
  const normalized = normalizeRefreshOptions(options, { requireSigningKey: false });
  const source = await inspectRefreshSource(normalized);
  return Object.freeze({
    mode: "refresh-dry-run",
    writes: Object.freeze([]),
    moduleId: OPEN_DESIGN_MODULE_ID,
    version: normalized.moduleVersion,
    platform: OPEN_DESIGN_MODULE_PLATFORM,
    releaseTag: normalized.releaseTag,
    previousCatalog: Object.freeze({
      sequence: source.catalog.sequence,
      issuedAt: source.catalog.issuedAt,
      expiresAt: source.catalog.expiresAt,
    }),
    nextCatalog: Object.freeze({
      sequence: normalized.catalogSequence,
      issuedAt: normalized.catalogIssuedAt,
      expiresAt: normalized.catalogExpiresAt,
    }),
    plannedFiles: normalized.files.refresh,
    immutableArchiveVerified: true,
    verifiedWithModuleInstaller: true,
    signingRequired: true,
  });
}

export async function refreshOpenDesignProductionCatalog(options = {}) {
  const normalized = normalizeRefreshOptions(options, { requireSigningKey: true });
  const source = await inspectRefreshSource(normalized);
  const signing = await loadSigningKey(normalized);
  stagingAssert(Buffer.from(signing.publicKey).equals(Buffer.from(source.trustedKey.publicKey)), "PACKAGE_REFRESH_KEY_MISMATCH", "external signing key does not match the official channel trust root");

  const catalog = {
    schemaVersion: 2,
    sequence: normalized.catalogSequence,
    issuedAt: normalized.catalogIssuedAt,
    expiresAt: normalized.catalogExpiresAt,
    releases: source.catalog.releases,
  };
  const oldReleaseBytes = encodeCanonicalCatalog(source.catalog.releases);
  const newReleaseBytes = encodeCanonicalCatalog(catalog.releases);
  stagingAssert(Buffer.from(oldReleaseBytes).equals(Buffer.from(newReleaseBytes)), "PACKAGE_REFRESH_RELEASE_CHANGED", "refresh must preserve the signed release records byte-for-byte");
  const catalogBytes = encodeCanonicalCatalog(catalog);
  const signature = Uint8Array.from(sign(null, catalogBytes, signing.privateKey));
  const envelopeBytes = encodeCanonicalCatalog({
    schemaVersion: 1,
    keyId: normalized.keyId,
    catalogBytes: Buffer.from(catalogBytes).toString("base64"),
    signature: Buffer.from(signature).toString("base64"),
  });
  const verified = verifyCatalogEnvelope(envelopeBytes, source.trustedKey, normalized.priorTrustState, normalized.verificationTimeMs);
  stagingAssert(verified.catalog.schemaVersion === 2
    && Buffer.from(encodeCanonicalCatalog(verified.catalog.releases)).equals(Buffer.from(oldReleaseBytes)),
  "PACKAGE_REFRESH_RELEASE_CHANGED", "verified refresh catalog changed the signed release records");

  const releaseMetadata = {
    ...source.metadata,
    catalog: {
      ...source.metadata.catalog,
      path: normalized.files.envelope,
      canonicalCatalogPath: normalized.files.catalog,
      url: `${normalized.releaseBaseUrl}${normalized.files.envelope}`,
      schemaVersion: 2,
      sequence: normalized.catalogSequence,
      issuedAt: normalized.catalogIssuedAt,
      expiresAt: normalized.catalogExpiresAt,
      sha256: sha256Bytes(catalogBytes),
      size: catalogBytes.byteLength,
    },
  };
  const releaseMetadataBytes = encodeCanonicalCatalog(releaseMetadata);
  const outputTarget = await prepareOutputTarget(normalized.output);
  let published = false;
  try {
    const bundleRoot = path.join(outputTarget.transactionRoot, "bundle");
    await mkdir(bundleRoot, { mode: 0o700 });
    await writeExclusiveBytes(path.join(bundleRoot, normalized.files.catalog), catalogBytes);
    await writeExclusiveBytes(path.join(bundleRoot, normalized.files.envelope), envelopeBytes);
    await writeExclusiveBytes(path.join(bundleRoot, normalized.files.metadata), releaseMetadataBytes);
    const expectedFiles = new Map([
      [normalized.files.catalog, { size: catalogBytes.byteLength, sha256: sha256Bytes(catalogBytes) }],
      [normalized.files.envelope, { size: envelopeBytes.byteLength, sha256: sha256Bytes(envelopeBytes) }],
      [normalized.files.metadata, { size: releaseMetadataBytes.byteLength, sha256: sha256Bytes(releaseMetadataBytes) }],
    ]);
    await verifyBundleFiles(bundleRoot, expectedFiles);
    await fsyncDirectory(bundleRoot);
    await assertDirectoryContainsOnly(outputTarget.transactionRoot, ["bundle"]);
    await assertAbsent(outputTarget.finalRoot, "PACKAGE_OUTPUT_EXISTS");
    await rename(bundleRoot, outputTarget.finalRoot).catch((error) => stagingFail("PACKAGE_PUBLISH_FAILED", error.message));
    published = true;
    await chmod(outputTarget.finalRoot, 0o700);
    await rmdir(outputTarget.transactionRoot).catch((error) => stagingFail("PACKAGE_CLEANUP_FAILED", error.message));
    await fsyncDirectory(outputTarget.parent);
    await verifyBundleFiles(outputTarget.finalRoot, expectedFiles);
    return Object.freeze({
      output: outputTarget.finalRoot,
      version: normalized.moduleVersion,
      catalogPath: path.join(outputTarget.finalRoot, normalized.files.catalog),
      envelopePath: path.join(outputTarget.finalRoot, normalized.files.envelope),
      metadataPath: path.join(outputTarget.finalRoot, normalized.files.metadata),
      catalogSha256: sha256Bytes(catalogBytes),
      sequence: normalized.catalogSequence,
      issuedAt: normalized.catalogIssuedAt,
      expiresAt: normalized.catalogExpiresAt,
      immutableArchiveSha256: source.artifact.sha256,
      immutableExtractedManifestSha256: source.installMetadata.extractedManifestSha256,
      verifiedWithModuleInstaller: true,
    });
  } catch (error) {
    if (published) await rm(outputTarget.finalRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(outputTarget.transactionRoot, { recursive: true, force: true }).catch(() => undefined);
    await fsyncDirectory(outputTarget.parent).catch(() => undefined);
    throw error;
  }
}

async function preflightProductionPackage(options, policy) {
  const normalized = normalizeBuildOptions(options, { requireSigningKey: false });
  const staged = await inspectProductionInputs(normalized, policy);
  return Object.freeze({
    mode: "dry-run",
    writes: Object.freeze([]),
    moduleId: OPEN_DESIGN_MODULE_ID,
    version: normalized.moduleVersion,
    platform: OPEN_DESIGN_MODULE_PLATFORM,
    releaseTag: normalized.releaseTag,
    releaseBaseUrl: normalized.releaseBaseUrl,
    plannedFiles: normalized.files.production,
    stagingFiles: staged.snapshot.size - 1,
    signingRequired: true,
    publicRightsValidated: true,
  });
}

async function buildProductionPackage(options, policy) {
  const normalized = normalizeBuildOptions(options, { requireSigningKey: true });
  const staged = await inspectProductionInputs(normalized, policy);
  const signing = await loadSigningKey(normalized);
  const outputTarget = await prepareOutputTarget(normalized.output);
  let published = false;
  try {
    const assemblyParent = path.join(outputTarget.transactionRoot, "assembly");
    const assemblyRoot = path.join(assemblyParent, "module");
    const bundleRoot = path.join(outputTarget.transactionRoot, "bundle");
    const installerRoot = path.join(outputTarget.transactionRoot, "installer");
    await mkdir(assemblyRoot, { recursive: true, mode: 0o700 });
    await mkdir(bundleRoot, { mode: 0o700 });

    await copySnapshotTree(normalized.stagingRoot, assemblyRoot, staged.snapshot);
    await copyRegularInput(path.join(runtimeSourceRoot, "open-design-launcher"), path.join(assemblyRoot, OPEN_DESIGN_ENTRYPOINT), {
      mode: 0o700,
      maxBytes: DEFAULT_INSTALL_LIMITS.maxExecutableFileBytes,
      label: OPEN_DESIGN_ENTRYPOINT,
    });
    await copyRegularInput(path.join(runtimeSourceRoot, "open-design-launcher.mjs"), path.join(assemblyRoot, "runtime/open-design-launcher.mjs"), {
      mode: 0o600,
      maxBytes: DEFAULT_INSTALL_LIMITS.maxFileBytes,
      label: "runtime/open-design-launcher.mjs",
    });
    await copyRegularInput(normalized.nodeBin, path.join(assemblyRoot, "runtime/node/bin/node"), {
      mode: 0o700,
      maxBytes: DEFAULT_INSTALL_LIMITS.maxExecutableFileBytes,
      expectedSha256: staged.node.sha256,
      label: "runtime/node/bin/node",
    });
    await copyRegularInput(normalized.nodeLicense, path.join(assemblyRoot, "runtime/node/LICENSE"), {
      mode: 0o600,
      maxBytes: DEFAULT_INSTALL_LIMITS.maxFileBytes,
      expectedSha256: staged.node.licenseSha256,
      label: "runtime/node/LICENSE",
    });
    await normalizeAndVerifyAssembly(assemblyRoot);
    await verifySealedStaging(normalized.stagingRoot, staged.inventory);

    const tree = await hashExtractedTree(assemblyRoot, DEFAULT_INSTALL_LIMITS, undefined, () => {}, new Set(OPEN_DESIGN_EXECUTABLES));
    const archiveEntries = await collectArchiveEntries(assemblyParent, tree.files);
    const archivePath = path.join(bundleRoot, normalized.files.archive);
    await createDeterministicArchive({ assemblyParent, archivePath, entries: archiveEntries });
    const archiveInfo = await lstat(archivePath);
    const archiveSha256 = await hashRegularFile(archivePath, DEFAULT_INSTALL_LIMITS.maxArchiveBytes, "production archive");

    const archiveUrl = `${normalized.releaseBaseUrl}${normalized.files.archive}`;
    const catalogUrl = `${normalized.releaseBaseUrl}${normalized.files.envelope}`;
    const manifest = createProductionManifest(normalized.moduleVersion, archiveSha256, archiveUrl);
    const catalog = {
      schemaVersion: 2,
      sequence: normalized.catalogSequence,
      issuedAt: normalized.catalogIssuedAt,
      expiresAt: normalized.catalogExpiresAt,
      releases: [{
        manifest,
        artifactSizes: [{ platform: OPEN_DESIGN_MODULE_PLATFORM, size: archiveInfo.size }],
        hostVersionRange: normalized.hostVersionRange,
        artifactInstallMetadata: [{ platform: OPEN_DESIGN_MODULE_PLATFORM, extractedManifestSha256: tree.sha256 }],
      }],
    };
    const catalogBytes = encodeCanonicalCatalog(catalog);
    const signature = Uint8Array.from(sign(null, catalogBytes, signing.privateKey));
    const envelopeBytes = encodeCanonicalCatalog({
      schemaVersion: 1,
      keyId: normalized.keyId,
      catalogBytes: Buffer.from(catalogBytes).toString("base64"),
      signature: Buffer.from(signature).toString("base64"),
    });
    const trustedKey = {
      keyId: normalized.keyId,
      publicKey: signing.publicKey,
      activeFrom: normalized.keyActiveFrom,
      ...(normalized.keyActiveUntil === undefined ? {} : { activeUntil: normalized.keyActiveUntil }),
    };
    verifyCatalogEnvelope(envelopeBytes, trustedKey, normalized.priorTrustState, normalized.verificationTimeMs);

    const officialChannel = {
      schemaVersion: 1,
      moduleId: OPEN_DESIGN_MODULE_ID,
      version: normalized.moduleVersion,
      platform: OPEN_DESIGN_MODULE_PLATFORM,
      catalogUrl,
      githubRelease: {
        owner: OPEN_DESIGN_RELEASE_OWNER,
        repository: OPEN_DESIGN_RELEASE_REPOSITORY,
        tag: normalized.releaseTag,
      },
      trustedKeys: [{
        keyId: normalized.keyId,
        publicKey: Buffer.from(signing.publicKey).toString("base64"),
        activeFrom: normalized.keyActiveFrom,
        ...(normalized.keyActiveUntil === undefined ? {} : { activeUntil: normalized.keyActiveUntil }),
      }],
    };
    const officialChannelBytes = encodeCanonicalCatalog(officialChannel);
    const releaseMetadata = {
      schemaVersion: 1,
      distribution: { class: "public", nonPromotable: false },
      module: { id: OPEN_DESIGN_MODULE_ID, version: normalized.moduleVersion, platform: OPEN_DESIGN_MODULE_PLATFORM },
      githubRelease: { owner: OPEN_DESIGN_RELEASE_OWNER, repository: OPEN_DESIGN_RELEASE_REPOSITORY, tag: normalized.releaseTag },
      catalog: {
        path: normalized.files.envelope,
        canonicalCatalogPath: normalized.files.catalog,
        url: catalogUrl,
        schemaVersion: 2,
        sequence: normalized.catalogSequence,
        issuedAt: normalized.catalogIssuedAt,
        expiresAt: normalized.catalogExpiresAt,
        sha256: sha256Bytes(catalogBytes),
        size: catalogBytes.byteLength,
      },
      archive: {
        path: normalized.files.archive,
        url: archiveUrl,
        sha256: archiveSha256,
        size: archiveInfo.size,
        extractedManifestSha256: tree.sha256,
      },
      hostVersionRange: normalized.hostVersionRange,
      hostIntegration: {
        generatedConfig: OPEN_DESIGN_OFFICIAL_CHANNEL_FILENAME,
        sourceCopyTarget: "apps/electron/resources/open-design-official-channel.json",
        packagedRuntimeTarget: "Contents/Resources/app/dist/resources/open-design-official-channel.json",
        copyPipeline: "apps/electron/scripts/copy-assets.ts",
      },
      catalogRefreshPolicy: {
        catalogTtlMaximumHours: 24,
        ciRefreshCadenceMaximumHours: 12,
        releaseTagMustRemain: normalized.releaseTag,
        archiveAssetImmutable: true,
        monotonicFields: ["sequence", "issuedAt"],
        replaceReleaseAssets: [
          ...normalized.files.refresh,
        ],
      },
      trustedKey: {
        keyId: normalized.keyId,
        publicKey: Buffer.from(signing.publicKey).toString("base64"),
        activeFrom: normalized.keyActiveFrom,
        ...(normalized.keyActiveUntil === undefined ? {} : { activeUntil: normalized.keyActiveUntil }),
      },
      provenance: {
        signing: "external-ed25519-private-key",
        runtimeAuthority: "compile-time-official-channel-config",
        nodeRuntime: {
          version: staged.node.version,
          executableSha256: staged.node.sha256,
          licenseSha256: staged.node.licenseSha256,
        },
        referenceMapping: [...REFERENCE_MAPPING],
      },
    };
    const releaseMetadataBytes = encodeCanonicalCatalog(releaseMetadata);

    await writeExclusiveBytes(path.join(bundleRoot, normalized.files.catalog), catalogBytes);
    await writeExclusiveBytes(path.join(bundleRoot, normalized.files.envelope), envelopeBytes);
    await writeExclusiveBytes(path.join(bundleRoot, OPEN_DESIGN_OFFICIAL_CHANNEL_FILENAME), officialChannelBytes);
    await writeExclusiveBytes(path.join(bundleRoot, normalized.files.metadata), releaseMetadataBytes);

    const installResult = await installAndVerify({
      archivePath,
      installerRoot,
      manifest,
      extractedManifestSha256: tree.sha256,
    });
    stagingAssert(installResult.archiveSha256 === archiveSha256, "PACKAGE_INSTALLER_ROUND_TRIP_FAILED", "installer returned a different archive SHA-256");

    const expectedFiles = expectedProductionFiles({
      archiveInfo,
      archiveSha256,
      catalogBytes,
      envelopeBytes,
      officialChannelBytes,
      releaseMetadataBytes,
      files: normalized.files,
    });
    await verifyBundleFiles(bundleRoot, expectedFiles);
    await fsyncDirectory(bundleRoot);
    await rm(assemblyParent, { recursive: true, force: true });
    await rm(installerRoot, { recursive: true, force: true });
    await assertDirectoryContainsOnly(outputTarget.transactionRoot, ["bundle"]);
    await assertAbsent(outputTarget.finalRoot, "PACKAGE_OUTPUT_EXISTS");
    await rename(bundleRoot, outputTarget.finalRoot).catch((error) => stagingFail("PACKAGE_PUBLISH_FAILED", error.message));
    published = true;
    await chmod(outputTarget.finalRoot, 0o700);
    await rmdir(outputTarget.transactionRoot).catch((error) => stagingFail("PACKAGE_CLEANUP_FAILED", error.message));
    await fsyncDirectory(outputTarget.parent);
    await verifyBundleFiles(outputTarget.finalRoot, expectedFiles);
    await verifyOpenDesignProductionBundle({
      bundleRoot: outputTarget.finalRoot,
      moduleVersion: normalized.moduleVersion,
      releaseTag: normalized.releaseTag,
      trustedKey,
      priorTrustState: normalized.priorTrustState,
      verificationTimeMs: normalized.verificationTimeMs,
    });

    return Object.freeze({
      output: outputTarget.finalRoot,
      version: normalized.moduleVersion,
      archivePath: path.join(outputTarget.finalRoot, normalized.files.archive),
      catalogPath: path.join(outputTarget.finalRoot, normalized.files.catalog),
      envelopePath: path.join(outputTarget.finalRoot, normalized.files.envelope),
      officialChannelPath: path.join(outputTarget.finalRoot, OPEN_DESIGN_OFFICIAL_CHANNEL_FILENAME),
      metadataPath: path.join(outputTarget.finalRoot, normalized.files.metadata),
      archiveSha256,
      archiveSize: archiveInfo.size,
      extractedManifestSha256: tree.sha256,
      catalogSha256: sha256Bytes(catalogBytes),
      verifiedWithModuleInstaller: true,
      publicRightsValidated: true,
    });
  } catch (error) {
    if (published) await rm(outputTarget.finalRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(outputTarget.transactionRoot, { recursive: true, force: true }).catch(() => undefined);
    await fsyncDirectory(outputTarget.parent).catch(() => undefined);
    throw error;
  }
}

export async function verifyOpenDesignProductionBundle({
  bundleRoot,
  moduleVersion = OPEN_DESIGN_PRODUCTION_VERSION,
  releaseTag,
  trustedKey,
  priorTrustState,
  verificationTimeMs,
} = {}) {
  stagingAssert(path.isAbsolute(bundleRoot ?? ""), "PACKAGE_VERIFY_INVALID", "bundle root must be absolute");
  const normalizedVersion = normalizeModuleVersion(moduleVersion);
  const normalizedTag = normalizeReleaseTagForVersion(releaseTag, normalizedVersion);
  const files = openDesignProductionFileNames(normalizedVersion);
  const normalizedTrustedKey = normalizeTrustedKey(trustedKey);
  const state = normalizePriorTrustState(priorTrustState, undefined);
  stagingAssert(Number.isSafeInteger(verificationTimeMs) && verificationTimeMs >= 0, "PACKAGE_VERIFY_INVALID", "verification time must be an explicit non-negative integer");

  const directoryInfo = await lstat(bundleRoot).catch((error) => stagingFail("PACKAGE_VERIFY_INVALID", error.message));
  stagingAssert(directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink(), "PACKAGE_VERIFY_INVALID", "bundle root must be a real directory");
  const envelopeBytes = await readOwnerControlledFile(path.join(bundleRoot, files.envelope), 8 * 1024 * 1024, "catalog envelope", false);
  const catalogBytes = await readOwnerControlledFile(path.join(bundleRoot, files.catalog), 8 * 1024 * 1024, "canonical catalog", false);
  const officialBytes = await readOwnerControlledFile(path.join(bundleRoot, OPEN_DESIGN_OFFICIAL_CHANNEL_FILENAME), 64 * 1024, "official channel", false);
  const metadataBytes = await readOwnerControlledFile(path.join(bundleRoot, files.metadata), 256 * 1024, "release metadata", false);
  const envelope = decodeCatalogEnvelope(envelopeBytes);
  stagingAssert(Buffer.from(envelope.catalogBytes).equals(catalogBytes), "PACKAGE_CATALOG_INVALID", "envelope catalog bytes differ from the canonical catalog asset");
  const verified = verifyModuleReleaseCatalog(envelope, {
    trustedKeys: [normalizedTrustedKey],
    state,
    now: verificationTimeMs,
  });
  if (!verified.ok) stagingFail("PACKAGE_CATALOG_INVALID", verified.diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join("; "));
  stagingAssert(verified.catalog.schemaVersion === 2, "PACKAGE_CATALOG_INVALID", "production catalog must use schema v2");
  const release = verified.catalog.releases[0];
  stagingAssert(verified.catalog.releases.length === 1 && release?.manifest?.id === OPEN_DESIGN_MODULE_ID && release.manifest.version === normalizedVersion, "PACKAGE_CATALOG_INVALID", "catalog does not contain the one expected OpenDesign release");
  const artifact = release.manifest.artifacts.find((entry) => entry.platform === OPEN_DESIGN_MODULE_PLATFORM);
  const installMetadata = release.artifactInstallMetadata.find((entry) => entry.platform === OPEN_DESIGN_MODULE_PLATFORM);
  const sizeMetadata = release.artifactSizes.find((entry) => entry.platform === OPEN_DESIGN_MODULE_PLATFORM);
  stagingAssert(artifact && installMetadata && sizeMetadata, "PACKAGE_CATALOG_INVALID", "catalog is missing darwin-arm64 metadata");

  const releaseBaseUrl = createReleaseBaseUrl(normalizedTag);
  stagingAssert(artifact.url === `${releaseBaseUrl}${files.archive}`, "PACKAGE_CATALOG_INVALID", "archive URL is not the exact-tag GitHub Release URL");
  const archivePath = path.join(bundleRoot, files.archive);
  const archiveInfo = await lstat(archivePath).catch((error) => stagingFail("PACKAGE_ARCHIVE_INVALID", error.message));
  stagingAssert(archiveInfo.isFile() && !archiveInfo.isSymbolicLink() && archiveInfo.size === sizeMetadata.size, "PACKAGE_ARCHIVE_INVALID", "archive size differs from Catalog v2");
  stagingAssert(await hashRegularFile(archivePath, DEFAULT_INSTALL_LIMITS.maxArchiveBytes, "production archive") === artifact.sha256, "PACKAGE_ARCHIVE_INVALID", "archive SHA-256 differs from the signed catalog");

  const official = parseStrictJson(officialBytes, "official channel");
  stagingAssert(Buffer.from(encodeCanonicalCatalog(official)).equals(officialBytes), "PACKAGE_OFFICIAL_CHANNEL_INVALID", "official channel must use canonical JSON bytes");
  const expectedOfficial = {
    schemaVersion: 1,
    moduleId: OPEN_DESIGN_MODULE_ID,
    version: normalizedVersion,
    platform: OPEN_DESIGN_MODULE_PLATFORM,
    catalogUrl: `${releaseBaseUrl}${files.envelope}`,
    githubRelease: { owner: OPEN_DESIGN_RELEASE_OWNER, repository: OPEN_DESIGN_RELEASE_REPOSITORY, tag: normalizedTag },
    trustedKeys: [{
      keyId: normalizedTrustedKey.keyId,
      publicKey: Buffer.from(normalizedTrustedKey.publicKey).toString("base64"),
      activeFrom: normalizedTrustedKey.activeFrom,
      ...(normalizedTrustedKey.activeUntil === undefined ? {} : { activeUntil: normalizedTrustedKey.activeUntil }),
    }],
  };
  stagingAssert(Buffer.from(encodeCanonicalCatalog(official)).equals(Buffer.from(encodeCanonicalCatalog(expectedOfficial))), "PACKAGE_OFFICIAL_CHANNEL_INVALID", "official channel metadata does not match the externally trusted release identity");

  const metadata = parseStrictJson(metadataBytes, "release metadata");
  stagingAssert(Buffer.from(encodeCanonicalCatalog(metadata)).equals(metadataBytes), "PACKAGE_METADATA_INVALID", "refresh source release metadata must use canonical JSON bytes");
  stagingAssert(metadata?.distribution?.class === "public" && metadata?.distribution?.nonPromotable === false, "PACKAGE_METADATA_INVALID", "release metadata is not public/promotable");
  stagingAssert(metadata?.module?.id === OPEN_DESIGN_MODULE_ID
    && metadata?.module?.version === normalizedVersion
    && metadata?.module?.platform === OPEN_DESIGN_MODULE_PLATFORM
    && metadata?.githubRelease?.owner === OPEN_DESIGN_RELEASE_OWNER
    && metadata?.githubRelease?.repository === OPEN_DESIGN_RELEASE_REPOSITORY
    && metadata?.githubRelease?.tag === normalizedTag,
  "PACKAGE_METADATA_INVALID", "release metadata identifies another module release");
  stagingAssert(metadata?.catalog?.path === files.envelope
    && metadata?.catalog?.canonicalCatalogPath === files.catalog
    && metadata?.catalog?.url === `${releaseBaseUrl}${files.envelope}`
    && metadata?.archive?.path === files.archive
    && metadata?.archive?.url === artifact.url,
  "PACKAGE_METADATA_INVALID", "release metadata uses files from another module version");
  stagingAssert(metadata?.archive?.sha256 === artifact.sha256 && metadata?.archive?.extractedManifestSha256 === installMetadata.extractedManifestSha256, "PACKAGE_METADATA_INVALID", "release metadata differs from the signed catalog");
  stagingAssert(metadata?.hostIntegration?.sourceCopyTarget === "apps/electron/resources/open-design-official-channel.json"
    && metadata?.hostIntegration?.packagedRuntimeTarget === "Contents/Resources/app/dist/resources/open-design-official-channel.json"
    && metadata?.catalogRefreshPolicy?.catalogTtlMaximumHours === 24
    && metadata?.catalogRefreshPolicy?.ciRefreshCadenceMaximumHours === 12
    && metadata?.catalogRefreshPolicy?.releaseTagMustRemain === normalizedTag
    && metadata?.catalogRefreshPolicy?.archiveAssetImmutable === true,
  "PACKAGE_METADATA_INVALID", "release metadata lost the host copy or catalog refresh policy");

  const installerRoot = await mkdtemp(path.join(os.tmpdir(), "open-design-production-verify-"));
  await chmod(installerRoot, 0o700);
  try {
    const installed = await installAndVerify({ archivePath, installerRoot, manifest: release.manifest, extractedManifestSha256: installMetadata.extractedManifestSha256 });
    stagingAssert(installed.extractedManifestSha256 === installMetadata.extractedManifestSha256, "PACKAGE_INSTALLER_ROUND_TRIP_FAILED", "installed tree hash differs from Catalog v2");
  } finally {
    await rm(installerRoot, { recursive: true, force: true });
  }

  const expected = new Set(files.production);
  const actual = await import("node:fs/promises").then(({ readdir }) => readdir(bundleRoot));
  stagingAssert(actual.length === expected.size && actual.every((name) => expected.has(name)), "PACKAGE_OUTPUT_INVALID", "production bundle file set is unexpected");
  stagingAssert(actual.filter((name) => name.endsWith(".tar.gz")).length === 1, "PACKAGE_OUTPUT_INVALID", "production bundle must contain exactly one tar.gz archive");
  return Object.freeze({
    ok: true,
    moduleId: OPEN_DESIGN_MODULE_ID,
    version: normalizedVersion,
    platform: OPEN_DESIGN_MODULE_PLATFORM,
    archiveSha256: artifact.sha256,
    extractedManifestSha256: installMetadata.extractedManifestSha256,
    catalogState: verified.state,
  });
}

async function inspectRefreshSource(normalized) {
  const info = await lstat(normalized.bundleRoot).catch((error) => stagingFail("PACKAGE_REFRESH_SOURCE_INVALID", error.message));
  stagingAssert(info.isDirectory() && !info.isSymbolicLink(), "PACKAGE_REFRESH_SOURCE_INVALID", "refresh source must be a real production bundle directory");
  const actualNames = await import("node:fs/promises").then(({ readdir }) => readdir(normalized.bundleRoot));
  const expectedNames = new Set(normalized.files.production);
  stagingAssert(actualNames.length === expectedNames.size && actualNames.every((name) => expectedNames.has(name)), "PACKAGE_REFRESH_SOURCE_INVALID", "refresh source must contain the exact production bundle file set");

  const [envelopeBytes, catalogBytes, officialBytes, metadataBytes] = await Promise.all([
    readOwnerControlledFile(path.join(normalized.bundleRoot, normalized.files.envelope), 8 * 1024 * 1024, "catalog envelope", false),
    readOwnerControlledFile(path.join(normalized.bundleRoot, normalized.files.catalog), 8 * 1024 * 1024, "canonical catalog", false),
    readOwnerControlledFile(path.join(normalized.bundleRoot, OPEN_DESIGN_OFFICIAL_CHANNEL_FILENAME), 64 * 1024, "official channel", false),
    readOwnerControlledFile(path.join(normalized.bundleRoot, normalized.files.metadata), 256 * 1024, "release metadata", false),
  ]);
  const envelope = decodeCatalogEnvelope(envelopeBytes);
  stagingAssert(Buffer.from(envelope.catalogBytes).equals(catalogBytes), "PACKAGE_CATALOG_INVALID", "refresh source envelope differs from the raw catalog asset");
  const untrustedCatalog = parseStrictJson(catalogBytes, "canonical catalog");
  stagingAssert(untrustedCatalog && typeof untrustedCatalog === "object" && typeof untrustedCatalog.issuedAt === "string", "PACKAGE_CATALOG_INVALID", "refresh source catalog has no signed issuance time");

  const official = parseStrictJson(officialBytes, "official channel");
  const suppliedKey = normalizeTrustedKey({
    keyId: normalized.keyId,
    publicKey: decodePublicKeyFromOfficialChannel(official),
    activeFrom: normalized.keyActiveFrom,
    ...(normalized.keyActiveUntil === undefined ? {} : { activeUntil: normalized.keyActiveUntil }),
  });
  const expectedOfficial = {
    schemaVersion: 1,
    moduleId: OPEN_DESIGN_MODULE_ID,
    version: normalized.moduleVersion,
    platform: OPEN_DESIGN_MODULE_PLATFORM,
    catalogUrl: `${normalized.releaseBaseUrl}${normalized.files.envelope}`,
    githubRelease: { owner: OPEN_DESIGN_RELEASE_OWNER, repository: OPEN_DESIGN_RELEASE_REPOSITORY, tag: normalized.releaseTag },
    trustedKeys: [{
      keyId: suppliedKey.keyId,
      publicKey: Buffer.from(suppliedKey.publicKey).toString("base64"),
      activeFrom: suppliedKey.activeFrom,
      ...(suppliedKey.activeUntil === undefined ? {} : { activeUntil: suppliedKey.activeUntil }),
    }],
  };
  stagingAssert(Buffer.from(encodeCanonicalCatalog(official)).equals(Buffer.from(encodeCanonicalCatalog(expectedOfficial))), "PACKAGE_OFFICIAL_CHANNEL_INVALID", "official channel does not match the expected exact-tag trust identity");

  // Historical refresh verification deliberately anchors `now` to the signed
  // issuedAt. This permits a just-expired catalog to be refreshed, while the
  // shared verifier still enforces canonical bytes, Ed25519, key activation and
  // expiry boundaries, catalog TTL, schema, and positive sequence.
  const historicalVerificationTimeMs = Date.parse(untrustedCatalog.issuedAt);
  stagingAssert(Number.isSafeInteger(historicalVerificationTimeMs) && historicalVerificationTimeMs >= 0, "PACKAGE_CATALOG_INVALID", "refresh source issuedAt is invalid");
  const historical = verifyModuleReleaseCatalog(envelope, {
    trustedKeys: [suppliedKey],
    state: { highestSequence: 0 },
    now: historicalVerificationTimeMs,
  });
  if (!historical.ok) stagingFail("PACKAGE_CATALOG_INVALID", historical.diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join("; "));
  stagingAssert(historical.catalog.schemaVersion === 2, "PACKAGE_CATALOG_INVALID", "refresh source must be Catalog v2");
  stagingAssert(historical.catalog.sequence === normalized.priorTrustState.highestSequence
    && historical.catalog.issuedAt === normalized.priorTrustState.latestIssuedAt,
  "PACKAGE_TRUST_STATE_INVALID", "explicit previous trust state does not identify the signed refresh source catalog");
  const release = historical.catalog.releases[0];
  stagingAssert(historical.catalog.releases.length === 1
    && release?.manifest?.id === OPEN_DESIGN_MODULE_ID
    && release.manifest.version === normalized.moduleVersion,
  "PACKAGE_CATALOG_INVALID", "refresh source catalog does not contain exactly one expected OpenDesign release");
  const artifact = release.manifest.artifacts.find((entry) => entry.platform === OPEN_DESIGN_MODULE_PLATFORM);
  const installMetadata = release.artifactInstallMetadata.find((entry) => entry.platform === OPEN_DESIGN_MODULE_PLATFORM);
  const sizeMetadata = release.artifactSizes.find((entry) => entry.platform === OPEN_DESIGN_MODULE_PLATFORM);
  stagingAssert(artifact && installMetadata && sizeMetadata, "PACKAGE_CATALOG_INVALID", "refresh source lacks complete darwin-arm64 release metadata");
  stagingAssert(artifact.url === `${normalized.releaseBaseUrl}${normalized.files.archive}`, "PACKAGE_CATALOG_INVALID", "refresh source archive URL is not the exact-tag immutable asset");

  const archivePath = path.join(normalized.bundleRoot, normalized.files.archive);
  const archiveInfo = await lstat(archivePath).catch((error) => stagingFail("PACKAGE_ARCHIVE_INVALID", error.message));
  stagingAssert(archiveInfo.isFile() && !archiveInfo.isSymbolicLink() && archiveInfo.size === sizeMetadata.size, "PACKAGE_ARCHIVE_INVALID", "immutable archive size differs from the signed catalog");
  const actualArchiveSha256 = await hashRegularFile(archivePath, DEFAULT_INSTALL_LIMITS.maxArchiveBytes, "immutable production archive");
  stagingAssert(actualArchiveSha256 === artifact.sha256, "PACKAGE_ARCHIVE_INVALID", "immutable archive SHA-256 differs from the signed catalog");

  const metadata = parseStrictJson(metadataBytes, "release metadata");
  stagingAssert(metadata?.distribution?.class === "public" && metadata?.distribution?.nonPromotable === false, "PACKAGE_METADATA_INVALID", "refresh source metadata is not public/promotable");
  stagingAssert(metadata?.module?.id === OPEN_DESIGN_MODULE_ID
    && metadata?.module?.version === normalized.moduleVersion
    && metadata?.module?.platform === OPEN_DESIGN_MODULE_PLATFORM,
  "PACKAGE_METADATA_INVALID", "refresh source metadata identifies another module release");
  stagingAssert(metadata?.githubRelease?.owner === OPEN_DESIGN_RELEASE_OWNER
    && metadata?.githubRelease?.repository === OPEN_DESIGN_RELEASE_REPOSITORY
    && metadata?.githubRelease?.tag === normalized.releaseTag,
  "PACKAGE_METADATA_INVALID", "refresh source metadata identifies another GitHub Release");
  stagingAssert(metadata?.catalog?.path === normalized.files.envelope
    && metadata?.catalog?.canonicalCatalogPath === normalized.files.catalog
    && metadata?.catalog?.url === `${normalized.releaseBaseUrl}${normalized.files.envelope}`
    && metadata?.catalog?.schemaVersion === 2
    && metadata?.catalog?.sequence === historical.catalog.sequence
    && metadata?.catalog?.issuedAt === historical.catalog.issuedAt
    && metadata?.catalog?.expiresAt === historical.catalog.expiresAt
    && metadata?.catalog?.sha256 === sha256Bytes(catalogBytes)
    && metadata?.catalog?.size === catalogBytes.byteLength,
  "PACKAGE_METADATA_INVALID", "refresh source metadata differs from the signed raw catalog");
  stagingAssert(metadata?.archive?.path === normalized.files.archive
    && metadata?.archive?.url === artifact.url
    && metadata?.archive?.sha256 === artifact.sha256
    && metadata?.archive?.size === archiveInfo.size
    && metadata?.archive?.extractedManifestSha256 === installMetadata.extractedManifestSha256,
  "PACKAGE_METADATA_INVALID", "refresh source metadata differs from the immutable archive or tree hash");
  stagingAssert(metadata?.hostVersionRange === release.hostVersionRange, "PACKAGE_METADATA_INVALID", "refresh source host version range differs from the signed catalog");
  stagingAssert(metadata?.trustedKey?.keyId === suppliedKey.keyId
    && metadata?.trustedKey?.publicKey === Buffer.from(suppliedKey.publicKey).toString("base64")
    && metadata?.trustedKey?.activeFrom === suppliedKey.activeFrom
    && metadata?.trustedKey?.activeUntil === suppliedKey.activeUntil,
  "PACKAGE_METADATA_INVALID", "refresh source metadata differs from the official channel trust root");

  const installerRoot = await mkdtemp(path.join(os.tmpdir(), "open-design-refresh-verify-"));
  await chmod(installerRoot, 0o700);
  try {
    const installed = await installAndVerify({
      archivePath,
      installerRoot,
      manifest: release.manifest,
      extractedManifestSha256: installMetadata.extractedManifestSha256,
    });
    stagingAssert(installed.archiveSha256 === artifact.sha256
      && installed.extractedManifestSha256 === installMetadata.extractedManifestSha256,
    "PACKAGE_INSTALLER_ROUND_TRIP_FAILED", "refresh source failed immutable archive/tree verification");
  } finally {
    await rm(installerRoot, { recursive: true, force: true });
  }
  return { catalog: historical.catalog, metadata, trustedKey: suppliedKey, artifact, installMetadata };
}

function normalizeRefreshOptions(options, { requireSigningKey }) {
  stagingAssert(path.isAbsolute(options.bundleRoot ?? ""), "PACKAGE_REFRESH_SOURCE_INVALID", "production bundle root must be absolute");
  const moduleVersion = normalizeModuleVersion(options.moduleVersion ?? OPEN_DESIGN_PRODUCTION_VERSION);
  const releaseTag = normalizeReleaseTagForVersion(options.releaseTag, moduleVersion);
  const files = openDesignProductionFileNames(moduleVersion);
  const catalogSequence = Number(options.catalogSequence);
  stagingAssert(Number.isSafeInteger(catalogSequence) && catalogSequence > 0, "PACKAGE_CATALOG_INVALID", "new catalog sequence must be a positive safe integer");
  const catalogIssuedAt = canonicalTimestamp(options.catalogIssuedAt, "new catalog issuedAt");
  const catalogExpiresAt = canonicalTimestamp(options.catalogExpiresAt, "new catalog expiresAt");
  stagingAssert(typeof options.keyId === "string" && KEY_ID_PATTERN.test(options.keyId), "PACKAGE_KEY_INVALID", "key ID is invalid");
  const keyActiveFrom = canonicalTimestamp(options.keyActiveFrom, "key activeFrom");
  const keyActiveUntil = options.keyActiveUntil === undefined ? undefined : canonicalTimestamp(options.keyActiveUntil, "key activeUntil");
  stagingAssert(options.priorTrustState !== undefined, "PACKAGE_TRUST_STATE_INVALID", "refresh requires explicit previous trust state");
  const priorTrustState = normalizePriorTrustState(options.priorTrustState, catalogSequence);
  stagingAssert(priorTrustState.highestSequence > 0 && priorTrustState.latestIssuedAt !== undefined, "PACKAGE_TRUST_STATE_INVALID", "refresh previous trust state must identify a prior signed catalog");
  const verificationTimeMs = options.verificationTimeMs ?? Date.parse(catalogIssuedAt) + 1_000;
  stagingAssert(Number.isSafeInteger(verificationTimeMs) && verificationTimeMs >= 0, "PACKAGE_CATALOG_INVALID", "new catalog verification time is invalid");
  if (requireSigningKey) {
    stagingAssert(path.isAbsolute(options.output ?? ""), "PACKAGE_OUTPUT_INVALID", "refresh output directory must be absolute");
    assertDisjointPaths(options.bundleRoot, options.output);
    stagingAssert(Boolean(options.privateKeyFile) !== Boolean(options.privateKeyEnvName), "PACKAGE_KEY_INVALID", "select exactly one private key source: file or environment variable");
  } else {
    stagingAssert(options.output === undefined, "PACKAGE_OUTPUT_INVALID", "refresh dry-run does not accept an output path");
    stagingAssert(options.privateKeyFile === undefined && options.privateKeyEnvName === undefined, "PACKAGE_KEY_INVALID", "refresh dry-run does not accept private-key inputs");
  }
  return {
    bundleRoot: options.bundleRoot,
    ...(options.output === undefined ? {} : { output: options.output }),
    moduleVersion,
    files,
    releaseTag,
    releaseBaseUrl: createReleaseBaseUrl(releaseTag),
    catalogSequence,
    catalogIssuedAt,
    catalogExpiresAt,
    keyId: options.keyId,
    keyActiveFrom,
    keyActiveUntil,
    priorTrustState,
    verificationTimeMs,
    privateKeyFile: options.privateKeyFile,
    privateKeyEnvName: options.privateKeyEnvName,
    env: options.env ?? process.env,
  };
}

function decodePublicKeyFromOfficialChannel(official) {
  stagingAssert(official && typeof official === "object" && Array.isArray(official.trustedKeys) && official.trustedKeys.length === 1, "PACKAGE_OFFICIAL_CHANNEL_INVALID", "official channel must contain exactly one trusted key");
  const encoded = official.trustedKeys[0]?.publicKey;
  stagingAssert(typeof encoded === "string" && encoded.length === 44, "PACKAGE_OFFICIAL_CHANNEL_INVALID", "official channel public key is invalid");
  const bytes = Buffer.from(encoded, "base64");
  stagingAssert(bytes.byteLength === 32 && bytes.toString("base64") === encoded, "PACKAGE_OFFICIAL_CHANNEL_INVALID", "official channel public key is not canonical Ed25519 base64");
  return Uint8Array.from(bytes);
}

function assertDisjointPaths(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  stagingAssert(!contains(normalizedLeft, normalizedRight) && !contains(normalizedRight, normalizedLeft), "PACKAGE_OUTPUT_INVALID", "refresh output and source bundle paths must be disjoint");
}

async function inspectProductionInputs(normalized, policy) {
  const snapshot = await preflightSealedStaging(normalized.stagingRoot);
  const inventory = await readJsonFromSnapshot(normalized.stagingRoot, "artifact-manifest.json", snapshot);
  const attestation = await readJsonFromSnapshot(normalized.stagingRoot, "build-attestation.json", snapshot);
  assertPublicStaging(inventory, attestation);
  await policy.validatePublicStaging({ inventory, attestation });
  await verifySealedStaging(normalized.stagingRoot, inventory);
  const node = await inspectNodeInput({
    nodeBin: normalized.nodeBin,
    nodeLicense: normalized.nodeLicense,
    inventory,
    attestation,
    policy: policy.nodePolicy,
  });
  await verifySealedStaging(normalized.stagingRoot, inventory);
  return { snapshot, inventory, attestation, node };
}

async function validatePublicStagingFromRepository({ inventory, attestation }) {
  const [provenance, policy, decisions, schemas] = await Promise.all([
    readJsonFile(path.join(moduleRoot, "provenance.json")),
    readJsonFile(path.join(moduleRoot, "artifact-policy.json")),
    readJsonFile(path.join(moduleRoot, "resource-decisions.json")),
    loadRuntimeSchemas(),
  ]);
  const result = validateArtifact({ provenance, policy, decisions, attestation, inventory, schemas });
  if (!result.ok) stagingFail("PACKAGE_PUBLIC_RIGHTS_BLOCKED", result.errors.map((entry) => `${entry.code}: ${entry.message}`).join("; "));
}

function assertPublicStaging(inventory, attestation) {
  for (const [label, marker] of [["artifact-manifest.json", inventory?.distribution], ["build-attestation.json", attestation?.distribution]]) {
    stagingAssert(marker && typeof marker === "object" && !Array.isArray(marker), "PACKAGE_PUBLIC_MARKER_INVALID", `${label} distribution marker is missing`);
    stagingAssert(Object.keys(marker).sort().join(",") === "class,nonPromotable", "PACKAGE_PUBLIC_MARKER_INVALID", `${label} distribution marker contains unknown fields`);
    stagingAssert(marker.class === "public" && marker.nonPromotable === false, "PACKAGE_PUBLIC_MARKER_INVALID", `${label} is not an approved public artifact`);
  }
  stagingAssert(inventory?.target?.platform === "darwin" && inventory?.target?.arch === "arm64", "PACKAGE_TARGET_INVALID", "staging target must be darwin-arm64");
  stagingAssert(attestation?.toolchain?.platform === "darwin" && attestation?.toolchain?.arch === "arm64", "PACKAGE_TARGET_INVALID", "attested toolchain must be darwin-arm64");
  stagingAssert(inventory.target.nodeAbi === attestation.toolchain.nodeAbi, "PACKAGE_TARGET_INVALID", "staging and attested Node ABI differ");
}

function normalizeBuildOptions(options, { requireSigningKey }) {
  const absolute = (value, code, message) => {
    stagingAssert(path.isAbsolute(value ?? ""), code, message);
    return value;
  };
  const moduleVersion = normalizeModuleVersion(options.moduleVersion ?? OPEN_DESIGN_PRODUCTION_VERSION);
  const releaseTag = normalizeReleaseTagForVersion(options.releaseTag, moduleVersion);
  const files = openDesignProductionFileNames(moduleVersion);
  const catalogSequence = Number(options.catalogSequence);
  stagingAssert(Number.isSafeInteger(catalogSequence) && catalogSequence > 0, "PACKAGE_CATALOG_INVALID", "catalog sequence must be a positive safe integer");
  const catalogIssuedAt = canonicalTimestamp(options.catalogIssuedAt, "catalog issuedAt");
  const catalogExpiresAt = canonicalTimestamp(options.catalogExpiresAt, "catalog expiresAt");
  const keyActiveFrom = canonicalTimestamp(options.keyActiveFrom, "key activeFrom");
  const keyActiveUntil = options.keyActiveUntil === undefined ? undefined : canonicalTimestamp(options.keyActiveUntil, "key activeUntil");
  stagingAssert(typeof options.keyId === "string" && KEY_ID_PATTERN.test(options.keyId), "PACKAGE_KEY_INVALID", "key ID is invalid");
  stagingAssert(typeof options.hostVersionRange === "string" && HOST_VERSION_RANGE_PATTERN.test(options.hostVersionRange), "PACKAGE_CATALOG_INVALID", "host version range is invalid");
  if (moduleVersion !== OPEN_DESIGN_PRODUCTION_VERSION) {
    stagingAssert(options.hostVersionRange === OPEN_DESIGN_MIN_HOST_VERSION_RANGE, "PACKAGE_CATALOG_INVALID", `OpenDesign ${moduleVersion} requires host version range ${OPEN_DESIGN_MIN_HOST_VERSION_RANGE}`);
  }
  const priorTrustState = normalizePriorTrustState(options.priorTrustState, catalogSequence);
  const verificationTimeMs = options.verificationTimeMs ?? Date.parse(catalogIssuedAt) + 1_000;
  stagingAssert(Number.isSafeInteger(verificationTimeMs) && verificationTimeMs >= 0, "PACKAGE_CATALOG_INVALID", "catalog verification time is invalid");
  if (requireSigningKey) {
    stagingAssert(Boolean(options.privateKeyFile) !== Boolean(options.privateKeyEnvName), "PACKAGE_KEY_INVALID", "select exactly one private key source: file or environment variable");
    absolute(options.output, "PACKAGE_OUTPUT_INVALID", "output directory must be absolute");
  } else {
    stagingAssert(options.output === undefined, "PACKAGE_OUTPUT_INVALID", "dry-run does not accept an output path");
    stagingAssert(options.privateKeyFile === undefined && options.privateKeyEnvName === undefined, "PACKAGE_KEY_INVALID", "dry-run does not accept private-key inputs");
  }
  return {
    stagingRoot: absolute(options.stagingRoot, "PACKAGE_STAGING_INVALID", "sealed staging root must be absolute"),
    nodeBin: absolute(options.nodeBin, "PACKAGE_NODE_INVALID", "Node binary path must be absolute"),
    nodeLicense: absolute(options.nodeLicense, "PACKAGE_NODE_LICENSE_INVALID", "Node LICENSE path must be absolute"),
    ...(options.output === undefined ? {} : { output: options.output }),
    moduleVersion,
    files,
    releaseTag,
    releaseBaseUrl: createReleaseBaseUrl(releaseTag),
    catalogSequence,
    catalogIssuedAt,
    catalogExpiresAt,
    hostVersionRange: options.hostVersionRange,
    keyId: options.keyId,
    keyActiveFrom,
    keyActiveUntil,
    priorTrustState,
    verificationTimeMs,
    privateKeyFile: options.privateKeyFile,
    privateKeyEnvName: options.privateKeyEnvName,
    env: options.env ?? process.env,
  };
}

function normalizeReleaseTag(value) {
  stagingAssert(typeof value === "string" && TAG_PATTERN.test(value) && value !== "latest" && value !== "." && value !== "..", "PACKAGE_RELEASE_TAG_INVALID", "release tag must be an immutable GitHub path segment");
  return value;
}

function normalizeModuleVersion(value) {
  stagingAssert(
    typeof value === "string" && OPEN_DESIGN_PRODUCTION_VERSIONS.includes(value),
    "PACKAGE_MODULE_VERSION_INVALID",
    `module version must be one of: ${OPEN_DESIGN_PRODUCTION_VERSIONS.join(", ")}`,
  );
  return value;
}

function normalizeReleaseTagForVersion(value, moduleVersion) {
  const releaseTag = normalizeReleaseTag(value);
  stagingAssert(releaseTag === `open-design-v${moduleVersion}`, "PACKAGE_RELEASE_TAG_INVALID", "release tag must exactly match the selected module version");
  return releaseTag;
}

function createReleaseBaseUrl(releaseTag) {
  return `https://github.com/${OPEN_DESIGN_RELEASE_OWNER}/${OPEN_DESIGN_RELEASE_REPOSITORY}/releases/download/${releaseTag}/`;
}

function canonicalTimestamp(value, label) {
  const milliseconds = Date.parse(value ?? "");
  stagingAssert(typeof value === "string" && Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value, "PACKAGE_TIMESTAMP_INVALID", `${label} must be a canonical ISO-8601 timestamp`);
  return value;
}

function normalizePriorTrustState(input, sequence) {
  if (input === undefined) {
    stagingAssert(sequence === undefined || sequence === 1, "PACKAGE_TRUST_STATE_INVALID", "catalog sequence greater than 1 requires explicit previous trust state");
    return { highestSequence: 0 };
  }
  stagingAssert(input && typeof input === "object" && !Array.isArray(input), "PACKAGE_TRUST_STATE_INVALID", "previous trust state is invalid");
  stagingAssert(Object.keys(input).every((key) => key === "highestSequence" || key === "latestIssuedAt"), "PACKAGE_TRUST_STATE_INVALID", "previous trust state contains unknown fields");
  stagingAssert(Number.isSafeInteger(input.highestSequence) && input.highestSequence >= 0, "PACKAGE_TRUST_STATE_INVALID", "previous sequence is invalid");
  if (sequence !== undefined) stagingAssert(input.highestSequence < sequence, "PACKAGE_TRUST_STATE_INVALID", "new catalog sequence must increase");
  return {
    highestSequence: input.highestSequence,
    ...(input.latestIssuedAt === undefined ? {} : { latestIssuedAt: canonicalTimestamp(input.latestIssuedAt, "previous issuedAt") }),
  };
}

async function loadSigningKey(options) {
  let pem;
  if (options.privateKeyFile) {
    stagingAssert(path.isAbsolute(options.privateKeyFile), "PACKAGE_KEY_INVALID", "private key file path must be absolute");
    pem = await readOwnerControlledFile(options.privateKeyFile, MAX_PRIVATE_KEY_BYTES, "private key", true);
  } else {
    stagingAssert(typeof options.privateKeyEnvName === "string" && ENV_NAME_PATTERN.test(options.privateKeyEnvName), "PACKAGE_KEY_INVALID", "private key environment variable name is invalid");
    const value = options.env?.[options.privateKeyEnvName];
    stagingAssert(typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= MAX_PRIVATE_KEY_BYTES, "PACKAGE_KEY_INVALID", "private key environment variable is missing or invalid");
    pem = Buffer.from(value, "utf8");
  }
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: pem, format: "pem" });
  } catch {
    stagingFail("PACKAGE_KEY_INVALID", "private key is not valid PEM");
  }
  stagingAssert(privateKey.type === "private" && privateKey.asymmetricKeyType === "ed25519", "PACKAGE_KEY_INVALID", "private key must be Ed25519");
  const publicJwk = createPublicKey(privateKey).export({ format: "jwk" });
  stagingAssert(publicJwk.kty === "OKP" && publicJwk.crv === "Ed25519" && typeof publicJwk.x === "string", "PACKAGE_KEY_INVALID", "derived public key is not Ed25519");
  return { privateKey, publicKey: Uint8Array.from(Buffer.from(publicJwk.x, "base64url")) };
}

async function readOwnerControlledFile(filename, maxBytes, label, requirePrivateMode) {
  const before = await lstat(filename).catch((error) => stagingFail("PACKAGE_INPUT_INVALID", requirePrivateMode ? `${label} cannot be opened` : `${label}: ${error.message}`));
  stagingAssert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.uid === currentUid(), "PACKAGE_INPUT_INVALID", `${label} must be an owner-controlled unlinked regular file`);
  stagingAssert(before.size > 0 && before.size <= maxBytes, "PACKAGE_INPUT_LIMIT_EXCEEDED", `${label} must contain 1..${maxBytes} bytes`);
  if (requirePrivateMode) stagingAssert((before.mode & 0o077) === 0, "PACKAGE_KEY_PERMISSIONS_INVALID", "private key file must not be accessible by group or others");
  const handle = await open(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)).catch((error) => stagingFail("PACKAGE_INPUT_INVALID", requirePrivateMode ? `${label} cannot be opened` : `${label}: ${error.message}`));
  try {
    const opened = await handle.stat();
    stagingAssert(sameIdentity(before, opened), "PACKAGE_INPUT_CHANGED", `${label} changed while opening`);
    const bytes = await readFile(handle);
    const after = await handle.stat();
    const afterPath = await lstat(filename);
    stagingAssert(bytes.length === after.size && sameIdentity(opened, after) && sameIdentity(opened, afterPath), "PACKAGE_INPUT_CHANGED", `${label} changed while reading`);
    return bytes;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function createProductionManifest(moduleVersion, archiveSha256, archiveUrl) {
  const parsed = parseModuleManifest({
    schemaVersion: 1,
    id: OPEN_DESIGN_MODULE_ID,
    version: moduleVersion,
    artifacts: [{
      platform: OPEN_DESIGN_MODULE_PLATFORM,
      entrypoint: OPEN_DESIGN_ENTRYPOINT,
      auxiliaryExecutables: [...OPEN_DESIGN_AUXILIARY_EXECUTABLES],
      url: archiveUrl,
      sha256: archiveSha256,
    }],
    capabilities: ["host-agent.use", "workspace.read", "workspace.write"],
  });
  if (!parsed.ok) stagingFail("PACKAGE_MANIFEST_INVALID", parsed.errors.map((entry) => `${entry.path}: ${entry.message}`).join("; "));
  return parsed.value;
}

function verifyCatalogEnvelope(envelopeBytes, trustedKey, state, now) {
  const result = verifyModuleReleaseCatalog(decodeCatalogEnvelope(envelopeBytes), { trustedKeys: [trustedKey], state, now });
  if (!result.ok) stagingFail("PACKAGE_CATALOG_INVALID", result.diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join("; "));
  return result;
}

async function installAndVerify({ archivePath, installerRoot, manifest, extractedManifestSha256 }) {
  const installer = new ModuleInstaller(installerRoot);
  const result = await installer.install({
    archivePath,
    descriptor: {
      verified: true,
      manifest,
      artifact: manifest.artifacts[0],
      extractedManifestSha256,
      format: "tar.gz",
    },
  });
  stagingAssert(result.extractedManifestSha256 === extractedManifestSha256, "PACKAGE_INSTALLER_ROUND_TRIP_FAILED", "installer returned a different extracted tree SHA-256");
  return result;
}

function expectedProductionFiles({ archiveInfo, archiveSha256, catalogBytes, envelopeBytes, officialChannelBytes, releaseMetadataBytes, files }) {
  return new Map([
    [files.archive, { size: archiveInfo.size, sha256: archiveSha256 }],
    [files.catalog, { size: catalogBytes.byteLength, sha256: sha256Bytes(catalogBytes) }],
    [files.envelope, { size: envelopeBytes.byteLength, sha256: sha256Bytes(envelopeBytes) }],
    [OPEN_DESIGN_OFFICIAL_CHANNEL_FILENAME, { size: officialChannelBytes.byteLength, sha256: sha256Bytes(officialChannelBytes) }],
    [files.metadata, { size: releaseMetadataBytes.byteLength, sha256: sha256Bytes(releaseMetadataBytes) }],
  ]);
}

function normalizeTrustedKey(value) {
  stagingAssert(value && typeof value === "object" && !Array.isArray(value), "PACKAGE_VERIFY_INVALID", "trusted key is required");
  stagingAssert(typeof value.keyId === "string" && KEY_ID_PATTERN.test(value.keyId), "PACKAGE_VERIFY_INVALID", "trusted key ID is invalid");
  stagingAssert(value.publicKey instanceof Uint8Array && value.publicKey.byteLength === 32, "PACKAGE_VERIFY_INVALID", "trusted Ed25519 public key must contain 32 bytes");
  return {
    keyId: value.keyId,
    publicKey: Uint8Array.from(value.publicKey),
    activeFrom: canonicalTimestamp(value.activeFrom, "key activeFrom"),
    ...(value.activeUntil === undefined ? {} : { activeUntil: canonicalTimestamp(value.activeUntil, "key activeUntil") }),
  };
}

function parseStrictJson(bytes, label) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    stagingFail("PACKAGE_METADATA_INVALID", `${label} is not strict UTF-8 JSON`);
  }
}

async function readJsonFile(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.nlink === right.nlink;
}

function currentUid() {
  stagingAssert(typeof process.getuid === "function", "PACKAGE_PLATFORM_UNSUPPORTED", "filesystem ownership checks require POSIX");
  return process.getuid();
}
