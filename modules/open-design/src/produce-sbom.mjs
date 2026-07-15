import { createHash } from "node:crypto";
import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";

import { canonicalJsonBytes } from "./validate-artifact.mjs";
import { stagingAssert, stagingFail } from "./staging-error.mjs";

export async function produceSbom({ sourceRoot, artifactRoot, provenance, target } = {}) {
  stagingAssert(path.isAbsolute(sourceRoot ?? "") && path.isAbsolute(artifactRoot ?? ""), "SBOM_ROOT_INVALID", "source and artifact roots must be absolute");
  stagingAssert(Array.isArray(provenance?.sbom?.requiredPackages), "SBOM_PROVENANCE_INVALID", "pinned SBOM package requirements are missing");
  const source = await realpath(sourceRoot).catch((error) => stagingFail("SBOM_ROOT_INVALID", error.message));
  const artifact = await realpath(artifactRoot).catch((error) => stagingFail("SBOM_ROOT_INVALID", error.message));
  const lockPath = path.join(source, provenance.lockfile.path);
  const lockBytes = await readRegularFile(lockPath, "SBOM_LOCK_INVALID");
  const lockfileSha256 = createHash("sha256").update(lockBytes).digest("hex");
  stagingAssert(lockfileSha256 === provenance.lockfile.sha256, "SBOM_LOCK_MISMATCH", "pnpm lockfile does not match pinned provenance");
  const lock = parseLockfile(lockBytes);
  const observed = await collectPackageEvidence(artifact, provenance.sbom.requiredPackages);
  const packages = [];
  for (const pinned of [...provenance.sbom.requiredPackages].sort(comparePackage)) {
    const lockEntry = lock.packages?.[`${pinned.name}@${pinned.version}`];
    const integrity = lockEntry?.resolution?.integrity;
    stagingAssert(typeof integrity === "string" && integrity.startsWith("sha512-"), "SBOM_LOCK_RESOLUTION_MISSING", `lock resolution is missing: ${pinned.name}@${pinned.version}`);
    const contentSha512 = decodeSha512(integrity, pinned);
    stagingAssert(contentSha512 === pinned.contentSha512, "SBOM_CONTENT_DIGEST_MISMATCH", `lock content digest differs from provenance: ${pinned.name}@${pinned.version}`);
    const packageEvidence = observed.get(`${pinned.name}@${pinned.version}`);
    stagingAssert(packageEvidence != null, "SBOM_PACKAGE_MISSING", `staged runtime package is missing: ${pinned.name}@${pinned.version}`);
    stagingAssert(packageEvidence.licenseDeclared === pinned.licenseDeclared, "SBOM_LICENSE_MISMATCH", `staged package license differs from provenance: ${pinned.name}@${pinned.version}`);
    stagingAssert(packageEvidence.noticeStatus === pinned.noticeStatus, "SBOM_NOTICE_MISMATCH", `staged package notice status differs from provenance: ${pinned.name}@${pinned.version}`);
    const SPDXID = spdxId(pinned.name, pinned.version);
    packages.push({
      SPDXID,
      name: pinned.name,
      versionInfo: pinned.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      checksums: [{ algorithm: "SHA512", checksumValue: contentSha512 }],
      licenseConcluded: packageEvidence.licenseDeclared,
      licenseDeclared: packageEvidence.licenseDeclared,
      copyrightText: "NOASSERTION",
      comment: `notice=${packageEvidence.noticeStatus}`,
      externalRefs: [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: packagePurl(pinned.name, pinned.version) }],
    });
  }
  const namespaceKey = createHash("sha256").update(`${provenance.source.commit}\0${target.platform}\0${target.arch}\0${target.nodeAbi}\0${lockfileSha256}`).digest("hex");
  const document = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `open-design-${provenance.upstreamManifest.version}-${target.platform}-${target.arch}`,
    documentNamespace: `https://artifacts.simulator.invalid/spdx/open-design/${namespaceKey}`,
    creationInfo: { created: new Date(provenance.source.sourceDate).toISOString(), creators: ["Tool: Simulator OpenDesign SBOM producer"] },
    annotations: [{ annotationDate: new Date(provenance.source.sourceDate).toISOString(), annotationType: "OTHER", annotator: "Tool: Simulator OpenDesign SBOM producer", comment: `pnpm-lock.yaml sha256:${lockfileSha256}` }],
    documentDescribes: packages.map((entry) => entry.SPDXID),
    packages,
    relationships: packages.map((entry) => ({ spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: entry.SPDXID })),
  };
  const bytes = canonicalJsonBytes(document);
  return { document, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), lockfileSha256 };
}

function parseLockfile(bytes) {
  const document = parseDocument(bytes.toString("utf8"), { maxAliasCount: 0, prettyErrors: false, strict: true, uniqueKeys: true });
  stagingAssert(document.errors.length === 0 && document.warnings.length === 0, "SBOM_LOCK_INVALID", [...document.errors, ...document.warnings].map((entry) => entry.message).join("; "));
  const value = document.toJS({ maxAliasCount: 0, mapAsMap: false });
  stagingAssert(value?.lockfileVersion === "9.0" && value.packages && typeof value.packages === "object", "SBOM_LOCK_INVALID", "pnpm lockfile v9 packages map is required");
  return value;
}

async function collectPackageEvidence(artifactRoot, requiredPackages) {
  const required = new Set(requiredPackages.map((entry) => `${entry.name}@${entry.version}`));
  const found = new Map();
  await visit(artifactRoot, "");
  return found;

  async function visit(absoluteDirectory, relativeDirectory) {
    const before = await lstat(absoluteDirectory).catch((error) => stagingFail("SBOM_FILESYSTEM_ERROR", error.message));
    stagingAssert(before.isDirectory() && !before.isSymbolicLink(), "SBOM_SYMLINK_FORBIDDEN", `directory is not real: ${relativeDirectory || "."}`);
    const directory = await opendir(absoluteDirectory).catch((error) => stagingFail("SBOM_FILESYSTEM_ERROR", error.message));
    for await (const entry of directory) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(absoluteDirectory, entry.name);
      const stat = await lstat(absolutePath).catch((error) => stagingFail("SBOM_FILESYSTEM_ERROR", error.message));
      stagingAssert(!stat.isSymbolicLink(), "SBOM_SYMLINK_FORBIDDEN", `symlink is forbidden: ${relativePath}`);
      if (stat.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      stagingAssert(stat.isFile() && stat.nlink === 1, "SBOM_FILE_INVALID", `artifact leaf must be an unlinked regular file: ${relativePath}`);
      if (entry.name !== "package.json" || !relativePath.includes("/node_modules/")) continue;
      let manifest;
      try { manifest = JSON.parse(await readFile(absolutePath, "utf8")); }
      catch (error) { stagingFail("SBOM_PACKAGE_MANIFEST_INVALID", `${relativePath}: ${error.message}`); }
      const identity = `${manifest?.name}@${manifest?.version}`;
      if (!required.has(identity)) continue;
      stagingAssert(typeof manifest.license === "string" && manifest.license.length > 0, "SBOM_LICENSE_MISSING", `package license is missing: ${identity}`);
      const noticeStatus = await hasNoticeFile(path.dirname(absolutePath)) ? "PRESENT" : "NONE";
      const previous = found.get(identity);
      const evidence = { licenseDeclared: manifest.license, noticeStatus };
      stagingAssert(previous == null || JSON.stringify(previous) === JSON.stringify(evidence), "SBOM_PACKAGE_AMBIGUOUS", `staged package evidence differs across copies: ${identity}`);
      found.set(identity, evidence);
    }
    const after = await lstat(absoluteDirectory).catch((error) => stagingFail("SBOM_FILESYSTEM_ERROR", error.message));
    stagingAssert(sameIdentity(before, after), "SBOM_ARTIFACT_CHANGED", `directory changed while producing SBOM: ${relativeDirectory || "."}`);
  }
}

async function hasNoticeFile(packageRoot) {
  const directory = await opendir(packageRoot).catch((error) => stagingFail("SBOM_FILESYSTEM_ERROR", error.message));
  for await (const entry of directory) if (entry.isFile() && /^NOTICES?(?:[._-]|$)/iu.test(entry.name)) return true;
  return false;
}

async function readRegularFile(filename, code) {
  const stat = await lstat(filename).catch((error) => stagingFail(code, error.message));
  stagingAssert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, code, "input must be an unlinked regular file");
  return await readFile(filename).catch((error) => stagingFail(code, error.message));
}

function decodeSha512(integrity, pinned) {
  const digest = Buffer.from(integrity.slice("sha512-".length), "base64");
  stagingAssert(digest.length === 64, "SBOM_LOCK_RESOLUTION_INVALID", `invalid SHA512 integrity: ${pinned.name}@${pinned.version}`);
  return digest.toString("hex");
}

function spdxId(name, version) { return `SPDXRef-Package-${name.replace(/[^A-Za-z0-9.-]+/gu, "-")}-${version.replace(/[^A-Za-z0-9.-]+/gu, "-")}`; }
function packagePurl(name, version) { return `pkg:npm/${name.startsWith("@") ? `%40${name.slice(1)}` : name}@${version}`; }
function comparePackage(left, right) { return Buffer.compare(Buffer.from(`${left.name}@${left.version}`), Buffer.from(`${right.name}@${right.version}`)); }
function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs; }
