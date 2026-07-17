import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const verifier = readFileSync(join(import.meta.dir, "verify-packaged-macos-runtimes.sh"), "utf8")

describe("packaged macOS runtime reference verification", () => {
  test("requires both runtime paths and the copied uv closure", () => {
    expect(verifier).toContain('Contents/Resources/app/vendor/bun/bun')
    expect(verifier).toContain('Contents/Resources/app/resources/bin/darwin-arm64/uv')
    expect(verifier).toContain('Contents/Resources/app/dist/resources/bin/darwin-arm64/uv')
    expect(verifier).toContain("metadata.st_nlink != 1")
    expect(verifier).toContain("0xFEEDFACF")
    expect(verifier).toContain("0x0100000C")
    expect(verifier).toContain("file_type != 2")
  })

  test("preserves exact ad-hoc reference CDHash and byte identity in unsigned mode", () => {
    expect(verifier).toContain("14b0008f960ea480de5d25df5ea0ada0fefa086a15e360ef2d305f44cae8f904")
    expect(verifier).toContain("240a5881367c38cbdfac25cad5d8cff2459a730339225e9373028d4453bebe05")
    expect(verifier).toContain("codesign --verify --strict --verbose=4")
    expect(verifier).toContain("--timestamp=none --options runtime")
    expect(verifier).toContain('--entitlements "$ENTITLEMENTS" "$reference"')
    expect(verifier).not.toContain('--identifier "$identifier"')
    expect(verifier).toContain('reference="$reference_dir/$identifier_prefix"')
    expect(verifier).toContain('[[ "$reference_identifier" == "$identifier" ]]')
    expect(verifier).toContain('[[ "$reference_cdhash" == "$packaged_cdhash" ]]')
    expect(verifier).toContain('[[ "$reference_cdhash_full" == "$packaged_cdhash_full" ]]')
    expect(verifier).toContain("CandidateCDHashFull sha256=")
    expect(verifier).toContain('cmp -s "$reference" "$packaged"')
    expect(verifier).toContain("flags=0x10002(adhoc,runtime)")
    expect(verifier).toContain("TeamIdentifier=not set")
  })

  test("preserves unsigned mode while adding an explicit fail-closed Developer ID mode", () => {
    expect(verifier).toContain('MODE=${SIMULATOR_MACOS_RUNTIME_SIGNATURE_MODE:-unsigned}')
    expect(verifier).toContain('IDENTITY=${SIMULATOR_MACOS_RUNTIME_DEVELOPER_IDENTITY:-}')
    expect(verifier).toContain('TEAM_ID=${SIMULATOR_MACOS_RUNTIME_TEAM_ID:-}')
    expect(verifier).toContain('developer-id)')
    expect(verifier).toContain('[[ "$IDENTITY" == "Developer ID Application: "* ]]')
    expect(verifier).toContain('[[ "$TEAM_ID" =~ ^[A-Z0-9]{10}$ ]]')
    expect(verifier).toContain("Developer ID leaf authority mismatch")
    expect(verifier).toContain("Developer ID TeamIdentifier mismatch")
    expect(verifier).toContain("'^Timestamp=.+'")
    expect(verifier).toContain("'^CodeDirectory .* flags=0x[0-9a-fA-F]+\\([^)]*runtime[^)]*\\)'")
    expect(verifier).toContain("'^CodeDirectory .* flags=0x[0-9a-fA-F]+\\([^)]*adhoc[^)]*\\)'")
    expect(verifier).not.toContain('codesign --force --sign "$IDENTITY"')
    expect(verifier).not.toContain("codesign --remove-signature")
    expect(verifier).toContain("compare-macos-app-payloads.py\" canonical-macho")
    expect(verifier).toContain("Canonical LC_CODE_SIGNATURE-normalized pinned runtime payload mismatch")
  })

  test("uses CDHash equality only for the deterministic unsigned path, never as a Developer ID oracle", () => {
    const unsignedComparison = verifier.indexOf('if [[ "$MODE" == unsigned ]]; then\n    [[ "$reference_identifier" == "$identifier" ]]')
    const developerPayloadComparison = verifier.indexOf('packaged_payload=$(python3')
    expect(unsignedComparison).toBeGreaterThan(0)
    expect(developerPayloadComparison).toBeGreaterThan(unsignedComparison)
    expect(verifier.indexOf('[[ "$reference_cdhash" == "$packaged_cdhash" ]]')).toBeGreaterThan(unsignedComparison)
    expect(verifier.indexOf('[[ "$reference_cdhash_full" == "$packaged_cdhash_full" ]]')).toBeGreaterThan(unsignedComparison)
    expect(verifier.slice(developerPayloadComparison)).not.toContain('reference_cdhash" == "$packaged_cdhash')
  })

  test("never launches the downloaded artifact runtime", () => {
    expect(verifier).toContain('"$TRUSTED_BUN" --version')
    expect(verifier).toContain('"$TRUSTED_UV" --version')
    expect(verifier).not.toContain('"$packaged" --version')
    expect(verifier).not.toContain('"$packaged" --revision')
  })
})
