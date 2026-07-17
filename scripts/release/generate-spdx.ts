import { createHash } from "node:crypto"
import { Buffer } from "node:buffer"
import { readFileSync, writeFileSync } from "node:fs"
import { basename } from "node:path"

interface LockedPackage { name: string; version: string }
interface PackagedFile { path: string; sha256: string }

function compareUtf8Bytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
}

function isSafePackagedPath(path: string): boolean {
  return path.length > 0
    && !path.startsWith("/")
    && !path.includes("\\")
    && !/[\u0000-\u001f\u007f]/u.test(path)
    && !path.split("/").some((part) => !part || part === "." || part === "..")
    && Buffer.from(path, "utf8").toString("utf8") === path
}

export function packagesFromBunLock(content: string): LockedPackage[] {
  const packages = new Map<string, LockedPackage>()
  const pattern = /^\s*"[^"]+": \["((?:@[^/]+\/)?[^@"]+)@([^"\s]+)"/gm
  for (const match of content.matchAll(pattern)) {
    const item = { name: match[1], version: match[2] }
    packages.set(`${item.name}@${item.version}`, item)
  }
  return [...packages.values()].sort((a, b) => compareUtf8Bytes(a.name, b.name) || compareUtf8Bytes(a.version, b.version))
}

export function packagedFilesFromChecksums(content: string): PackagedFile[] {
  if (!content.endsWith("\n") || content.includes("\r")) {
    throw new Error("Packaged file checksums must be canonical LF-terminated text")
  }
  if (content === "\n") {
    throw new Error("Packaged file checksums must contain at least one entry")
  }

  const files = content.slice(0, -1).split("\n").map((line) => {
    const match = line.match(/^([0-9a-f]{64})  (.+)$/)
    if (!match || !isSafePackagedPath(match[2])) {
      throw new Error("Invalid packaged file checksum line")
    }
    return { path: match[2], sha256: match[1] }
  })
  for (let index = 1; index < files.length; index += 1) {
    if (compareUtf8Bytes(files[index - 1].path, files[index].path) >= 0) {
      throw new Error("Packaged file checksum paths must be unique and in canonical UTF-8 byte order")
    }
  }
  return files
}

export function packageVerificationCodeFromContent(content: string): string {
  const code = content.trim()
  if (!/^[0-9a-f]{40}$/.test(code)) throw new Error("Invalid SPDX package verification code")
  return code
}

export function generateSpdx(lockContent: string, inventoryContent: string, packageVerificationCodeContent: string, version: string, sourceSha: string, created: string): object {
  const packages = packagesFromBunLock(lockContent)
  const packagedFiles = packagedFilesFromChecksums(inventoryContent)
  const packageVerificationCode = packageVerificationCodeFromContent(packageVerificationCodeContent)
  const lockHash = createHash("sha256").update(lockContent).digest("hex")
  const namespaceSeed = createHash("sha256").update(`${version}\n${sourceSha}\n${lockHash}\n${inventoryContent}`).digest("hex")
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `Simulator-${version}`,
    documentNamespace: `https://github.com/Jiachi-Deng/Simulator/spdx/${namespaceSeed}`,
    creationInfo: {
      created,
      creators: ["Tool: scripts/release/generate-spdx.ts"],
      comment: "SPDX file entries describe regular artifact files present identically in the DMG and ZIP app bundles. The separate app-inventory.jsonl parity check compares transport-stable directory structure, regular-file and directory modes, symlink targets, ownership, flags, and extended attributes; it canonicalizes non-semantic symlink modes and an allowlist of macOS code-signing validation-cache attributes on non-executable regular files while retaining raw per-container inventories. Strict code-signature verification runs separately for both artifacts before comparison. This is not an SPDX file inventory, and licenses and runtime dependency reachability are not analyzed. bun.lock resolutions are recorded separately as source build inputs, not claimed runtime dependencies.",
    },
    documentDescribes: ["SPDXRef-Package-Simulator"],
    packages: [
      {
        name: "Simulator",
        SPDXID: "SPDXRef-Package-Simulator",
        versionInfo: version,
        downloadLocation: `git+https://github.com/Jiachi-Deng/Simulator.git@${sourceSha}`,
        filesAnalyzed: true,
        packageVerificationCode: { packageVerificationCodeValue: packageVerificationCode },
        licenseConcluded: "NOASSERTION",
        licenseDeclared: "Apache-2.0",
        copyrightText: "NOASSERTION",
        hasFiles: packagedFiles.map((_, index) => `SPDXRef-File-${index + 1}`),
      },
      {
        name: "Simulator source lock inventory",
        SPDXID: "SPDXRef-Package-SourceLock",
        versionInfo: sourceSha,
        downloadLocation: `git+https://github.com/Jiachi-Deng/Simulator.git@${sourceSha}`,
        filesAnalyzed: false,
        licenseConcluded: "NOASSERTION",
        licenseDeclared: "NOASSERTION",
        copyrightText: "NOASSERTION",
        comment: "Inventory of package resolutions parsed from bun.lock. Presence here means available to the monorepo build, not necessarily shipped or reachable at runtime.",
        externalRefs: [{
          referenceCategory: "OTHER",
          referenceType: "simulator-source-lock",
          referenceLocator: `bun.lock@sha256:${lockHash}`,
        }],
      },
      ...packages.map((item, index) => ({
        name: item.name,
        SPDXID: `SPDXRef-BuildPackage-${index + 1}`,
        versionInfo: item.version,
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: "NOASSERTION",
        licenseDeclared: "NOASSERTION",
        copyrightText: "NOASSERTION",
        externalRefs: [{
          referenceCategory: "PACKAGE-MANAGER",
          referenceType: "purl",
          referenceLocator: `pkg:npm/${encodeURIComponent(item.name).replace("%2F", "/")}@${encodeURIComponent(item.version)}`,
        }],
      })),
    ],
    files: packagedFiles.map((file, index) => ({
      fileName: `./app/${file.path}`,
      SPDXID: `SPDXRef-File-${index + 1}`,
      checksums: [{ algorithm: "SHA256", checksumValue: file.sha256 }],
      licenseConcluded: "NOASSERTION",
      licenseInfoInFiles: ["NOASSERTION"],
      copyrightText: "NOASSERTION",
    })),
    relationships: [
      ...packagedFiles.map((_, index) => ({
        spdxElementId: "SPDXRef-Package-Simulator",
        relationshipType: "CONTAINS",
        relatedSpdxElement: `SPDXRef-File-${index + 1}`,
      })),
      ...packages.map((_, index) => ({
        spdxElementId: `SPDXRef-BuildPackage-${index + 1}`,
        relationshipType: "BUILD_DEPENDENCY_OF",
        relatedSpdxElement: "SPDXRef-Package-Simulator",
        comment: "Source-lock relationship only; this does not assert the package is present in the built artifact.",
      })),
      ...packages.map((_, index) => ({
        spdxElementId: "SPDXRef-Package-SourceLock",
        relationshipType: "CONTAINS",
        relatedSpdxElement: `SPDXRef-BuildPackage-${index + 1}`,
      })),
    ],
  }
}

if (import.meta.main) {
  const [lockPath, inventoryPath, packageVerificationCodePath, outputPath, version, sourceSha, created] = process.argv.slice(2)
  if (!lockPath || !inventoryPath || !packageVerificationCodePath || !outputPath || !version || !sourceSha || !created || Number.isNaN(Date.parse(created))) {
    throw new Error(`Usage: ${basename(process.argv[1])} LOCK PACKAGED_CHECKSUMS PACKAGE_VERIFICATION_CODE OUTPUT VERSION SOURCE_SHA CREATED_ISO`)
  }
  const spdx = generateSpdx(
    readFileSync(lockPath, "utf8"),
    readFileSync(inventoryPath, "utf8"),
    readFileSync(packageVerificationCodePath, "utf8"),
    version,
    sourceSha,
    new Date(created).toISOString(),
  )
  writeFileSync(outputPath, `${JSON.stringify(spdx, null, 2)}\n`)
}
