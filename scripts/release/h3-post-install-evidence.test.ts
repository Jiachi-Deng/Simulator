import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  H3_SYSTEM_COMMAND_LIMITS,
  H3_SYSTEM_EXECUTABLES,
  canonicalH3PostInstallEvidence,
  createH3SystemCommandInvocation,
  formatH3SystemCommandFailure,
  generateH3PostInstallEvidence,
  validateH3CandidateArtifactAuthority,
  validateH3PostInstallEvidence,
  validateH3PostInstallHumanInput,
  verifyH3PostInstallEvidenceFile,
  writeH3PostInstallEvidence,
  type H3CandidateArtifactAuthority,
  type H3PostInstallEvidence,
  type H3PostInstallHumanInput,
  type H3PostInstallInspector,
  type H3SystemCommandResult,
} from "./h3-post-install-evidence"

const root = join(import.meta.dir, ".tmp-h3-post-install")
const sourceSha = "a".repeat(40)
const artifactName = `simulator-host-0.12.0-macos-arm64-developer-id-candidate-${sourceSha}`
const authority: H3CandidateArtifactAuthority = {
  artifactName,
  artifactId: "67890",
  artifactDigest: `sha256:${"b".repeat(64)}`,
  runId: "12345",
}
const human: H3PostInstallHumanInput = {
  environmentKind: "clean-vm",
  existingAppBeforeInstall: false,
  backupPath: "N/A",
  restoreStatus: "NOT NEEDED",
}
const fixedNow = () => new Date("2026-07-17T12:34:56.789Z")
const inspector: H3PostInstallInspector = {
  inspect(rawArtifactArchivePath, dmgPath, acceptedAuthority, installedAppPath, acceptedHuman) {
    expect(rawArtifactArchivePath).toBe("/verified/raw-candidate.zip")
    expect(dmgPath).toBe("/verified/Simulator-arm64.dmg")
    expect(acceptedAuthority).toEqual(authority)
    expect(installedAppPath).toBe("/Applications/Simulator.app")
    expect(acceptedHuman).toEqual(human)
    return {
      sourceSha,
      hostBuildRunId: "12345",
      artifactName,
      dmgPath,
      dmgBytes: 123456789,
      dmgSha256: "c".repeat(64),
      macOSVersion: "15.5 (24F74)",
      bundleIdentifier: "com.example.simulator",
      hostVersion: "0.12.0",
      appBundleVersion: "0.12.0",
      canonicalInventorySha256: "d".repeat(64),
      installedAppIdentitySha256: "e".repeat(64),
      backupIdentitySha256: "N/A",
      developerIdApplication: "Developer ID Application: Example Corporation (ABCDE12345)",
      teamId: "ABCDE12345",
    }
  },
}

const evidence: H3PostInstallEvidence = generateH3PostInstallEvidence(
  "/verified/raw-candidate.zip",
  "/verified/Simulator-arm64.dmg",
  authority,
  human,
  inspector,
  fixedNow,
)

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("H3 post-install evidence", () => {
  test("derives the exact non-secret v1 contract from authenticated authority and machine inspection", () => {
    expect(validateH3CandidateArtifactAuthority(authority)).toEqual(authority)
    expect(validateH3PostInstallHumanInput(human)).toEqual(human)
    expect(validateH3PostInstallEvidence(evidence)).toEqual(evidence)
    expect(evidence).toMatchObject({
      sourceSha,
      hostBuildRunId: authority.runId,
      artifactName,
      artifactId: authority.artifactId,
      artifactDigest: authority.artifactDigest,
      installedPath: "/Applications/Simulator.app",
      deepSignatureValid: true,
      gatekeeperAssessment: "PASS",
      notarization: "PASS",
      stapling: "PASS",
    })
    expect(canonicalH3PostInstallEvidence(evidence)).toEndWith("\n")
    const schema = JSON.parse(readFileSync(join(import.meta.dir, "schemas", "h3-post-install-v1.schema.json"), "utf8"))
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required.sort()).toEqual(Object.keys(evidence).sort())
    expect(schema.properties.installedPath.const).toBe("/Applications/Simulator.app")
    expect(schema.properties.artifactName.pattern).toContain("developer-id-candidate")
    expect(schema.properties.artifactDigest.pattern).toBe("^sha256:[0-9a-f]{64}$")
  })

  test("rejects caller-supplied PASS/hash/identity claims and derives backup identity through the Inspector", () => {
    expect(() => validateH3PostInstallHumanInput({
      ...human,
      deepSignatureValid: true,
      gatekeeperAssessment: "PASS",
      notarization: "PASS",
      stapling: "PASS",
      dmgSha256: "f".repeat(64),
      developerIdApplication: "Developer ID Application: Forged (ABCDE12345)",
    })).toThrow("human input keys differ")
    expect(() => validateH3PostInstallHumanInput({ ...human, backupIdentitySha256: "f".repeat(64) })).toThrow("human input keys differ")

    const withBackup: H3PostInstallHumanInput = {
      environmentKind: "second-mac",
      existingAppBeforeInstall: true,
      backupPath: "/Users/test/Backups/Simulator.app",
      restoreStatus: "PENDING",
    }
    let inspectedBackup = false
    const backupInspector: H3PostInstallInspector = {
      inspect(rawArtifactArchivePath, dmgPath, acceptedAuthority, installedAppPath, acceptedHuman) {
        inspectedBackup = acceptedHuman === withBackup
        return {
          ...inspector.inspect(rawArtifactArchivePath, dmgPath, acceptedAuthority, installedAppPath, human),
          backupIdentitySha256: "f".repeat(64),
        }
      },
    }
    const generated = generateH3PostInstallEvidence(
      "/verified/raw-candidate.zip", "/verified/Simulator-arm64.dmg", authority, withBackup, backupInspector, fixedNow,
    )
    expect(inspectedBackup).toBe(true)
    expect(generated.backupIdentitySha256).toBe("f".repeat(64))
  })

  test("rejects authority and derived Candidate identity drift", () => {
    expect(() => validateH3CandidateArtifactAuthority({ ...authority, extra: true })).toThrow("authority keys differ")
    expect(() => validateH3CandidateArtifactAuthority({ ...authority, artifactDigest: "b".repeat(64) })).toThrow("artifactDigest")
    const drifted: H3PostInstallInspector = {
      inspect(...args) {
        return { ...inspector.inspect(...args), hostBuildRunId: "99999" }
      },
    }
    expect(() => generateH3PostInstallEvidence(
      "/verified/raw-candidate.zip", "/verified/Simulator-arm64.dmg", authority, human, drifted, fixedNow,
    )).toThrow("authority differs")
  })

  test("rejects unknown fields, identity drift, noncanonical time, negative gates, and secret-shaped material", () => {
    expect(() => validateH3PostInstallEvidence({ ...evidence, extra: true })).toThrow("keys differ")
    expect(() => validateH3PostInstallEvidence({ ...evidence, teamId: "ZZZZZ99999" })).toThrow("subject and Team ID")
    expect(() => validateH3PostInstallEvidence({ ...evidence, installedAt: "2026-07-17T12:34:56Z" })).toThrow("installedAt")
    expect(() => validateH3PostInstallEvidence({ ...evidence, gatekeeperAssessment: "FAIL" })).toThrow("trust gates")
    expect(() => validateH3PostInstallEvidence({ ...evidence, dmgPath: "/tmp/-----BEGIN PRIVATE KEY-----/Simulator-arm64.dmg" })).toThrow("secret-shaped")
  })

  test("requires backup path, derived identity, and restore state to agree with pre-existing App state", () => {
    expect(() => validateH3PostInstallHumanInput({ ...human, existingAppBeforeInstall: true })).toThrow("Backup evidence differs")
    expect(() => validateH3PostInstallHumanInput({ ...human, restoreStatus: "PENDING" })).toThrow("No-backup")
    expect(() => validateH3PostInstallEvidence({
      ...evidence,
      existingAppBeforeInstall: true,
      backupPath: "/Users/test/Backups/Simulator.app",
      backupIdentitySha256: "N/A",
      restoreStatus: "PENDING",
    })).toThrow("backupIdentitySha256")
  })

  test("writes once with mode 0600 and validates canonical bytes and SHA-256", () => {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    chmodSync(root, 0o700)
    const authorityPath = join(root, "authority.json")
    const humanPath = join(root, "human.json")
    const output = join(root, "post-install.json")
    writeFileSync(authorityPath, JSON.stringify(authority), { mode: 0o600 })
    writeFileSync(humanPath, JSON.stringify(human), { mode: 0o600 })
    const generated = writeH3PostInstallEvidence(
      "/verified/raw-candidate.zip", "/verified/Simulator-arm64.dmg", authorityPath, humanPath, output, inspector, fixedNow,
    )
    expect(generated.path).toBe(output)
    expect(generated.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(verifyH3PostInstallEvidenceFile(output)).toMatchObject(generated)
    expect(() => writeH3PostInstallEvidence(
      "/verified/raw-candidate.zip", "/verified/Simulator-arm64.dmg", authorityPath, humanPath, output, inspector, fixedNow,
    )).toThrow()
    writeFileSync(output, `${readFileSync(output, "utf8")} `)
    expect(() => verifyH3PostInstallEvidenceFile(output)).toThrow("canonical")
  })

  test("rejects a group-readable evidence directory", () => {
    mkdirSync(root, { recursive: true, mode: 0o750 })
    chmodSync(root, 0o750)
    const authorityPath = join(root, "authority.json")
    const humanPath = join(root, "human.json")
    writeFileSync(authorityPath, JSON.stringify(authority), { mode: 0o600 })
    writeFileSync(humanPath, JSON.stringify(human), { mode: 0o600 })
    expect(() => writeH3PostInstallEvidence(
      "/verified/raw-candidate.zip", "/verified/Simulator-arm64.dmg", authorityPath, humanPath,
      join(root, "post-install.json"), inspector, fixedNow,
    )).toThrow("owner-only")
  })

  test("rejects group-readable authority or human input files before inspection", () => {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    chmodSync(root, 0o700)
    const authorityPath = join(root, "authority.json")
    const humanPath = join(root, "human.json")
    writeFileSync(authorityPath, JSON.stringify(authority), { mode: 0o640 })
    writeFileSync(humanPath, JSON.stringify(human), { mode: 0o600 })
    let inspected = false
    const mustNotInspect: H3PostInstallInspector = {
      inspect() {
        inspected = true
        throw new Error("must not inspect")
      },
    }
    expect(() => writeH3PostInstallEvidence(
      "/verified/raw-candidate.zip", "/verified/Simulator-arm64.dmg", authorityPath, humanPath,
      join(root, "post-install.json"), mustNotInspect, fixedNow,
    )).toThrow("owner-only")
    expect(inspected).toBe(false)
  })

  test("the production Inspector runs real trust gates and streams the DMG hash", () => {
    const source = readFileSync(join(import.meta.dir, "h3-post-install-evidence.ts"), "utf8")
    for (const command of [
      '["--verify", "--deep", "--strict", "--verbose=4", installed]',
      '["--assess", "--type", "execute", "--verbose=4", installed]',
      '["stapler", "validate", installed]',
      '["stapler", "validate", dmgPath]',
      '["verify", dmgPath]',
      'verifySignedHostCandidate(root, sourceSha, authority.runId, authority.artifactName)',
      '["-a", "256", "--", path]',
      '"signed-host-final", rawArchive, candidateRoot',
      '`sha256:${rawDigest}` !== authority.artifactDigest',
    ]) expect(source).toContain(command)
    expect(source).not.toContain("digest(readFileSync(dmgPath))")
    expect(source).toContain('"exact-tree", mountedApp')
    expect(source).toContain('"exact-tree", installed')
  })

  test("fixes every macOS child executable and applies deterministic light/heavy command options", () => {
    const source = readFileSync(join(import.meta.dir, "h3-post-install-evidence.ts"), "utf8")
    expect(source.match(/spawnSync\(/g)).toHaveLength(1)
    expect(source).toContain("spawnSync(invocation.command, invocation.args, invocation.options)")
    expect(H3_SYSTEM_EXECUTABLES).toEqual({
      codesign: "/usr/bin/codesign",
      hdiutil: "/usr/bin/hdiutil",
      plistBuddy: "/usr/libexec/PlistBuddy",
      python3: "/usr/bin/python3",
      shasum: "/usr/bin/shasum",
      spctl: "/usr/sbin/spctl",
      swVers: "/usr/bin/sw_vers",
      xcrun: "/usr/bin/xcrun",
    })
    expect(H3_SYSTEM_COMMAND_LIMITS).toEqual({
      light: { timeout: 30_000, maxBuffer: 1024 * 1024 },
      heavy: { timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
    })
    const hostileEnvironment = {
      HOME: "/Users/test",
      GH_TOKEN: "arbitrary-github-token",
      GITHUB_TOKEN: "actions-token",
      GH_DEBUG: "api",
      HTTPS_PROXY: "https://proxy-user:proxy-password@example.invalid",
      HTTP_PROXY: "http://example.invalid",
      ALL_PROXY: "socks5://example.invalid",
      SSL_CERT_FILE: "/attacker/ca.pem",
      SSL_CERT_DIR: "/attacker/certs",
      NODE_OPTIONS: "--require=/attacker.js",
      PYTHONPATH: "/attacker/python",
      DEVELOPER_DIR: "/attacker/Xcode.app",
      CODESIGN_ALLOCATE: "/attacker/codesign_allocate",
      DYLD_INSERT_LIBRARIES: "/attacker/lib.dylib",
    }
    const heavy = createH3SystemCommandInvocation(
      H3_SYSTEM_EXECUTABLES.python3,
      ["/verified/script.py", "exact-tree", "/Applications/Simulator.app"],
      "heavy",
      hostileEnvironment,
    )
    expect(heavy).toEqual({
      command: "/usr/bin/python3",
      args: ["-S", "/verified/script.py", "exact-tree", "/Applications/Simulator.app"],
      options: {
        cwd: "/",
        encoding: "utf8",
        env: {
          HOME: "/Users/test",
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          LANG: "C",
          LC_ALL: "C",
          NO_COLOR: "1",
          PYTHONUTF8: "1",
          PYTHONDONTWRITEBYTECODE: "1",
          PYTHONNOUSERSITE: "1",
        },
        input: "",
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024 * 1024,
        shell: false,
        timeout: 300_000,
        windowsHide: true,
      },
    })
    const light = createH3SystemCommandInvocation(
      H3_SYSTEM_EXECUTABLES.swVers,
      ["-productVersion"],
      "light",
      hostileEnvironment,
    )
    expect(light.options.timeout).toBe(30_000)
    expect(light.options.maxBuffer).toBe(1024 * 1024)
    for (const forbidden of [
      "GH_TOKEN", "GITHUB_TOKEN", "GH_DEBUG", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY",
      "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_OPTIONS", "PYTHONPATH", "DEVELOPER_DIR",
      "CODESIGN_ALLOCATE", "DYLD_INSERT_LIBRARIES",
    ]) expect(heavy.options.env[forbidden]).toBeUndefined()
  })

  test("forces Python site isolation in the unified invocation layer without losing script-directory imports", () => {
    const hostileEnvironment = {
      HOME: "/Users/test",
      PYTHONPATH: "/attacker/python",
      PYTHONUSERBASE: "/attacker/user-base",
    }
    const script = "/verified/helpers/inspect.py"
    const invocation = createH3SystemCommandInvocation(
      H3_SYSTEM_EXECUTABLES.python3,
      [script, "exact-tree", "/Applications/Simulator.app"],
      "heavy",
      hostileEnvironment,
    )
    expect(invocation.args).toEqual([
      "-S", script, "exact-tree", "/Applications/Simulator.app",
    ])
    expect(invocation.args[0]).toBe("-S")
    expect(invocation.args[1]).toBe(script)
    expect(invocation.options.env.PYTHONNOUSERSITE).toBe("1")
    expect(invocation.options.env.PYTHONPATH).toBeUndefined()
    expect(invocation.options.env.PYTHONUSERBASE).toBeUndefined()

    for (const callsiteArgs of [
      [],
      [script],
      ["-E", script],
      ["-s", script],
      ["--", script],
    ]) {
      const protectedInvocation = createH3SystemCommandInvocation(
        H3_SYSTEM_EXECUTABLES.python3,
        callsiteArgs,
        "light",
        hostileEnvironment,
      )
      expect(protectedInvocation.args).toEqual(["-S", ...callsiteArgs])
      expect(protectedInvocation.args[0]).toBe("-S")
    }
  })

  test("bounds and redacts child command failure diagnostics without exposing exact ambient secrets", () => {
    const secret = "arbitrary-secret-value-not-matched-by-token-shape"
    const proxy = "https://proxy-user:proxy-password@example.invalid"
    const result: H3SystemCommandResult = {
      status: 1,
      stdout: `stdout ${secret}`,
      stderr: `Authorization: Bearer ${secret}\nproxy=${proxy}`,
    }
    const message = formatH3SystemCommandFailure("H3 fixture", result, {
      HOME: "/Users/test",
      PRIVATE_API_TOKEN: secret,
      HTTPS_PROXY: proxy,
    })
    expect(message).toContain("H3 fixture failed (exit 1)")
    expect(message).not.toContain(secret)
    expect(message).not.toContain(proxy)
    expect(message.length).toBeLessThanOrEqual(4_200)
  })
})
