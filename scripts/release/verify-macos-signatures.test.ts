import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildMacOsSignatureEvidence, classifyAllowedSignature, inspectDeveloperIdSignature, parseEntitlements, parseMachOFileType, requireArm64MachO, verifyMacOsSignatures, type Inspector } from "./verify-macos-signatures"

const app = join(import.meta.dir, ".tmp-signatures", "Simulator.app")
afterEach(() => rmSync(join(import.meta.dir, ".tmp-signatures"), { recursive: true, force: true }))

describe("unsigned engineering RC signature policy", () => {
  test("allows absent and strict ad hoc signatures", () => {
    expect(classifyAllowedSignature("code object is not signed at all")).toBe("unsigned")
    expect(classifyAllowedSignature("Executable=x\nSignature=adhoc\nTeamIdentifier=not set")).toBe("adhoc")
  })

  test.each([
    "Authority=Developer ID Application: Example Corp (TEAMID)",
    "Authority=Apple Distribution: Example Corp (TEAMID)",
    "Authority=Third Party Authority\nSignature=adhoc\nTeamIdentifier=not set",
    "Signature=adhoc\nTeamIdentifier=TEAMID",
  ])("rejects certificate or ambiguous signature output", (output) => {
    expect(() => classifyAllowedSignature(output)).toThrow()
  })

  test("parses the structured Mach-O filetype column", () => {
    expect(parseMachOFileType(`Simulator:\nMach header\nmagic cputype cpusubtype caps filetype ncmds sizeofcmds flags\nMH_MAGIC_64 ARM64 ALL 0x00 EXECUTE 16 1056 NOUNDEFS`)).toBe("EXECUTE")
    expect(() => parseMachOFileType("Mach header\nmissing values")).toThrow("filetype header")
  })

  test("checks every Mach-O and rejects a signed nested binary", () => {
    mkdirSync(join(app, "Contents", "Frameworks"), { recursive: true })
    writeFileSync(join(app, "Contents", "MacOS-Simulator"), "binary")
    writeFileSync(join(app, "Contents", "Frameworks", "nested"), "binary")
    writeFileSync(join(app, "Contents", "resource.txt"), "text")
    const inspect: Inspector = (path) => {
      if (path === app) return { description: "directory", architectures: "", signature: "code object is not signed at all", verification: { exitCode: 1, output: "unsigned" } }
      if (path.endsWith("resource.txt")) return { description: "ASCII text", architectures: "", signature: "", verification: { exitCode: 1, output: "not code" } }
      return {
        description: "Mach-O 64-bit executable arm64",
        architectures: "arm64",
        signature: path.endsWith("nested") ? "Authority=Developer ID Application: Example" : "Signature=adhoc\nTeamIdentifier=not set",
        verification: { exitCode: 0, output: "valid" },
      }
    }
    expect(() => verifyMacOsSignatures(app, inspect)).toThrow("nested")
  })

  test("rejects ad hoc metadata when strict codesign verification fails", () => {
    mkdirSync(join(app, "Contents", "Frameworks"), { recursive: true })
    writeFileSync(join(app, "Contents", "Frameworks", "nested"), "binary")
    const inspect: Inspector = (path) => ({
      description: path === app ? "directory" : "Mach-O 64-bit executable arm64",
      architectures: path === app ? "" : "arm64",
      signature: "Signature=adhoc\nTeamIdentifier=not set",
      verification: path === app
        ? { exitCode: 0, output: "valid" }
        : { exitCode: 1, output: "a sealed resource is missing or invalid" },
    })
    expect(() => verifyMacOsSignatures(app, inspect)).toThrow("Strict ad hoc signature verification failed")
  })

  test("rejects a caller-supplied symlink App root before inspecting code objects", () => {
    mkdirSync(app, { recursive: true })
    const alias = join(import.meta.dir, ".tmp-signatures", "Simulator-alias.app")
    symlinkSync(app, alias)
    let inspected = false
    expect(() => verifyMacOsSignatures(alias, () => {
      inspected = true
      throw new Error("must not inspect")
    })).toThrow("real directory")
    expect(inspected).toBe(false)
  })

  test("emits stable per-object evidence with relative unique paths", () => {
    const first = join(app, "Contents", "Frameworks", "A.dylib")
    const second = join(app, "Contents", "MacOS", "Simulator")
    mkdirSync(join(app, "Contents", "Frameworks"), { recursive: true })
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true })
    writeFileSync(first, "binary-a")
    writeFileSync(second, "binary-b")
    const inspect: Inspector = (path) => ({
      description: path === app ? "directory" : "Mach-O 64-bit executable arm64",
      architectures: path === app ? "" : "arm64",
      signature: "Signature=adhoc\nTeamIdentifier=not set",
      verification: { exitCode: 0, output: "valid" },
    })

    const result = verifyMacOsSignatures(app, inspect)
    expect(result.machOCount).toBe(2)
    expect(result.objects).toEqual([
      { path: ".", kind: "adhoc", architectures: [], strictVerification: { required: true, exitCode: 0 } },
      { path: "Contents/Frameworks/A.dylib", kind: "adhoc", architectures: ["arm64"], strictVerification: { required: true, exitCode: 0 } },
      { path: "Contents/MacOS/Simulator", kind: "adhoc", architectures: ["arm64"], strictVerification: { required: true, exitCode: 0 } },
    ])
    expect(new Set(result.objects.map((object) => object.path)).size).toBe(result.objects.length)
    expect(requireArm64MachO(result, "Contents/MacOS/Simulator", "EXECUTE")).toEqual(result.objects[2])
    expect(() => requireArm64MachO(result, "Contents/MacOS/Missing", "EXECUTE")).toThrow("missing or ambiguous")
    expect(() => requireArm64MachO({
      ...result,
      objects: [{ ...result.objects[2], architectures: ["x86_64"] }],
    }, "Contents/MacOS/Simulator", "EXECUTE")).toThrow("missing or ambiguous")
    expect(() => requireArm64MachO(result, "Contents/MacOS/Simulator", "DYLIB")).toThrow("missing or ambiguous")
    expect(() => requireArm64MachO({
      ...result,
      objects: [result.objects[2], result.objects[2]],
    }, "Contents/MacOS/Simulator", "EXECUTE")).toThrow("missing or ambiguous")
    expect(buildMacOsSignatureEvidence(result, "Contents/MacOS/Simulator", "EXECUTE")).toMatchObject({
      ok: true,
      policy: "unsigned-or-strictly-verified-adhoc",
      requiredArm64MachOPath: "Contents/MacOS/Simulator",
      requiredArm64MachOFileType: "EXECUTE",
    })
    expect(() => buildMacOsSignatureEvidence(result, "Contents/MacOS/Simulator")).toThrow("provided together")
    expect(() => buildMacOsSignatureEvidence(result, "", "")).toThrow("must not be empty")
  })
})

describe("Developer ID acceptance signature policy", () => {
  const authority = "Developer ID Application: Example Corporation (ABCDE12345)"
  const signature = [
    "Executable=/Applications/Simulator.app/Contents/MacOS/Simulator",
    `Authority=${authority}`,
    "Authority=Developer ID Certification Authority",
    "Authority=Apple Root CA",
    "Timestamp=Jul 17, 2026 at 12:34:56",
    "TeamIdentifier=ABCDE12345",
    "CodeDirectory v=20500 size=472719 flags=0x10000(runtime) hashes=14762+7 location=embedded",
  ].join("\n")
  const reviewedEntitlements = {
    "com.apple.security.cs.allow-jit": true,
    "com.apple.security.cs.allow-unsigned-executable-memory": true,
    "com.apple.security.cs.disable-library-validation": true,
  }

  test("requires exact leaf subject, team, timestamp, and hardened runtime", () => {
    expect(inspectDeveloperIdSignature(signature, authority, "ABCDE12345")).toEqual({
      authority,
      teamIdentifier: "ABCDE12345",
      timestamped: true,
      hardenedRuntime: true,
    })
    expect(() => inspectDeveloperIdSignature(signature, authority.replace("Example", "Other"), "ABCDE12345")).toThrow("leaf authority")
    expect(() => inspectDeveloperIdSignature(signature.replace("Timestamp=", "Signed="), authority, "ABCDE12345")).toThrow("timestamp")
    expect(() => inspectDeveloperIdSignature(signature.replace("(runtime)", "(none)"), authority, "ABCDE12345")).toThrow("hardened runtime")
    expect(() => inspectDeveloperIdSignature(signature.replace("(runtime)", "(adhoc,runtime)"), authority, "ABCDE12345")).toThrow("ad hoc")
    expect(() => inspectDeveloperIdSignature(signature, authority, "ZZZZZ99999")).toThrow("TeamIdentifier")
  })

  test("parses JSON evidence fixtures and empty entitlements", () => {
    expect(parseEntitlements(JSON.stringify(reviewedEntitlements))).toEqual(reviewedEntitlements)
    expect(parseEntitlements("Executable=x does not have an entitlements blob")).toEqual({})
    expect(() => parseEntitlements("not a plist")).toThrow("no plist")
  })

  test("verifies the app and every nested Mach-O under the parameterized Developer ID policy", () => {
    const executable = join(app, "Contents", "MacOS", "Simulator")
    const dylib = join(app, "Contents", "Frameworks", "A.dylib")
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true })
    mkdirSync(join(app, "Contents", "Frameworks"), { recursive: true })
    writeFileSync(executable, "main")
    writeFileSync(dylib, "library")
    const inspect: Inspector = (path) => ({
      description: path === app ? "bundle" : path === executable ? "Mach-O 64-bit executable arm64" : "Mach-O 64-bit dynamically linked shared library arm64",
      architectures: path === app ? "" : "arm64",
      signature,
      verification: { exitCode: 0, output: "valid" },
      entitlements: path === dylib ? "" : JSON.stringify({
        ...reviewedEntitlements,
        "com.apple.developer.team-identifier": "ABCDE12345",
        "com.apple.application-identifier": "ABCDE12345.com.example.simulator",
      }),
    })
    const result = verifyMacOsSignatures(app, inspect, {
      mode: "developer-id",
      expectedAuthority: authority,
      expectedTeamIdentifier: "ABCDE12345",
      expectedBundleIdentifier: "com.example.simulator",
      actualBundleIdentifier: "com.example.simulator",
      expectedEntitlements: reviewedEntitlements,
    })
    expect(result.kinds).toEqual(["developer-id", "developer-id", "developer-id"])
    expect(result.objects.every((object) => object.strictVerification.exitCode === 0)).toBe(true)
    expect(result.objects[0].developerId).toMatchObject({
      authority,
      teamIdentifier: "ABCDE12345",
      timestamped: true,
      hardenedRuntime: true,
    })
    expect(buildMacOsSignatureEvidence(result, undefined, undefined, "developer-id-strict", {
      authority,
      teamIdentifier: "ABCDE12345",
      bundleIdentifier: "com.example.simulator",
      entitlementsSha256: "a".repeat(64),
    })).toMatchObject({
      policy: "developer-id-strict",
      developerId: {
        authority,
        teamIdentifier: "ABCDE12345",
        bundleIdentifier: "com.example.simulator",
        entitlementsSha256: "a".repeat(64),
      },
    })
  })

  test("fails closed on Bundle ID, unknown entitlements, missing executable entitlements, and nested identity drift", () => {
    const executable = join(app, "Contents", "MacOS", "Simulator")
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true })
    writeFileSync(executable, "main")
    const basePolicy = {
      mode: "developer-id" as const,
      expectedAuthority: authority,
      expectedTeamIdentifier: "ABCDE12345",
      expectedBundleIdentifier: "com.example.simulator",
      actualBundleIdentifier: "com.example.simulator",
      expectedEntitlements: reviewedEntitlements,
    }
    const inspector = (entitlements: string, nestedSignature = signature): Inspector => (path) => ({
      description: path === app ? "bundle" : "Mach-O 64-bit executable arm64",
      architectures: path === app ? "" : "arm64",
      signature: path === app ? signature : nestedSignature,
      verification: { exitCode: 0, output: "valid" },
      entitlements,
    })
    expect(() => verifyMacOsSignatures(app, inspector(JSON.stringify(reviewedEntitlements)), {
      ...basePolicy,
      actualBundleIdentifier: "com.attacker.app",
    })).toThrow("Bundle ID differs")
    expect(() => verifyMacOsSignatures(app, inspector(JSON.stringify({ ...reviewedEntitlements, "com.apple.security.network.server": true })), basePolicy)).toThrow("Unreviewed entitlement")
    expect(() => verifyMacOsSignatures(app, inspector(""), basePolicy)).toThrow("Reviewed entitlement")
    expect(() => verifyMacOsSignatures(app, inspector(JSON.stringify(reviewedEntitlements), signature.replace("ABCDE12345", "ZZZZZ99999")), basePolicy)).toThrow()

    const appIdentityDrift = JSON.stringify({
      ...reviewedEntitlements,
      "com.apple.developer.team-identifier": "ABCDE12345",
      "com.apple.application-identifier": "ABCDE12345.com.example.simulator.helper",
    })
    expect(() => verifyMacOsSignatures(app, inspector(appIdentityDrift), basePolicy)).toThrow("application identifier")

    const exactAppIdentity = JSON.stringify({
      ...reviewedEntitlements,
      "com.apple.developer.team-identifier": "ABCDE12345",
      "com.apple.application-identifier": "ABCDE12345.com.example.simulator",
    })
    const nestedIdentityInspector: Inspector = (path) => ({
      description: path === app ? "bundle" : "Mach-O 64-bit executable arm64",
      architectures: path === app ? "" : "arm64",
      signature,
      verification: { exitCode: 0, output: "valid" },
      entitlements: path === app ? exactAppIdentity : JSON.stringify({
        ...reviewedEntitlements,
        "com.apple.developer.team-identifier": "ABCDE12345",
        "com.apple.application-identifier": "ABCDE12345.com.attacker.app",
      }),
    })
    expect(() => verifyMacOsSignatures(app, nestedIdentityInspector, basePolicy)).toThrow("application identifier")
    const emptyNestedIdentityInspector: Inspector = (path) => ({
      description: path === app ? "bundle" : "Mach-O 64-bit executable arm64",
      architectures: path === app ? "" : "arm64",
      signature,
      verification: { exitCode: 0, output: "valid" },
      entitlements: path === app ? exactAppIdentity : JSON.stringify({
        ...reviewedEntitlements,
        "com.apple.developer.team-identifier": "ABCDE12345",
        "com.apple.application-identifier": "ABCDE12345.com.example.simulator.",
      }),
    })
    expect(() => verifyMacOsSignatures(app, emptyNestedIdentityInspector, basePolicy)).toThrow("application identifier")
  })

  test("accepts the exact App identity and an anchored nested helper identity", () => {
    const executable = join(app, "Contents", "MacOS", "Simulator")
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true })
    writeFileSync(executable, "main")
    const inspect: Inspector = (path) => ({
      description: path === app ? "bundle" : "Mach-O 64-bit executable arm64",
      architectures: path === app ? "" : "arm64",
      signature,
      verification: { exitCode: 0, output: "valid" },
      entitlements: JSON.stringify({
        ...reviewedEntitlements,
        "com.apple.developer.team-identifier": "ABCDE12345",
        "com.apple.application-identifier": path === app
          ? "ABCDE12345.com.example.simulator"
          : "ABCDE12345.com.example.simulator.helper",
      }),
    })

    expect(verifyMacOsSignatures(app, inspect, {
      mode: "developer-id",
      expectedAuthority: authority,
      expectedTeamIdentifier: "ABCDE12345",
      expectedBundleIdentifier: "com.example.simulator",
      actualBundleIdentifier: "com.example.simulator",
      expectedEntitlements: reviewedEntitlements,
    }).kinds).toEqual(["developer-id", "developer-id"])
  })
})
