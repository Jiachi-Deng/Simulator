import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { basename } from "node:path"

interface LockedPackage { name: string; version: string }
interface PackagedFile { path: string; sha256: string }

export function packagesFromBunLock(content: string): LockedPackage[] {
  const packages = new Map<string, LockedPackage>()
  const pattern = /^\s*"[^"]+": \["((?:@[^/]+\/)?[^@"]+)@([^"\s]+)"/gm
  for (const match of content.matchAll(pattern)) {
    const item = { name: match[1], version: match[2] }
    packages.set(`${item.name}@${item.version}`, item)
  }
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

export function packagedFilesFromChecksums(content: string): PackagedFile[] {
  const files = content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([0-9a-f]{64})  (.+)$/)
      if (!match || match[2].startsWith("/") || match[2].split("/").includes("..")) {
        throw new Error(`Invalid packaged file checksum line: ${line}`)
      }
      return { path: match[2], sha256: match[1] }
    })
  return files.sort((a, b) => a.path.localeCompare(b.path))
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
      comment: "SPDX file entries describe regular artifact files present identically in the DMG and ZIP app bundles. The separate app-inventory.jsonl parity check compares directory structure, symlink targets, modes, ownership, flags, and extended attributes; it is not an SPDX file inventory. Code-signing structures, licenses, and runtime dependency reachability are not analyzed. bun.lock resolutions are recorded separately as source build inputs, not claimed runtime dependencies.",
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
