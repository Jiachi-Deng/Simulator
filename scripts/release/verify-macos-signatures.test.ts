import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { classifyAllowedSignature, verifyMacOsSignatures, type Inspector } from "./verify-macos-signatures"

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

  test("checks every Mach-O and rejects a signed nested binary", () => {
    mkdirSync(join(app, "Contents", "Frameworks"), { recursive: true })
    writeFileSync(join(app, "Contents", "MacOS-Simulator"), "binary")
    writeFileSync(join(app, "Contents", "Frameworks", "nested"), "binary")
    writeFileSync(join(app, "Contents", "resource.txt"), "text")
    const inspect: Inspector = (path) => {
      if (path === app) return { description: "directory", architectures: "", signature: "code object is not signed at all" }
      if (path.endsWith("resource.txt")) return { description: "ASCII text", architectures: "", signature: "" }
      return {
        description: "Mach-O 64-bit executable arm64",
        architectures: "arm64",
        signature: path.endsWith("nested") ? "Authority=Developer ID Application: Example" : "Signature=adhoc\nTeamIdentifier=not set",
      }
    }
    expect(() => verifyMacOsSignatures(app, inspect)).toThrow("nested")
  })
})
