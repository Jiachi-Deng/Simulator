import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildMacOsSignatureEvidence, classifyAllowedSignature, parseMachOFileType, requireArm64MachO, verifyMacOsSignatures, type Inspector } from "./verify-macos-signatures"

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
