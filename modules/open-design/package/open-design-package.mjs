import { execFile } from "node:child_process";
import { createHash, sign } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { parseModuleManifest } from "../../../packages/module-contract/src/index.ts";
import { inspectArchive, isPortableArchivePayloadSegment } from "../../../packages/module-installer/src/archive.ts";
import { hashExtractedTree } from "../../../packages/module-installer/src/filesystem.ts";
import { ModuleInstaller, DEFAULT_INSTALL_LIMITS } from "../../../packages/module-installer/src/index.ts";
import {
  encodeCanonicalCatalog,
  MAX_MODULE_RELEASE_CATALOG_TTL_MS,
  verifyModuleReleaseCatalog,
} from "../../../packages/module-release-trust/src/index.ts";
import { create as createTar, list as listTar } from "tar";

import { verifySealedCandidate } from "../src/atomic-publisher.mjs";
import { inspectNativeBinary } from "../src/native-inventory.mjs";
import { stagingAssert, stagingFail } from "../src/staging-error.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = path.dirname(packageRoot);
const runtimeSourceRoot = path.join(moduleRoot, "runtime");

export const OPEN_DESIGN_MODULE_ID = "org.simulator.open-design";
export const OPEN_DESIGN_MODULE_VERSION = "0.14.1-development.1";
export const OPEN_DESIGN_MODULE_PLATFORM = "darwin-arm64";
export const OPEN_DESIGN_MIN_HOST_VERSION_RANGE = ">=0.12.0";
export const OPEN_DESIGN_ENTRYPOINT = "runtime/open-design-launcher";
export const OPEN_DESIGN_AUXILIARY_EXECUTABLES = Object.freeze([
  "runtime/node/bin/node",
  "runtime/daemon/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
]);
export const OPEN_DESIGN_EXECUTABLES = Object.freeze([
  OPEN_DESIGN_ENTRYPOINT,
  ...OPEN_DESIGN_AUXILIARY_EXECUTABLES,
]);

export const DEVELOPMENT_ONLY_CATALOG_URL = "https://m1-development.invalid/open-design/catalog-envelope.json";
export const DEVELOPMENT_ONLY_ARCHIVE_URL = `https://m1-development.invalid/open-design/${OPEN_DESIGN_MODULE_ID}-${OPEN_DESIGN_MODULE_VERSION}-${OPEN_DESIGN_MODULE_PLATFORM}.tar.gz`;

const ARCHIVE_FILENAME = path.posix.basename(new URL(DEVELOPMENT_ONLY_ARCHIVE_URL).pathname);
const MANIFEST_FILENAME = "module-manifest.json";
const CATALOG_FILENAME = "catalog.json";
const ENVELOPE_FILENAME = "catalog-envelope.json";
const BUNDLE_DESCRIPTOR_FILENAME = "bundle-descriptor.json";
const ARTIFACT_METADATA_FILENAME = "artifact-metadata.json";
const FIXED_TAR_MTIME = new Date(0);
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_ADDITIONAL_ARCHIVE_ENTRIES = 15;
const NODE_RUNTIME_VERSION = "24.18.0";
const NODE_LICENSE_SHA256 = "148eacf7863ef4329224a29398623077200a27194aa075569faf4a0a85566ca5";

const OFFICIAL_NODE_RUNTIME_POLICY = createNodeRuntimePolicy({
  version: NODE_RUNTIME_VERSION,
  licenseSha256: NODE_LICENSE_SHA256,
});

export function buildOpenDesignDevelopmentPackage(options = {}) {
  return buildOpenDesignDevelopmentPackageWithPolicy(options, OFFICIAL_NODE_RUNTIME_POLICY, false);
}

// Test-only digest seam for small self-contained Node fixtures. The production
// entrypoint and CLI always use OFFICIAL_NODE_RUNTIME_POLICY above.
export function buildOpenDesignDevelopmentPackageForTest(options, fixtureDigests) {
  return buildOpenDesignDevelopmentPackageWithPolicy(options, createNodeRuntimePolicy({
    version: NODE_RUNTIME_VERSION,
    licenseSha256: fixtureDigests?.nodeLicenseSha256,
  }), true);
}

async function buildOpenDesignDevelopmentPackageWithPolicy({
  stagingRoot,
  nodeBin,
  nodeLicense,
  catalogIssuedAt,
  catalogVerificationTimeMs,
  output,
  developmentLocalOnly = false,
  allowUnreviewedLocalArtifact = false,
} = {}, nodeRuntimePolicy, useTestCatalogDefaults) {
  // Loaded only after entering the explicitly development-only builder. Merely
  // importing shared archive primitives from this module never loads a
  // development private key into a production publisher process.
  const developmentIdentity = await loadDevelopmentIdentity();
  const effectiveIssuedAt = catalogIssuedAt ?? (useTestCatalogDefaults ? developmentIdentity.testCatalogIssuedAt : undefined);
  const effectiveVerificationTimeMs = catalogVerificationTimeMs
    ?? (useTestCatalogDefaults ? Date.parse(effectiveIssuedAt) + 1_000 : Date.now());
  assertDevelopmentAuthorization({ developmentLocalOnly, allowUnreviewedLocalArtifact });
  const catalogWindow = createDevelopmentCatalogWindow(effectiveIssuedAt, effectiveVerificationTimeMs, developmentIdentity);
  stagingAssert(path.isAbsolute(stagingRoot ?? ""), "PACKAGE_STAGING_INVALID", "sealed staging root must be absolute");
  stagingAssert(path.isAbsolute(nodeBin ?? ""), "PACKAGE_NODE_INVALID", "Node binary path must be absolute");
  stagingAssert(path.isAbsolute(nodeLicense ?? ""), "PACKAGE_NODE_LICENSE_INVALID", "Node LICENSE path must be absolute");
  stagingAssert(path.isAbsolute(output ?? ""), "PACKAGE_OUTPUT_INVALID", "output directory must be absolute");

  const outputTarget = await prepareOutputTarget(output);
  let published = false;
  try {
    const assemblyParent = path.join(outputTarget.transactionRoot, "assembly");
    const assemblyRoot = path.join(assemblyParent, "module");
    const bundleRoot = path.join(outputTarget.transactionRoot, "bundle");
    const installerRoot = path.join(outputTarget.transactionRoot, "installer");
    await mkdir(assemblyRoot, { recursive: true, mode: 0o700 });
    await mkdir(bundleRoot, { mode: 0o700 });

    const stagingSnapshot = await preflightSealedStaging(stagingRoot);
    const inventory = await readJsonFromSnapshot(stagingRoot, "artifact-manifest.json", stagingSnapshot);
    const attestation = await readJsonFromSnapshot(stagingRoot, "build-attestation.json", stagingSnapshot);
    assertDevelopmentStaging(inventory, attestation);
    await verifySealedStaging(stagingRoot, inventory);

    const node = await inspectNodeInput({ nodeBin, nodeLicense, inventory, attestation, policy: nodeRuntimePolicy });
    await copySnapshotTree(stagingRoot, assemblyRoot, stagingSnapshot);
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
    await copyRegularInput(nodeBin, path.join(assemblyRoot, "runtime/node/bin/node"), {
      mode: 0o700,
      maxBytes: DEFAULT_INSTALL_LIMITS.maxExecutableFileBytes,
      expectedSha256: node.sha256,
      label: "runtime/node/bin/node",
    });
    await copyRegularInput(nodeLicense, path.join(assemblyRoot, "runtime/node/LICENSE"), {
      mode: 0o600,
      maxBytes: DEFAULT_INSTALL_LIMITS.maxFileBytes,
      expectedSha256: node.licenseSha256,
      label: "runtime/node/LICENSE",
    });
    await normalizeAndVerifyAssembly(assemblyRoot);
    await verifySealedStaging(stagingRoot, inventory);

    const executablePaths = new Set(OPEN_DESIGN_EXECUTABLES);
    const tree = await hashExtractedTree(assemblyRoot, DEFAULT_INSTALL_LIMITS, undefined, () => {}, executablePaths);
    for (const executable of OPEN_DESIGN_EXECUTABLES) {
      stagingAssert(tree.files.get(executable)?.executable === true, "PACKAGE_EXECUTABLE_MISSING", `declared executable is missing: ${executable}`);
    }

    const archiveEntries = await collectArchiveEntries(assemblyParent, tree.files);
    stagingAssert(archiveEntries.length <= DEFAULT_INSTALL_LIMITS.maxEntries, "PACKAGE_ENTRY_LIMIT_EXCEEDED", `archive exceeds ${DEFAULT_INSTALL_LIMITS.maxEntries} entries`);
    const archivePath = path.join(bundleRoot, ARCHIVE_FILENAME);
    await createDeterministicArchive({ assemblyParent, archivePath, entries: archiveEntries });
    const archiveInfo = await lstat(archivePath);
    stagingAssert(archiveInfo.isFile() && !archiveInfo.isSymbolicLink(), "PACKAGE_ARCHIVE_INVALID", "archive output is not a regular file");
    stagingAssert(archiveInfo.size <= DEFAULT_INSTALL_LIMITS.maxArchiveBytes, "PACKAGE_ARCHIVE_LIMIT_EXCEEDED", `archive is ${archiveInfo.size} bytes and exceeds ${DEFAULT_INSTALL_LIMITS.maxArchiveBytes} bytes`);
    const archiveSha256 = await hashRegularFile(archivePath, DEFAULT_INSTALL_LIMITS.maxArchiveBytes, "archive");

    const manifest = createValidatedManifest(archiveSha256, DEVELOPMENT_ONLY_ARCHIVE_URL);
    const manifestBytes = encodeCanonicalCatalog(manifest);
    const catalog = {
      schemaVersion: 1,
      sequence: 1,
      issuedAt: catalogWindow.issuedAt,
      expiresAt: catalogWindow.expiresAt,
      releases: [{ manifest, artifactSizes: [{ platform: OPEN_DESIGN_MODULE_PLATFORM, size: archiveInfo.size }] }],
    };
    const catalogBytes = encodeCanonicalCatalog(catalog);
    const signature = Uint8Array.from(sign(null, catalogBytes, developmentIdentity.privateKeyPem));
    verifyDevelopmentCatalog(catalogBytes, signature, catalogWindow.verificationTimeMs, developmentIdentity);

    const envelope = {
      schemaVersion: 1,
      keyId: developmentIdentity.keyId,
      catalogBytes: Buffer.from(catalogBytes).toString("base64"),
      signature: Buffer.from(signature).toString("base64"),
    };
    const envelopeBytes = encodeCanonicalCatalog(envelope);
    const artifactMetadata = {
      schemaVersion: 1,
      developmentOnly: true,
      nonPromotable: true,
      moduleId: OPEN_DESIGN_MODULE_ID,
      version: OPEN_DESIGN_MODULE_VERSION,
      platform: OPEN_DESIGN_MODULE_PLATFORM,
      manifestPath: MANIFEST_FILENAME,
      archivePath: ARCHIVE_FILENAME,
      archiveSha256,
      archiveSize: archiveInfo.size,
      extractedManifestSha256: tree.sha256,
      catalog: {
        issuedAt: catalogWindow.issuedAt,
        expiresAt: catalogWindow.expiresAt,
      },
      provenance: {
        nodeRuntime: {
          version: node.version,
          executableSha256: node.sha256,
          licenseSha256: node.licenseSha256,
          verification: "sealed-attestation-executable-sha256-and-pinned-license-sha256",
        },
        agentRuntime: {
          kind: "simulator-host-runtime",
          transport: "ordinary-json-event-stream-cli-v2",
          bundledAgentExecutables: [],
          verification: "runtime-contract-and-fail-closed-integration-tests",
        },
      },
    };
    const artifactMetadataBytes = encodeCanonicalCatalog(artifactMetadata);
    const descriptor = createBundleDescriptor({
      archiveSha256,
      archiveSize: archiveInfo.size,
      envelopeBytes,
      extractedManifestSha256: tree.sha256,
    }, developmentIdentity);
    const descriptorBytes = encodeCanonicalCatalog(descriptor);
    const expectedBundleFiles = new Map([
      [ARCHIVE_FILENAME, { size: archiveInfo.size, sha256: archiveSha256 }],
      [MANIFEST_FILENAME, { size: manifestBytes.byteLength, sha256: sha256Bytes(manifestBytes) }],
      [CATALOG_FILENAME, { size: catalogBytes.byteLength, sha256: sha256Bytes(catalogBytes) }],
      [ENVELOPE_FILENAME, { size: envelopeBytes.byteLength, sha256: sha256Bytes(envelopeBytes) }],
      [ARTIFACT_METADATA_FILENAME, { size: artifactMetadataBytes.byteLength, sha256: sha256Bytes(artifactMetadataBytes) }],
      [BUNDLE_DESCRIPTOR_FILENAME, { size: descriptorBytes.byteLength, sha256: sha256Bytes(descriptorBytes) }],
    ]);

    await writeExclusiveBytes(path.join(bundleRoot, MANIFEST_FILENAME), manifestBytes);
    await writeExclusiveBytes(path.join(bundleRoot, CATALOG_FILENAME), catalogBytes);
    await writeExclusiveBytes(path.join(bundleRoot, ENVELOPE_FILENAME), envelopeBytes);
    await writeExclusiveBytes(path.join(bundleRoot, ARTIFACT_METADATA_FILENAME), artifactMetadataBytes);
    await writeExclusiveBytes(path.join(bundleRoot, BUNDLE_DESCRIPTOR_FILENAME), descriptorBytes);

    const installer = new ModuleInstaller(installerRoot);
    const installResult = await installer.install({
      archivePath,
      descriptor: {
        verified: true,
        manifest,
        artifact: manifest.artifacts[0],
        extractedManifestSha256: tree.sha256,
        format: "tar.gz",
      },
    });
    stagingAssert(installResult.archiveSha256 === archiveSha256, "PACKAGE_INSTALLER_ROUND_TRIP_FAILED", "installer returned a different archive SHA-256");
    stagingAssert(installResult.extractedManifestSha256 === tree.sha256, "PACKAGE_INSTALLER_ROUND_TRIP_FAILED", "installer returned a different extracted manifest SHA-256");

    await verifyBundleFiles(bundleRoot, expectedBundleFiles);
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
    await verifyPublishedOutput(outputTarget.finalRoot, expectedBundleFiles);

    return Object.freeze({
      output: outputTarget.finalRoot,
      archivePath: path.join(outputTarget.finalRoot, ARCHIVE_FILENAME),
      manifestPath: path.join(outputTarget.finalRoot, MANIFEST_FILENAME),
      catalogPath: path.join(outputTarget.finalRoot, CATALOG_FILENAME),
      envelopePath: path.join(outputTarget.finalRoot, ENVELOPE_FILENAME),
      artifactMetadataPath: path.join(outputTarget.finalRoot, ARTIFACT_METADATA_FILENAME),
      bundleDescriptorPath: path.join(outputTarget.finalRoot, BUNDLE_DESCRIPTOR_FILENAME),
      archiveSha256,
      archiveSize: archiveInfo.size,
      extractedManifestSha256: tree.sha256,
      verifiedWithModuleInstaller: true,
    });
  } catch (error) {
    if (published) await rm(outputTarget.finalRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(outputTarget.transactionRoot, { recursive: true, force: true }).catch(() => undefined);
    await fsyncDirectory(outputTarget.parent).catch(() => undefined);
    throw error;
  }
}

function assertDevelopmentAuthorization({ developmentLocalOnly, allowUnreviewedLocalArtifact }) {
  stagingAssert(developmentLocalOnly === true, "PACKAGE_DEVELOPMENT_ONLY", "packaging requires the explicit development-local-only mode");
  stagingAssert(allowUnreviewedLocalArtifact === true, "PACKAGE_DEVELOPMENT_NOT_ALLOWED", "packaging requires SIMULATOR_ALLOW_UNREVIEWED_LOCAL_ARTIFACT=1");
}

function createDevelopmentCatalogWindow(issuedAt, verificationTimeMs, developmentIdentity) {
  const issuedAtMs = Date.parse(issuedAt ?? "");
  stagingAssert(
    typeof issuedAt === "string"
      && Number.isSafeInteger(issuedAtMs)
      && new Date(issuedAtMs).toISOString() === issuedAt,
    "PACKAGE_CATALOG_WINDOW_INVALID",
    "catalog issuance must be an explicit canonical ISO-8601 timestamp",
  );
  stagingAssert(
    Number.isSafeInteger(verificationTimeMs) && verificationTimeMs >= 0,
    "PACKAGE_CATALOG_WINDOW_INVALID",
    "catalog verification time is invalid",
  );
  const expiresAtMs = issuedAtMs + MAX_MODULE_RELEASE_CATALOG_TTL_MS;
  stagingAssert(
    Number.isSafeInteger(expiresAtMs) && expiresAtMs <= Date.parse(developmentIdentity.activeUntil),
    "PACKAGE_CATALOG_WINDOW_INVALID",
    "catalog validity exceeds the development signing-key window",
  );
  return Object.freeze({
    issuedAt,
    expiresAt: new Date(expiresAtMs).toISOString(),
    verificationTimeMs,
  });
}

function createNodeRuntimePolicy({ version, licenseSha256 } = {}) {
  stagingAssert(/^24\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version ?? ""), "PACKAGE_NODE_POLICY_INVALID", "Node runtime version policy is invalid");
  stagingAssert(/^[a-f0-9]{64}$/u.test(licenseSha256 ?? ""), "PACKAGE_NODE_POLICY_INVALID", "Node LICENSE SHA-256 policy is invalid");
  return Object.freeze({ version, licenseSha256 });
}

async function prepareOutputTarget(output) {
  const basename = path.basename(output);
  stagingAssert(basename.length > 0 && basename !== "." && basename !== "..", "PACKAGE_OUTPUT_INVALID", "output basename is invalid");
  const requestedParent = path.dirname(output);
  await mkdir(requestedParent, { recursive: true, mode: 0o700 }).catch((error) => stagingFail("PACKAGE_OUTPUT_INVALID", error.message));
  const parentStat = await lstat(requestedParent).catch((error) => stagingFail("PACKAGE_OUTPUT_INVALID", error.message));
  stagingAssert(parentStat.isDirectory() && !parentStat.isSymbolicLink(), "PACKAGE_OUTPUT_INVALID", "output parent must be a real directory");
  stagingAssert(parentStat.uid === currentUid() && (parentStat.mode & 0o077) === 0, "PACKAGE_OUTPUT_INVALID", "output parent must be owner-only");
  const parent = await realpath(requestedParent).catch((error) => stagingFail("PACKAGE_OUTPUT_INVALID", error.message));
  const finalRoot = path.join(parent, basename);
  await assertAbsent(finalRoot, "PACKAGE_OUTPUT_EXISTS");
  const transactionRoot = await mkdtemp(path.join(parent, ".open-design-package-")).catch((error) => stagingFail("PACKAGE_OUTPUT_INVALID", error.message));
  await chmod(transactionRoot, 0o700);
  return { parent, finalRoot, transactionRoot };
}

async function preflightSealedStaging(stagingRoot) {
  const supplied = await lstat(stagingRoot).catch((error) => stagingFail("PACKAGE_STAGING_INVALID", error.message));
  stagingAssert(supplied.isDirectory() && !supplied.isSymbolicLink(), "PACKAGE_STAGING_INVALID", "sealed staging root must be a real directory");
  const root = await realpath(stagingRoot).catch((error) => stagingFail("PACKAGE_STAGING_INVALID", error.message));
  const snapshot = new Map();
  let entries = 0;
  let totalBytes = 0;
  const executablePaths = new Set(OPEN_DESIGN_AUXILIARY_EXECUTABLES);

  async function visit(directory, relativeDirectory) {
    const before = await lstat(directory).catch((error) => stagingFail("PACKAGE_STAGING_INVALID", error.message));
    assertSealedDirectory(before, relativeDirectory || ".");
    snapshot.set(relativeDirectory, snapshotEntry(before, "directory"));
    const handle = await opendir(directory).catch((error) => stagingFail("PACKAGE_STAGING_INVALID", error.message));
    const children = [];
    for await (const child of handle) children.push(child.name);
    children.sort(compareUtf8);
    for (const name of children) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      assertSafeArchivePath(relativePath);
      assertNoElectronPath(relativePath);
      const absolutePath = path.join(directory, name);
      const info = await lstat(absolutePath).catch((error) => stagingFail("PACKAGE_STAGING_INVALID", error.message));
      entries += 1;
      stagingAssert(entries + MAX_ADDITIONAL_ARCHIVE_ENTRIES <= DEFAULT_INSTALL_LIMITS.maxEntries, "PACKAGE_ENTRY_LIMIT_EXCEEDED", `package exceeds ${DEFAULT_INSTALL_LIMITS.maxEntries} entries after runtime overlay`);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      stagingAssert(info.isFile() && !info.isSymbolicLink(), "PACKAGE_STAGING_ENTRY_INVALID", `staging contains a link or special file: ${relativePath}`);
      stagingAssert(info.nlink === 1 && info.uid === currentUid(), "PACKAGE_STAGING_ENTRY_INVALID", `staging file is not an owner-built unlinked regular file: ${relativePath}`);
      stagingAssert((info.mode & 0o222) === 0, "PACKAGE_STAGING_NOT_SEALED", `staging file remains writable: ${relativePath}`);
      const maxBytes = executablePaths.has(relativePath) ? DEFAULT_INSTALL_LIMITS.maxExecutableFileBytes : DEFAULT_INSTALL_LIMITS.maxFileBytes;
      stagingAssert(info.size <= maxBytes, "PACKAGE_FILE_LIMIT_EXCEEDED", `staging file exceeds ${maxBytes} bytes: ${relativePath}`);
      totalBytes += info.size;
      stagingAssert(Number.isSafeInteger(totalBytes) && totalBytes <= DEFAULT_INSTALL_LIMITS.maxTotalBytes, "PACKAGE_TOTAL_LIMIT_EXCEEDED", `staging exceeds ${DEFAULT_INSTALL_LIMITS.maxTotalBytes} bytes`);
      snapshot.set(relativePath, snapshotEntry(info, "file"));
    }
    const after = await lstat(directory).catch((error) => stagingFail("PACKAGE_STAGING_INVALID", error.message));
    stagingAssert(sameIdentity(before, after), "PACKAGE_STAGING_CHANGED", `staging directory changed during preflight: ${relativeDirectory || "."}`);
  }

  await visit(root, "");
  return snapshot;
}

function assertSealedDirectory(info, label) {
  stagingAssert(info.isDirectory() && !info.isSymbolicLink(), "PACKAGE_STAGING_ENTRY_INVALID", `staging directory is not real: ${label}`);
  stagingAssert(info.uid === currentUid(), "PACKAGE_STAGING_ENTRY_INVALID", `staging directory is not owned by the current user: ${label}`);
  stagingAssert((info.mode & 0o222) === 0, "PACKAGE_STAGING_NOT_SEALED", `staging directory remains writable: ${label}`);
}

function assertSafeArchivePath(relativePath) {
  const segments = relativePath.split("/");
  stagingAssert(segments.every(isPortableArchivePayloadSegment), "PACKAGE_PATH_INVALID", `path is outside the installer safe ASCII contract: ${relativePath}`);
  stagingAssert(segments.length <= DEFAULT_INSTALL_LIMITS.maxDepth, "PACKAGE_PATH_LIMIT_EXCEEDED", `path exceeds depth ${DEFAULT_INSTALL_LIMITS.maxDepth}: ${relativePath}`);
  stagingAssert(Buffer.byteLength(`module/${relativePath}`, "utf8") <= DEFAULT_INSTALL_LIMITS.maxPathBytes, "PACKAGE_PATH_LIMIT_EXCEEDED", `path exceeds ${DEFAULT_INSTALL_LIMITS.maxPathBytes} bytes: ${relativePath}`);
}

function assertNoElectronPath(relativePath) {
  const forbidden = relativePath.toLowerCase().split("/").some((segment) => segment === "electron" || segment.startsWith("electron.") || segment.startsWith("electron-"));
  stagingAssert(!forbidden, "PACKAGE_ELECTRON_FORBIDDEN", `staging contains forbidden Electron payload: ${relativePath}`);
}

async function readJsonFromSnapshot(root, relativePath, snapshot) {
  const expected = snapshot.get(relativePath);
  stagingAssert(expected?.type === "file", "PACKAGE_METADATA_MISSING", `sealed staging is missing ${relativePath}`);
  stagingAssert(expected.size <= MAX_METADATA_BYTES, "PACKAGE_METADATA_INVALID", `${relativePath} exceeds ${MAX_METADATA_BYTES} bytes`);
  const bytes = await readRegularInput(path.join(root, ...relativePath.split("/")), {
    maxBytes: MAX_METADATA_BYTES,
    expected,
    label: relativePath,
  });
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    stagingFail("PACKAGE_METADATA_INVALID", `${relativePath} is not valid JSON: ${error.message}`);
  }
}

function assertDevelopmentStaging(inventory, attestation) {
  assertDevelopmentMarker(inventory?.distribution, "artifact-manifest.json");
  assertDevelopmentMarker(attestation?.distribution, "build-attestation.json");
  stagingAssert(inventory?.target?.platform === "darwin" && inventory?.target?.arch === "arm64", "PACKAGE_TARGET_INVALID", "staging target must be darwin-arm64");
  stagingAssert(attestation?.toolchain?.platform === "darwin" && attestation?.toolchain?.arch === "arm64", "PACKAGE_TARGET_INVALID", "attested toolchain must be darwin-arm64");
  stagingAssert(inventory.target.nodeAbi === attestation.toolchain.nodeAbi, "PACKAGE_TARGET_INVALID", "staging target and attested Node ABI differ");
}

function assertDevelopmentMarker(value, label) {
  stagingAssert(value !== null && typeof value === "object" && !Array.isArray(value), "PACKAGE_DEVELOPMENT_MARKER_INVALID", `${label} distribution marker is missing`);
  stagingAssert(Object.keys(value).sort().join(",") === "class,nonPromotable", "PACKAGE_DEVELOPMENT_MARKER_INVALID", `${label} distribution marker contains unknown fields`);
  stagingAssert(value.class === "development-local-only" && value.nonPromotable === true, "PACKAGE_DEVELOPMENT_MARKER_INVALID", `${label} is not permanently non-promotable`);
}

async function verifySealedStaging(stagingRoot, inventory) {
  await verifySealedCandidate({ target: { published: false, sealed: true, tempRoot: stagingRoot }, inventory });
}

async function inspectNodeInput({ nodeBin, nodeLicense, inventory, attestation, policy }) {
  const nodeInfo = await lstat(nodeBin).catch((error) => stagingFail("PACKAGE_NODE_INVALID", error.message));
  assertRegularExternalInput(nodeInfo, "Node binary", DEFAULT_INSTALL_LIMITS.maxExecutableFileBytes);
  const native = await inspectNativeBinary(nodeBin, "Node binary");
  stagingAssert(native.format === "mach-o" && native.platform === "darwin" && native.arch === "arm64", "PACKAGE_NODE_INVALID", "Node binary must be a macOS arm64 Mach-O executable");
  const sha256 = await hashRegularFile(nodeBin, DEFAULT_INSTALL_LIMITS.maxExecutableFileBytes, "Node binary");
  stagingAssert(sha256 === attestation.toolchain.nodeExecutableSha256, "PACKAGE_NODE_DIGEST_MISMATCH", "Node binary SHA-256 does not match the sealed build attestation");

  let runtime;
  try {
    const result = await execFileAsync(nodeBin, ["-p", "JSON.stringify({nodeVersion:process.version,nodeAbi:process.versions.modules,platform:process.platform,arch:process.arch})"], {
      env: { PATH: "/usr/bin:/bin" },
      maxBuffer: 64 * 1024,
      timeout: 10_000,
    });
    runtime = JSON.parse(result.stdout.trim());
  } catch (error) {
    stagingFail("PACKAGE_NODE_INVALID", `Node runtime inspection failed: ${error.message}`);
  }
  const expectedVersion = String(attestation.toolchain.nodeVersion ?? "").replace(/^v/u, "");
  stagingAssert(expectedVersion === policy.version, "PACKAGE_NODE_INVALID", "sealed attestation does not match the pinned Node runtime version");
  stagingAssert(String(runtime.nodeVersion ?? "").replace(/^v/u, "") === expectedVersion, "PACKAGE_NODE_INVALID", "Node version does not match the sealed build attestation");
  stagingAssert(runtime.nodeAbi === attestation.toolchain.nodeAbi && runtime.nodeAbi === inventory.target.nodeAbi, "PACKAGE_NODE_INVALID", "Node ABI does not match the sealed staging target");
  stagingAssert(runtime.platform === "darwin" && runtime.arch === "arm64", "PACKAGE_NODE_INVALID", "Node runtime did not report darwin-arm64");

  const licenseInfo = await lstat(nodeLicense).catch((error) => stagingFail("PACKAGE_NODE_LICENSE_INVALID", error.message));
  assertRegularExternalInput(licenseInfo, "Node LICENSE", DEFAULT_INSTALL_LIMITS.maxFileBytes);
  const licenseBytes = await readRegularInput(nodeLicense, { maxBytes: DEFAULT_INSTALL_LIMITS.maxFileBytes, label: "Node LICENSE" });
  const licenseText = licenseBytes.toString("utf8");
  stagingAssert(Buffer.from(licenseText, "utf8").equals(licenseBytes), "PACKAGE_NODE_LICENSE_INVALID", "Node LICENSE must be valid UTF-8");
  stagingAssert(licenseText.startsWith("Node.js is licensed for use as follows:"), "PACKAGE_NODE_LICENSE_INVALID", "Node LICENSE does not have the official Node.js license preamble");
  const licenseSha256 = createHash("sha256").update(licenseBytes).digest("hex");
  stagingAssert(licenseSha256 === policy.licenseSha256, "PACKAGE_NODE_LICENSE_DIGEST_MISMATCH", "Node LICENSE SHA-256 does not match the pinned runtime provenance");
  return { version: expectedVersion, sha256, licenseSha256 };
}

function assertRegularExternalInput(info, label, maxBytes) {
  stagingAssert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, "PACKAGE_INPUT_INVALID", `${label} must be an unlinked regular file`);
  stagingAssert(info.uid === currentUid(), "PACKAGE_INPUT_INVALID", `${label} must be owned by the current user`);
  stagingAssert(info.size > 0 && info.size <= maxBytes, "PACKAGE_INPUT_LIMIT_EXCEEDED", `${label} must contain 1..${maxBytes} bytes`);
}

async function copySnapshotTree(sourceRoot, destinationRoot, snapshot) {
  async function visit(sourceDirectory, destinationDirectory, relativeDirectory) {
    const expectedDirectory = snapshot.get(relativeDirectory);
    const before = await lstat(sourceDirectory).catch((error) => stagingFail("PACKAGE_STAGING_CHANGED", error.message));
    stagingAssert(expectedDirectory?.type === "directory" && sameIdentity(before, expectedDirectory), "PACKAGE_STAGING_CHANGED", `staging directory changed before copy: ${relativeDirectory || "."}`);
    if (relativeDirectory) await mkdir(destinationDirectory, { mode: 0o700 }).catch((error) => stagingFail("PACKAGE_COPY_FAILED", error.message));
    const directory = await opendir(sourceDirectory).catch((error) => stagingFail("PACKAGE_COPY_FAILED", error.message));
    const children = [];
    for await (const child of directory) children.push(child.name);
    children.sort(compareUtf8);
    for (const name of children) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const expected = snapshot.get(relativePath);
      stagingAssert(expected != null, "PACKAGE_STAGING_CHANGED", `staging path appeared after preflight: ${relativePath}`);
      const source = path.join(sourceDirectory, name);
      const destination = path.join(destinationDirectory, name);
      if (expected.type === "directory") await visit(source, destination, relativePath);
      else await copyRegularInput(source, destination, { mode: 0o600, maxBytes: DEFAULT_INSTALL_LIMITS.maxFileBytes, expected, label: relativePath });
    }
    const after = await lstat(sourceDirectory).catch((error) => stagingFail("PACKAGE_STAGING_CHANGED", error.message));
    stagingAssert(sameIdentity(before, after), "PACKAGE_STAGING_CHANGED", `staging directory changed during copy: ${relativeDirectory || "."}`);
  }
  await visit(sourceRoot, destinationRoot, "");
}

async function copyRegularInput(source, destination, { mode, maxBytes, expected, expectedSha256, label }) {
  await ensurePrivateDirectory(path.dirname(destination));
  const bytes = await readRegularInput(source, { maxBytes, expected, label });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expectedSha256 !== undefined) stagingAssert(sha256 === expectedSha256, "PACKAGE_INPUT_CHANGED", `${label} SHA-256 changed while copying`);
  const output = await open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), mode)
    .catch((error) => stagingFail("PACKAGE_COPY_FAILED", `${label}: ${error.message}`));
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const result = await output.write(bytes, offset, bytes.length - offset, offset);
      stagingAssert(result.bytesWritten > 0, "PACKAGE_COPY_FAILED", `${label} write made no progress`);
      offset += result.bytesWritten;
    }
    await output.sync().catch((error) => stagingFail("PACKAGE_DURABILITY_FAILED", error.message));
  } finally {
    await output.close().catch(() => undefined);
  }
  await chmod(destination, mode);
  return { sha256, bytes: bytes.length };
}

async function readRegularInput(filename, { maxBytes, expected, label }) {
  const pathInfo = await lstat(filename).catch((error) => stagingFail("PACKAGE_INPUT_INVALID", `${label}: ${error.message}`));
  stagingAssert(pathInfo.isFile() && !pathInfo.isSymbolicLink() && pathInfo.nlink === 1, "PACKAGE_INPUT_INVALID", `${label} must be an unlinked regular file`);
  stagingAssert(pathInfo.uid === currentUid(), "PACKAGE_INPUT_INVALID", `${label} must be owned by the current user`);
  stagingAssert(pathInfo.size <= maxBytes, "PACKAGE_INPUT_LIMIT_EXCEEDED", `${label} exceeds ${maxBytes} bytes`);
  if (expected) stagingAssert(sameIdentity(pathInfo, expected), "PACKAGE_INPUT_CHANGED", `${label} changed before opening`);
  const input = await open(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)).catch((error) => stagingFail("PACKAGE_INPUT_INVALID", `${label}: ${error.message}`));
  try {
    const before = await input.stat();
    stagingAssert(sameIdentity(pathInfo, before), "PACKAGE_INPUT_CHANGED", `${label} changed while opening`);
    const bytes = await readFile(input);
    stagingAssert(bytes.length <= maxBytes, "PACKAGE_INPUT_LIMIT_EXCEEDED", `${label} exceeds ${maxBytes} bytes`);
    const after = await input.stat();
    const afterPath = await lstat(filename).catch((error) => stagingFail("PACKAGE_INPUT_CHANGED", `${label}: ${error.message}`));
    stagingAssert(sameIdentity(before, after) && sameIdentity(before, afterPath) && bytes.length === after.size, "PACKAGE_INPUT_CHANGED", `${label} changed while reading`);
    return bytes;
  } finally {
    await input.close().catch(() => undefined);
  }
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  stagingAssert(info.isDirectory() && !info.isSymbolicLink() && info.uid === currentUid(), "PACKAGE_COPY_FAILED", `destination directory is invalid: ${directory}`);
  await chmod(directory, 0o700);
}

async function normalizeAndVerifyAssembly(root) {
  const executablePaths = new Set(OPEN_DESIGN_EXECUTABLES);
  const seenExecutables = new Set();
  let entries = 0;
  let totalBytes = 0;
  const collisionKeys = new Map();

  async function visit(directory, relativeDirectory) {
    await chmod(directory, 0o700);
    const children = [];
    const handle = await opendir(directory);
    for await (const child of handle) children.push(child.name);
    children.sort(compareUtf8);
    for (const name of children) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      assertSafeArchivePath(relativePath);
      assertNoElectronPath(relativePath);
      const key = relativePath.toLowerCase();
      stagingAssert(!collisionKeys.has(key), "PACKAGE_PATH_COLLISION", `paths collide under ASCII case folding: ${collisionKeys.get(key)} and ${relativePath}`);
      collisionKeys.set(key, relativePath);
      entries += 1;
      stagingAssert(entries + 1 <= DEFAULT_INSTALL_LIMITS.maxEntries, "PACKAGE_ENTRY_LIMIT_EXCEEDED", `package exceeds ${DEFAULT_INSTALL_LIMITS.maxEntries} entries`);
      const absolutePath = path.join(directory, name);
      const info = await lstat(absolutePath);
      stagingAssert(!info.isSymbolicLink() && (info.isDirectory() || info.isFile()), "PACKAGE_ENTRY_INVALID", `assembly contains a link or special file: ${relativePath}`);
      if (info.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      const executable = executablePaths.has(relativePath);
      const maxBytes = executable ? DEFAULT_INSTALL_LIMITS.maxExecutableFileBytes : DEFAULT_INSTALL_LIMITS.maxFileBytes;
      stagingAssert(info.nlink === 1 && info.size <= maxBytes, "PACKAGE_FILE_LIMIT_EXCEEDED", `assembly file exceeds policy or is hard-linked: ${relativePath}`);
      totalBytes += info.size;
      stagingAssert(Number.isSafeInteger(totalBytes) && totalBytes <= DEFAULT_INSTALL_LIMITS.maxTotalBytes, "PACKAGE_TOTAL_LIMIT_EXCEEDED", `assembly exceeds ${DEFAULT_INSTALL_LIMITS.maxTotalBytes} bytes`);
      await chmod(absolutePath, executable ? 0o700 : 0o600);
      if (executable) seenExecutables.add(relativePath);
    }
  }

  await visit(root, "");
  for (const executable of OPEN_DESIGN_EXECUTABLES) {
    stagingAssert(seenExecutables.has(executable), "PACKAGE_EXECUTABLE_MISSING", `declared executable is missing: ${executable}`);
  }
}

async function collectArchiveEntries(assemblyParent, treeFiles) {
  const root = path.join(assemblyParent, "module");
  const entries = [{ path: "module", type: "directory", mode: 0o700 }];
  async function visit(directory, relativeDirectory) {
    const children = [];
    const handle = await opendir(directory);
    for await (const child of handle) children.push(child.name);
    children.sort(compareUtf8);
    for (const name of children) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const archivePath = `module/${relativePath}`;
      const info = await lstat(path.join(directory, name));
      const type = info.isDirectory() ? "directory" : info.isFile() ? "file" : "invalid";
      stagingAssert(type !== "invalid" && !info.isSymbolicLink(), "PACKAGE_ENTRY_INVALID", `assembly contains a link or special file: ${relativePath}`);
      const expectedMode = type === "directory" || OPEN_DESIGN_EXECUTABLES.includes(relativePath) ? 0o700 : 0o600;
      stagingAssert((info.mode & 0o777) === expectedMode, "PACKAGE_MODE_INVALID", `assembly mode is not normalized: ${relativePath}`);
      if (type === "directory") {
        // Intermediate directories are implicit, avoiding unnecessary PAX
        // metadata when only a long directory segment needs representation.
        await visit(path.join(directory, name), relativePath);
      } else {
        const treeFile = treeFiles.get(relativePath);
        stagingAssert(treeFile != null, "PACKAGE_ARCHIVE_INVALID", `tree manifest is missing file: ${relativePath}`);
        entries.push({ path: archivePath, type, mode: expectedMode, sha256: treeFile.sha256 });
      }
    }
  }
  await visit(root, "");
  const digestCounts = new Map();
  for (const entry of entries) {
    if (entry.type === "file") digestCounts.set(entry.sha256, (digestCounts.get(entry.sha256) ?? 0) + 1);
  }
  entries.sort((left, right) => {
    if (left.path === "module") return -1;
    if (right.path === "module") return 1;
    const leftDuplicate = digestCounts.get(left.sha256) > 1;
    const rightDuplicate = digestCounts.get(right.sha256) > 1;
    if (leftDuplicate !== rightDuplicate) return leftDuplicate ? -1 : 1;
    if (leftDuplicate) {
      const digestOrder = compareUtf8(left.sha256, right.sha256);
      if (digestOrder !== 0) return digestOrder;
    }
    return compareUtf8(left.path, right.path);
  });
  return entries;
}

async function createDeterministicArchive({ assemblyParent, archivePath, entries }) {
  const diagnosticZopfli = process.env.SIMULATOR_OPEN_DESIGN_DIAGNOSTIC_ZOPFLI;
  const rawArchivePath = diagnosticZopfli ? archivePath.replace(/\.gz$/u, "") : null;
  await createTar({
    cwd: assemblyParent,
    file: rawArchivePath ?? archivePath,
    ...(rawArchivePath ? {} : { gzip: { level: 9, portable: true } }),
    mtime: FIXED_TAR_MTIME,
    noDirRecurse: true,
    portable: true,
    strict: true,
  }, entries.map((entry) => entry.path));
  if (rawArchivePath) {
    stagingAssert(path.isAbsolute(diagnosticZopfli), "PACKAGE_ARCHIVE_INVALID", "diagnostic Zopfli path must be absolute");
    await execFileAsync(diagnosticZopfli, ["--i15", "--gzip", rawArchivePath], { env: { PATH: "/usr/bin:/bin" }, maxBuffer: 64 * 1024 })
      .catch((error) => stagingFail("PACKAGE_ARCHIVE_INVALID", `diagnostic Zopfli failed: ${error.message}`));
    await rm(rawArchivePath, { force: true });
  }
  await chmod(archivePath, 0o600);
  await fsyncFile(archivePath);
  const plan = await inspectArchive(
    archivePath,
    DEFAULT_INSTALL_LIMITS,
    new Set(OPEN_DESIGN_EXECUTABLES),
    undefined,
    () => {},
  );
  stagingAssert(plan.entries.size === entries.length, "PACKAGE_ARCHIVE_INVALID", "Installer archive plan entry count differs from the deterministic plan");
  await auditDeterministicArchive(archivePath, entries);
}

async function auditDeterministicArchive(archivePath, expectedEntries) {
  const observed = [];
  await listTar({
    file: archivePath,
    gzip: true,
    strict: true,
    onentry(entry) {
      observed.push(entry);
    },
  });
  stagingAssert(observed.length === expectedEntries.length, "PACKAGE_ARCHIVE_INVALID", "tar entry count differs from the deterministic plan");
  for (let index = 0; index < expectedEntries.length; index += 1) {
    const expected = expectedEntries[index];
    const actual = observed[index];
    const actualPath = actual.path.endsWith("/") ? actual.path.slice(0, -1) : actual.path;
    const actualType = actual.type === "Directory" ? "directory" : actual.type === "File" || actual.type === "OldFile" ? "file" : "invalid";
    stagingAssert(actualPath === expected.path && actualType === expected.type, "PACKAGE_ARCHIVE_INVALID", `tar entry differs from plan at index ${index}`);
    stagingAssert(actual.mode === expected.mode, "PACKAGE_ARCHIVE_INVALID", `tar mode differs from plan: ${expected.path}`);
    stagingAssert((actual.uid === undefined || actual.uid === 0) && (actual.gid === undefined || actual.gid === 0), "PACKAGE_ARCHIVE_INVALID", `tar owner metadata is not fixed: ${expected.path}`);
    stagingAssert((actual.uname === undefined || actual.uname === "") && (actual.gname === undefined || actual.gname === ""), "PACKAGE_ARCHIVE_INVALID", `tar owner names are not fixed: ${expected.path}`);
    stagingAssert(actual.mtime === undefined || actual.mtime.getTime() === 0, "PACKAGE_ARCHIVE_INVALID", `tar mtime is not fixed: ${expected.path}`);
    stagingAssert(!actual.linkpath, "PACKAGE_ARCHIVE_INVALID", `tar link is forbidden: ${expected.path}`);
  }
}

function createValidatedManifest(archiveSha256, artifactUrl) {
  const input = {
    schemaVersion: 1,
    id: OPEN_DESIGN_MODULE_ID,
    version: OPEN_DESIGN_MODULE_VERSION,
    artifacts: [{
      platform: OPEN_DESIGN_MODULE_PLATFORM,
      entrypoint: OPEN_DESIGN_ENTRYPOINT,
      auxiliaryExecutables: [...OPEN_DESIGN_AUXILIARY_EXECUTABLES],
      url: artifactUrl,
      sha256: archiveSha256,
    }],
    capabilities: ["host-agent.use", "workspace.read", "workspace.write"],
  };
  const parsed = parseModuleManifest(input);
  if (!parsed.ok) stagingFail("PACKAGE_MANIFEST_INVALID", parsed.errors.map((error) => `${error.path}: ${error.message}`).join("; "));
  return parsed.value;
}

function verifyDevelopmentCatalog(catalogBytes, signature, verificationTimeMs, developmentIdentity) {
  const result = verifyModuleReleaseCatalog({
    schemaVersion: 1,
    keyId: developmentIdentity.keyId,
    catalogBytes,
    signature,
  }, {
    trustedKeys: [{
      keyId: developmentIdentity.keyId,
      publicKey: developmentIdentity.publicKey,
      activeFrom: developmentIdentity.activeFrom,
      activeUntil: developmentIdentity.activeUntil,
    }],
    state: { highestSequence: 0 },
    now: verificationTimeMs,
  });
  if (!result.ok) stagingFail("PACKAGE_CATALOG_INVALID", result.diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join("; "));
}

function createBundleDescriptor({ archiveSha256, archiveSize, envelopeBytes, extractedManifestSha256 }, developmentIdentity) {
  return {
    schemaVersion: 2,
    developmentOnly: true,
    nonPromotable: true,
    moduleId: OPEN_DESIGN_MODULE_ID,
    release: { version: OPEN_DESIGN_MODULE_VERSION, platform: OPEN_DESIGN_MODULE_PLATFORM },
    install: { extractedManifestSha256, hostVersionRange: OPEN_DESIGN_MIN_HOST_VERSION_RANGE },
    trustedKey: {
      developmentOnly: true,
      keyId: developmentIdentity.keyId,
      publicKey: Buffer.from(developmentIdentity.publicKey).toString("base64"),
      activeFrom: developmentIdentity.activeFrom,
      activeUntil: developmentIdentity.activeUntil,
    },
    resources: {
      catalog: {
        url: DEVELOPMENT_ONLY_CATALOG_URL,
        path: ENVELOPE_FILENAME,
        size: envelopeBytes.byteLength,
        sha256: sha256Bytes(envelopeBytes),
        etag: `"sha256:${sha256Bytes(envelopeBytes)}"`,
      },
      archive: {
        url: DEVELOPMENT_ONLY_ARCHIVE_URL,
        path: ARCHIVE_FILENAME,
        size: archiveSize,
        sha256: archiveSha256,
        etag: `"sha256:${archiveSha256}"`,
      },
    },
  };
}

async function loadDevelopmentIdentity() {
  const module = await import("./development-key.mjs");
  return Object.freeze({
    keyId: module.DEVELOPMENT_ONLY_KEY_ID,
    privateKeyPem: module.DEVELOPMENT_ONLY_PRIVATE_KEY_PEM,
    publicKey: module.developmentOnlyPublicKeyBytes(),
    activeFrom: module.DEVELOPMENT_ONLY_KEY_ACTIVE_FROM,
    activeUntil: module.DEVELOPMENT_ONLY_KEY_ACTIVE_UNTIL,
    testCatalogIssuedAt: module.DEVELOPMENT_ONLY_TEST_CATALOG_ISSUED_AT,
  });
}

async function writeExclusiveBytes(filename, bytes) {
  const handle = await open(filename, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600)
    .catch((error) => stagingFail("PACKAGE_WRITE_FAILED", error.message));
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.write(bytes, offset, bytes.length - offset, offset);
      stagingAssert(result.bytesWritten > 0, "PACKAGE_WRITE_FAILED", "output write made no progress");
      offset += result.bytesWritten;
    }
    await handle.sync().catch((error) => stagingFail("PACKAGE_DURABILITY_FAILED", error.message));
  } finally {
    await handle.close().catch(() => undefined);
  }
  await chmod(filename, 0o600);
}

async function verifyBundleFiles(bundleRoot, expected) {
  const names = [];
  const directory = await opendir(bundleRoot);
  for await (const entry of directory) names.push(entry.name);
  names.sort(compareUtf8);
  stagingAssert(names.join(",") === [...expected.keys()].sort(compareUtf8).join(","), "PACKAGE_OUTPUT_INVALID", "bundle output file set is unexpected");
  for (const [name, metadata] of expected) {
    const filename = path.join(bundleRoot, name);
    const info = await lstat(filename);
    stagingAssert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.uid === currentUid() && (info.mode & 0o777) === 0o600, "PACKAGE_OUTPUT_INVALID", `bundle output is not an owner-only regular file: ${name}`);
    stagingAssert(info.size === metadata.size, "PACKAGE_OUTPUT_INVALID", `bundle output size changed: ${name}`);
    stagingAssert(await hashRegularFile(filename, Math.max(metadata.size, 1), name) === metadata.sha256, "PACKAGE_OUTPUT_INVALID", `bundle output digest changed: ${name}`);
  }
}

async function verifyPublishedOutput(outputRoot, expectedFiles) {
  const info = await lstat(outputRoot);
  stagingAssert(info.isDirectory() && !info.isSymbolicLink() && info.uid === currentUid() && (info.mode & 0o777) === 0o700, "PACKAGE_OUTPUT_INVALID", "published output directory is not owner-only");
  const descriptor = JSON.parse(await readFile(path.join(outputRoot, BUNDLE_DESCRIPTOR_FILENAME), "utf8"));
  stagingAssert(descriptor.developmentOnly === true && descriptor.nonPromotable === true, "PACKAGE_OUTPUT_INVALID", "published output lost its development-only marker");
  await verifyBundleFiles(outputRoot, expectedFiles);
}

async function hashRegularFile(filename, maxBytes, label, algorithm = "sha256") {
  const pathInfo = await lstat(filename).catch((error) => stagingFail("PACKAGE_INPUT_INVALID", `${label}: ${error.message}`));
  stagingAssert(pathInfo.isFile() && !pathInfo.isSymbolicLink() && pathInfo.nlink === 1, "PACKAGE_INPUT_INVALID", `${label} must be an unlinked regular file`);
  stagingAssert(pathInfo.uid === currentUid() && pathInfo.size <= maxBytes, "PACKAGE_INPUT_LIMIT_EXCEEDED", `${label} exceeds ${maxBytes} bytes or is not owner-controlled`);
  const handle = await open(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)).catch((error) => stagingFail("PACKAGE_INPUT_INVALID", `${label}: ${error.message}`));
  try {
    const before = await handle.stat();
    stagingAssert(sameIdentity(pathInfo, before), "PACKAGE_INPUT_CHANGED", `${label} changed while opening`);
    const hash = createHash(algorithm);
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let bytes = 0;
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
      stagingAssert(bytes <= maxBytes, "PACKAGE_INPUT_LIMIT_EXCEEDED", `${label} exceeds ${maxBytes} bytes`);
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    const after = await handle.stat();
    const afterPath = await lstat(filename).catch((error) => stagingFail("PACKAGE_INPUT_CHANGED", `${label}: ${error.message}`));
    stagingAssert(sameIdentity(before, after) && sameIdentity(before, afterPath) && bytes === after.size, "PACKAGE_INPUT_CHANGED", `${label} changed while hashing`);
    return hash.digest("hex");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fsyncFile(filename) {
  const handle = await open(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)).catch((error) => stagingFail("PACKAGE_DURABILITY_FAILED", error.message));
  try {
    await handle.sync().catch((error) => stagingFail("PACKAGE_DURABILITY_FAILED", error.message));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function fsyncDirectory(directory) {
  const handle = await open(directory, fsConstants.O_RDONLY).catch((error) => stagingFail("PACKAGE_DURABILITY_FAILED", error.message));
  try {
    await handle.sync().catch((error) => stagingFail("PACKAGE_DURABILITY_FAILED", error.message));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function assertAbsent(filename, code) {
  const info = await lstat(filename).catch((error) => error.code === "ENOENT" ? null : stagingFail(code, error.message));
  stagingAssert(info == null, code, `path already exists: ${filename}`);
}

async function assertDirectoryContainsOnly(directory, expectedNames) {
  const actual = [];
  const handle = await opendir(directory);
  for await (const entry of handle) actual.push(entry.name);
  actual.sort(compareUtf8);
  stagingAssert(actual.join(",") === [...expectedNames].sort(compareUtf8).join(","), "PACKAGE_CLEANUP_FAILED", "transaction cleanup left unexpected paths");
}

function snapshotEntry(info, type) {
  return {
    type,
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    nlink: info.nlink,
    uid: info.uid,
    mode: info.mode,
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.nlink === right.nlink;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function currentUid() {
  stagingAssert(typeof process.getuid === "function", "PACKAGE_PLATFORM_UNSUPPORTED", "filesystem ownership checks require POSIX");
  return process.getuid();
}

// The production publisher reuses only these hardened filesystem/archive
// primitives. Development identity, URLs, markers, catalog shape and signing
// material remain private to the development entrypoint above.
export const OPEN_DESIGN_PACKAGE_PRIMITIVES = Object.freeze({
  createNodeRuntimePolicy,
  prepareOutputTarget,
  preflightSealedStaging,
  readJsonFromSnapshot,
  verifySealedStaging,
  inspectNodeInput,
  copySnapshotTree,
  copyRegularInput,
  normalizeAndVerifyAssembly,
  collectArchiveEntries,
  createDeterministicArchive,
  writeExclusiveBytes,
  verifyBundleFiles,
  hashRegularFile,
  sha256Bytes,
  fsyncDirectory,
  assertAbsent,
  assertDirectoryContainsOnly,
});
