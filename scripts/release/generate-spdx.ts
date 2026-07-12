import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { basename } from "node:path"

interface LockedPackage { name: string; version: string }

export function packagesFromBunLock(content: string): LockedPackage[] {
  const packages = new Map<string, LockedPackage>()
  const pattern = /^\s*"[^"]+": \["((?:@[^/]+\/)?[^@"]+)@([^"\s]+)"/gm
  for (const match of content.matchAll(pattern)) {
    const item = { name: match[1], version: match[2] }
    packages.set(`${item.name}@${item.version}`, item)
  }
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

export function generateSpdx(lockContent: string, version: string, sourceSha: string, created: string): object {
  const packages = packagesFromBunLock(lockContent)
  const namespaceSeed = createHash("sha256").update(`${version}\n${sourceSha}\n${lockContent}`).digest("hex")
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `Simulator-${version}`,
    documentNamespace: `https://github.com/Jiachi-Deng/Simulator/spdx/${namespaceSeed}`,
    creationInfo: {
      created,
      creators: ["Tool: scripts/release/generate-spdx.ts"],
      comment: "Deterministic minimal SBOM derived from bun.lock package resolutions. It does not inspect bundled binaries, transitive runtime files, licenses, or packages copied outside Bun's lockfile.",
    },
    documentDescribes: ["SPDXRef-Package-Simulator"],
    packages: [
      {
        name: "Simulator",
        SPDXID: "SPDXRef-Package-Simulator",
        versionInfo: version,
        downloadLocation: `git+https://github.com/Jiachi-Deng/Simulator.git@${sourceSha}`,
        filesAnalyzed: false,
        licenseConcluded: "NOASSERTION",
        licenseDeclared: "Apache-2.0",
        copyrightText: "NOASSERTION",
      },
      ...packages.map((item, index) => ({
        name: item.name,
        SPDXID: `SPDXRef-Package-${index + 1}`,
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
    relationships: packages.map((_, index) => ({
      spdxElementId: "SPDXRef-Package-Simulator",
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: `SPDXRef-Package-${index + 1}`,
    })),
  }
}

if (import.meta.main) {
  const [lockPath, outputPath, version, sourceSha, created] = process.argv.slice(2)
  if (!lockPath || !outputPath || !version || !sourceSha || !created || Number.isNaN(Date.parse(created))) {
    throw new Error(`Usage: ${basename(process.argv[1])} LOCK OUTPUT VERSION SOURCE_SHA CREATED_ISO`)
  }
  const spdx = generateSpdx(readFileSync(lockPath, "utf8"), version, sourceSha, new Date(created).toISOString())
  writeFileSync(outputPath, `${JSON.stringify(spdx, null, 2)}\n`)
}
