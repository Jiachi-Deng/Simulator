import { createHash } from "node:crypto"
import {
  closeSync, fchmodSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync,
  rmSync, statSync, writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { inspectDeveloperIdSignature } from "./verify-macos-signatures"
import { SIGNED_CANDIDATE_NAME_PATTERN, verifySignedHostCandidate, type SignedHostManifest } from "./signed-host-candidate"

const SHA256 = /^[0-9a-f]{64}$/
const SOURCE_SHA = /^[0-9a-f]{40}$/
const POSITIVE_ID = /^[1-9][0-9]*$/
const INSTALLED_APP = "/Applications/Simulator.app" as const

const requiredKeys = [
  "appBundleVersion", "artifactDigest", "artifactId", "artifactName", "backupIdentitySha256", "backupPath",
  "bundleIdentifier", "canonicalInventorySha256", "deepSignatureValid", "developerIdApplication", "dmgBytes",
  "dmgPath", "dmgSha256", "environmentKind", "existingAppBeforeInstall", "gatekeeperAssessment",
  "hostBuildRunId", "hostVersion", "installedAppIdentitySha256", "installedAt", "installedPath", "macOSVersion",
  "notarization", "restoreStatus", "schemaVersion", "sourceSha", "stapling", "teamId",
] as const
const authorityKeys = ["artifactDigest", "artifactId", "artifactName", "runId"] as const
const humanInputKeys = [
  "backupPath", "environmentKind", "existingAppBeforeInstall", "restoreStatus",
] as const

type RecordValue = Record<string, unknown>

export interface H3CandidateArtifactAuthority {
  artifactName: string
  artifactId: string
  artifactDigest: string
  runId: string
}

export interface H3PostInstallHumanInput {
  environmentKind: "new-standard-user" | "clean-vm" | "second-mac"
  existingAppBeforeInstall: boolean
  backupPath: string
  restoreStatus: "NOT NEEDED" | "PENDING" | "PASS" | "FAIL"
}

export interface H3PostInstallEvidence {
  schemaVersion: 1
  sourceSha: string
  hostBuildRunId: string
  artifactName: string
  artifactId: string
  artifactDigest: string
  dmgPath: string
  dmgBytes: number
  dmgSha256: string
  environmentKind: "new-standard-user" | "clean-vm" | "second-mac"
  macOSVersion: string
  installedPath: typeof INSTALLED_APP
  installedAt: string
  bundleIdentifier: string
  hostVersion: string
  appBundleVersion: string
  canonicalInventorySha256: string
  installedAppIdentitySha256: string
  developerIdApplication: string
  teamId: string
  deepSignatureValid: true
  gatekeeperAssessment: "PASS"
  notarization: "PASS"
  stapling: "PASS"
  existingAppBeforeInstall: boolean
  backupPath: string
  backupIdentitySha256: string
  restoreStatus: "NOT NEEDED" | "PENDING" | "PASS" | "FAIL"
}

interface H3DerivedInspection {
  sourceSha: string
  hostBuildRunId: string
  artifactName: string
  dmgPath: string
  dmgBytes: number
  dmgSha256: string
  macOSVersion: string
  bundleIdentifier: string
  hostVersion: string
  appBundleVersion: string
  canonicalInventorySha256: string
  installedAppIdentitySha256: string
  backupIdentitySha256: string
  developerIdApplication: string
  teamId: string
}

export interface H3PostInstallInspector {
  inspect(
    rawArtifactArchivePath: string,
    dmgPath: string,
    authority: H3CandidateArtifactAuthority,
    installedAppPath: typeof INSTALLED_APP,
    human: H3PostInstallHumanInput,
  ): H3DerivedInspection
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactKeys(value: RecordValue, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  const sorted = [...expected].sort()
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index])
}

function record(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  return value
}

function string(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`Invalid ${label}`)
  return value
}

function digest(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
  return JSON.stringify(value)
}

function assertNoSecretMaterial(value: RecordValue): void {
  const encoded = JSON.stringify(value)
  if (/-----BEGIN [^-]*PRIVATE KEY-----|\b(?:gh[opsu]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b|app-specific-password/i.test(encoded)) {
    throw new Error("H3 evidence contains secret-shaped material")
  }
}

function validateBackupFields(value: H3PostInstallHumanInput): void {
  const noBackup = value.backupPath === "N/A"
  const hasBackup = typeof value.backupPath === "string" && isAbsolute(value.backupPath)
  if (!noBackup && !hasBackup) throw new Error("Backup path must be N/A or absolute")
  if (value.existingAppBeforeInstall !== hasBackup) throw new Error("Backup evidence differs from existingAppBeforeInstall")
  if (!value.existingAppBeforeInstall && value.restoreStatus !== "NOT NEEDED") throw new Error("No-backup install must use NOT NEEDED restoreStatus")
}

export function validateH3CandidateArtifactAuthority(value: unknown): H3CandidateArtifactAuthority {
  if (!isRecord(value) || !exactKeys(value, authorityKeys)) throw new Error("H3 Candidate Artifact authority keys differ")
  const authority = {
    artifactName: string(value.artifactName, SIGNED_CANDIDATE_NAME_PATTERN, "artifactName"),
    artifactId: string(value.artifactId, POSITIVE_ID, "artifactId"),
    artifactDigest: string(value.artifactDigest, /^sha256:[0-9a-f]{64}$/, "artifactDigest"),
    runId: string(value.runId, POSITIVE_ID, "runId"),
  }
  assertNoSecretMaterial(authority)
  return authority
}

export function validateH3PostInstallHumanInput(value: unknown): H3PostInstallHumanInput {
  if (!isRecord(value) || !exactKeys(value, humanInputKeys)) throw new Error("H3 human input keys differ")
  if (!["new-standard-user", "clean-vm", "second-mac"].includes(String(value.environmentKind))) throw new Error("Invalid environmentKind")
  if (typeof value.existingAppBeforeInstall !== "boolean") throw new Error("Invalid existingAppBeforeInstall")
  if (!["NOT NEEDED", "PENDING", "PASS", "FAIL"].includes(String(value.restoreStatus))) throw new Error("Invalid restoreStatus")
  const input = value as unknown as H3PostInstallHumanInput
  validateBackupFields(input)
  assertNoSecretMaterial(value)
  return input
}

export function validateH3PostInstallEvidence(value: unknown): H3PostInstallEvidence {
  if (!isRecord(value) || !exactKeys(value, requiredKeys)) throw new Error("H3 evidence keys differ from schema v1")
  if (value.schemaVersion !== 1) throw new Error("Invalid schemaVersion")
  string(value.sourceSha, SOURCE_SHA, "sourceSha")
  string(value.hostBuildRunId, POSITIVE_ID, "hostBuildRunId")
  string(value.artifactName, SIGNED_CANDIDATE_NAME_PATTERN, "artifactName")
  string(value.artifactId, POSITIVE_ID, "artifactId")
  string(value.artifactDigest, /^sha256:[0-9a-f]{64}$/, "artifactDigest")
  const dmgPath = string(value.dmgPath, /^\/[^\n\r]+\/Simulator-arm64\.dmg$/, "dmgPath")
  if (!isAbsolute(dmgPath)) throw new Error("dmgPath must be absolute")
  if (!Number.isSafeInteger(value.dmgBytes) || (value.dmgBytes as number) < 1) throw new Error("Invalid dmgBytes")
  for (const key of ["dmgSha256", "canonicalInventorySha256", "installedAppIdentitySha256"] as const) {
    string(value[key], SHA256, key)
  }
  if (!["new-standard-user", "clean-vm", "second-mac"].includes(value.environmentKind as string)) throw new Error("Invalid environmentKind")
  string(value.macOSVersion, /^[0-9]+\.[0-9]+(?:\.[0-9]+)?(?: \([0-9A-Za-z]+\))?$/, "macOSVersion")
  if (value.installedPath !== INSTALLED_APP) throw new Error("Invalid installedPath")
  const installedAt = string(value.installedAt, /^\d{4}-(?:0[1-9]|1[0-2])-(?:[0-2]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/, "installedAt")
  if (new Date(installedAt).toISOString() !== installedAt) throw new Error("installedAt is not a canonical UTC instant")
  string(value.bundleIdentifier, /^[A-Za-z0-9][A-Za-z0-9.-]+$/, "bundleIdentifier")
  string(value.hostVersion, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/, "hostVersion")
  string(value.appBundleVersion, /^[0-9A-Za-z][0-9A-Za-z.-]*$/, "appBundleVersion")
  const subject = string(value.developerIdApplication, /^Developer ID Application: .+ \([A-Z0-9]{10}\)$/, "developerIdApplication")
  const teamId = string(value.teamId, /^[A-Z0-9]{10}$/, "teamId")
  if (!subject.endsWith(`(${teamId})`)) throw new Error("Developer ID subject and Team ID differ")
  if (value.deepSignatureValid !== true || value.gatekeeperAssessment !== "PASS"
    || value.notarization !== "PASS" || value.stapling !== "PASS") {
    throw new Error("Post-install trust gates must all pass")
  }
  validateBackupFields(value as unknown as H3PostInstallHumanInput)
  if (value.existingAppBeforeInstall) {
    string(value.backupIdentitySha256, SHA256, "backupIdentitySha256")
  } else if (value.backupIdentitySha256 !== "N/A") {
    throw new Error("No-backup install must use N/A backupIdentitySha256")
  }
  assertNoSecretMaterial(value)
  return value as unknown as H3PostInstallEvidence
}

export function canonicalH3PostInstallEvidence(evidence: H3PostInstallEvidence): string {
  return `${stable(evidence)}\n`
}

function realDirectory(path: string, label: string): string {
  const absolute = resolve(path)
  const metadata = lstatSync(absolute)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(absolute) !== absolute) {
    throw new Error(`${label} must be one real canonical directory`)
  }
  return absolute
}

function realRegularFile(path: string, label: string): string {
  const absolute = resolve(path)
  const metadata = lstatSync(absolute)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || realpathSync(absolute) !== absolute) {
    throw new Error(`${label} must be one real regular file`)
  }
  return absolute
}

function run(command: string, args: string[], label: string): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${label} failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`)
  return { stdout: result.stdout, stderr: result.stderr }
}

function sha256File(path: string, label: string): string {
  if (/[\r\n]/.test(path)) throw new Error(`${label} path contains a line break`)
  const result = run("shasum", ["-a", "256", "--", path], label)
  const match = result.stdout.match(/^([0-9a-f]{64})  (.+)\n?$/)
  if (!match || match[2] !== path) throw new Error(`${label} output differs`)
  return match[1]
}

function plistValue(appPath: string, key: string): string {
  return run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, join(appPath, "Contents", "Info.plist")], `Read ${key}`).stdout.trim()
}

function parseJsonOutput(output: string, label: string): RecordValue {
  try {
    return record(JSON.parse(output), label)
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function inspectCandidate(candidateRoot: string, authority: H3CandidateArtifactAuthority): {
  root: string
  manifest: SignedHostManifest
  dmgPath: string
  dmgBytes: number
  dmgSha256: string
} {
  const sourceSha = authority.artifactName.slice(-40)
  string(sourceSha, SOURCE_SHA, "Artifact name source SHA")
  const root = realDirectory(candidateRoot, "Candidate root")
  const manifest = verifySignedHostCandidate(root, sourceSha, authority.runId, authority.artifactName)
  const dmgPath = realRegularFile(join(root, "Simulator-arm64.dmg"), "Candidate DMG")
  const dmgBytes = statSync(dmgPath).size
  const dmgSha256 = sha256File(dmgPath, "Candidate DMG SHA-256")
  const dmg = record(record(manifest.files, "manifest.files").dmg, "manifest.files.dmg")
  if (dmg.path !== "Simulator-arm64.dmg" || dmg.bytes !== dmgBytes || dmg.sha256 !== dmgSha256) {
    throw new Error("Candidate DMG differs from signed-host manifest")
  }
  return { root, manifest, dmgPath, dmgBytes, dmgSha256 }
}

function inspectMountedAndInstalledApps(
  dmgPath: string,
  installedAppPath: string,
  manifest: SignedHostManifest,
): Omit<H3DerivedInspection,
  "sourceSha" | "hostBuildRunId" | "artifactName" | "dmgPath" | "dmgBytes" | "dmgSha256" | "macOSVersion" | "backupIdentitySha256"
> {
  const installed = realDirectory(installedAppPath, "Installed App")
  if (installed !== INSTALLED_APP) throw new Error(`Installed App must be ${INSTALLED_APP}`)
  const identity = record(manifest.identity, "manifest.identity")
  const expectedAuthority = string(identity.developerIdApplication, /^Developer ID Application: .+ \([A-Z0-9]{10}\)$/, "manifest identity authority")
  const expectedTeamId = string(identity.teamId, /^[A-Z0-9]{10}$/, "manifest identity teamId")
  const expectedBundleIdentifier = string(identity.bundleIdentifier, /^[A-Za-z0-9][A-Za-z0-9.-]+$/, "manifest identity bundleIdentifier")
  const expectedHostVersion = string(manifest.hostVersion, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/, "manifest hostVersion")
  const expectedCanonicalInventory = string(
    record(manifest.payloadEquivalence, "manifest.payloadEquivalence").canonicalInventorySha256,
    SHA256,
    "manifest canonical inventory",
  )

  const scripts = import.meta.dir
  run("python3", [join(scripts, "preflight-macos-release-artifact.py"), "dmg", dmgPath], "DMG resource preflight")
  run("hdiutil", ["verify", dmgPath], "DMG verification")
  run("xcrun", ["stapler", "validate", dmgPath], "DMG staple validation")
  run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", dmgPath], "DMG Gatekeeper assessment")
  run("python3", [join(scripts, "preflight-macos-release-artifact.py"), "tree", installed], "Installed App resource preflight")
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", installed], "Installed App deep signature verification")
  run("spctl", ["--assess", "--type", "execute", "--verbose=4", installed], "Installed App Gatekeeper assessment")
  run("xcrun", ["stapler", "validate", installed], "Installed App staple validation")

  const signature = run("codesign", ["-dvvv", installed], "Installed App identity inspection")
  inspectDeveloperIdSignature(`${signature.stdout}\n${signature.stderr}`, expectedAuthority, expectedTeamId)
  const bundleIdentifier = plistValue(installed, "CFBundleIdentifier")
  const hostVersion = plistValue(installed, "CFBundleShortVersionString")
  const appBundleVersion = plistValue(installed, "CFBundleVersion")
  if (bundleIdentifier !== expectedBundleIdentifier) throw new Error("Installed App Bundle ID differs from Candidate")
  if (hostVersion !== expectedHostVersion) throw new Error("Installed App version differs from Candidate")
  string(appBundleVersion, /^[0-9A-Za-z][0-9A-Za-z.-]*$/, "installed App bundle version")

  const work = mkdtempSync(join(tmpdir(), "simulator-h3-inspection."))
  const mount = join(work, "mount")
  const comparison = join(work, "installed-payload-equivalence.json")
  mkdirSync(mount, { mode: 0o700 })
  let attached = false
  let inspectionError: unknown
  let canonicalInventorySha256 = ""
  let installedExactTreeSha256 = ""
  try {
    run("hdiutil", ["attach", dmgPath, "-nobrowse", "-readonly", "-mountpoint", mount, "-quiet"], "DMG attach")
    attached = true
    const mountedApp = realDirectory(join(mount, "Simulator.app"), "DMG App")
    run("python3", [join(scripts, "preflight-macos-release-artifact.py"), "tree", mountedApp], "DMG App resource preflight")
    run("python3", [join(scripts, "compare-macos-app-payloads.py"), mountedApp, installed, comparison], "Installed App payload comparison")
    const report = parseJsonOutput(readFileSync(comparison, "utf8"), "Installed App payload comparison")
    canonicalInventorySha256 = string(report.candidateCanonicalInventorySha256, SHA256, "installed canonical inventory")
    if (report.equivalent !== true || report.baselineCanonicalInventorySha256 !== canonicalInventorySha256
      || canonicalInventorySha256 !== expectedCanonicalInventory) {
      throw new Error("Installed App payload inventory differs from Candidate")
    }
    const mountedExact = parseJsonOutput(
      run("python3", [join(scripts, "compare-macos-app-payloads.py"), "exact-tree", mountedApp], "DMG App exact-tree inventory").stdout,
      "DMG App exact-tree inventory",
    )
    const installedExact = parseJsonOutput(
      run("python3", [join(scripts, "compare-macos-app-payloads.py"), "exact-tree", installed], "Installed App exact-tree inventory").stdout,
      "Installed App exact-tree inventory",
    )
    const mountedExactTreeSha256 = string(mountedExact.inventorySha256, SHA256, "DMG App exact-tree SHA-256")
    installedExactTreeSha256 = string(installedExact.inventorySha256, SHA256, "Installed App exact-tree SHA-256")
    if (mountedExactTreeSha256 !== installedExactTreeSha256) throw new Error("Installed App exact tree differs from Candidate DMG")
  } catch (error) {
    inspectionError = error
  } finally {
    if (attached) {
      const detached = spawnSync("hdiutil", ["detach", mount, "-quiet"], { encoding: "utf8" })
      if (!inspectionError && (detached.error || detached.status !== 0)) {
        inspectionError = detached.error ?? new Error(`DMG detach failed: ${(detached.stderr || detached.stdout || `exit ${detached.status}`).trim()}`)
      }
    }
    rmSync(work, { recursive: true, force: true })
  }
  if (inspectionError) throw inspectionError

  const installedAppIdentitySha256 = digest(stable({
    policy: "installed-app-exact-tree-and-developer-id-v1",
    exactTreeSha256: installedExactTreeSha256,
    bundleIdentifier,
    hostVersion,
    appBundleVersion,
    developerIdApplication: expectedAuthority,
    teamId: expectedTeamId,
  }))
  return {
    bundleIdentifier,
    hostVersion,
    appBundleVersion,
    canonicalInventorySha256,
    installedAppIdentitySha256,
    developerIdApplication: expectedAuthority,
    teamId: expectedTeamId,
  }
}

export const systemH3PostInstallInspector: H3PostInstallInspector = {
  inspect(rawArtifactArchivePath, dmgPath, authority, installedAppPath, human) {
    if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("H3 inspection requires macOS arm64")
    const rawArchive = realRegularFile(rawArtifactArchivePath, "Raw Candidate Artifact archive")
    const rawDigest = sha256File(rawArchive, "Raw Candidate Artifact SHA-256")
    if (`sha256:${rawDigest}` !== authority.artifactDigest) {
      throw new Error("Raw Candidate Artifact digest differs from authenticated authority")
    }
    const persistentDmg = realRegularFile(dmgPath, "Installed Candidate DMG")
    const work = mkdtempSync(join(tmpdir(), "simulator-h3-candidate."))
    const candidateRoot = join(work, "candidate")
    mkdirSync(candidateRoot, { mode: 0o700 })
    try {
      run(
        "python3",
        [join(import.meta.dir, "extract-engineering-rc-artifact.py"), "signed-host-final", rawArchive, candidateRoot],
        "Final Candidate Artifact extraction",
      )
      const candidate = inspectCandidate(candidateRoot, authority)
      const persistentDmgBytes = statSync(persistentDmg).size
      const persistentDmgSha256 = sha256File(persistentDmg, "Installed Candidate DMG SHA-256")
      if (persistentDmgBytes !== candidate.dmgBytes || persistentDmgSha256 !== candidate.dmgSha256) {
        throw new Error("Installed Candidate DMG differs from raw Artifact closure")
      }
      const workflow = record(candidate.manifest.workflow, "manifest.workflow")
      const sourceSha = string(candidate.manifest.sourceSha, SOURCE_SHA, "manifest sourceSha")
      const hostBuildRunId = string(workflow.runId, POSITIVE_ID, "manifest workflow runId")
      if (candidate.manifest.artifactName !== authority.artifactName || hostBuildRunId !== authority.runId) {
        throw new Error("Candidate manifest differs from authenticated Artifact authority")
      }
      const productVersion = run("sw_vers", ["-productVersion"], "macOS version inspection").stdout.trim()
      const buildVersion = run("sw_vers", ["-buildVersion"], "macOS build inspection").stdout.trim()
      const macOSVersion = `${productVersion} (${buildVersion})`
      string(macOSVersion, /^[0-9]+\.[0-9]+(?:\.[0-9]+)? \([0-9A-Za-z]+\)$/, "macOSVersion")
      let backupIdentitySha256 = "N/A"
      if (human.existingAppBeforeInstall) {
        const backup = realDirectory(human.backupPath, "Pre-install App backup")
        if (backup === INSTALLED_APP) throw new Error("Pre-install App backup must not be the installed App")
        const backupInventory = parseJsonOutput(
          run(
            "python3",
            [join(import.meta.dir, "compare-macos-app-payloads.py"), "exact-tree", backup],
            "Pre-install App backup exact-tree inventory",
          ).stdout,
          "Pre-install App backup exact-tree inventory",
        )
        backupIdentitySha256 = string(backupInventory.inventorySha256, SHA256, "Pre-install App backup identity")
      }
      return {
        sourceSha,
        hostBuildRunId,
        artifactName: candidate.manifest.artifactName,
        dmgPath: persistentDmg,
        dmgBytes: persistentDmgBytes,
        dmgSha256: persistentDmgSha256,
        macOSVersion,
        backupIdentitySha256,
        ...inspectMountedAndInstalledApps(persistentDmg, installedAppPath, candidate.manifest),
      }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  },
}

export function generateH3PostInstallEvidence(
  rawArtifactArchivePath: string,
  dmgPath: string,
  authorityValue: unknown,
  humanInputValue: unknown,
  inspector: H3PostInstallInspector = systemH3PostInstallInspector,
  now: () => Date = () => new Date(),
): H3PostInstallEvidence {
  const authority = validateH3CandidateArtifactAuthority(authorityValue)
  const human = validateH3PostInstallHumanInput(humanInputValue)
  const inspected = inspector.inspect(rawArtifactArchivePath, dmgPath, authority, INSTALLED_APP, human)
  if (inspected.artifactName !== authority.artifactName || inspected.hostBuildRunId !== authority.runId
    || authority.artifactName.slice(-40) !== inspected.sourceSha) {
    throw new Error("Derived Candidate authority differs from authenticated Artifact authority")
  }
  return validateH3PostInstallEvidence({
    schemaVersion: 1,
    sourceSha: inspected.sourceSha,
    hostBuildRunId: inspected.hostBuildRunId,
    artifactName: authority.artifactName,
    artifactId: authority.artifactId,
    artifactDigest: authority.artifactDigest,
    dmgPath: inspected.dmgPath,
    dmgBytes: inspected.dmgBytes,
    dmgSha256: inspected.dmgSha256,
    environmentKind: human.environmentKind,
    macOSVersion: inspected.macOSVersion,
    installedPath: INSTALLED_APP,
    installedAt: now().toISOString(),
    bundleIdentifier: inspected.bundleIdentifier,
    hostVersion: inspected.hostVersion,
    appBundleVersion: inspected.appBundleVersion,
    canonicalInventorySha256: inspected.canonicalInventorySha256,
    installedAppIdentitySha256: inspected.installedAppIdentitySha256,
    developerIdApplication: inspected.developerIdApplication,
    teamId: inspected.teamId,
    deepSignatureValid: true,
    gatekeeperAssessment: "PASS",
    notarization: "PASS",
    stapling: "PASS",
    existingAppBeforeInstall: human.existingAppBeforeInstall,
    backupPath: human.backupPath,
    backupIdentitySha256: inspected.backupIdentitySha256,
    restoreStatus: human.restoreStatus,
  })
}

function assertOwnerOnlyDirectory(path: string): void {
  const metadata = lstatSync(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(path) !== resolve(path)) throw new Error("Evidence parent must be a real directory")
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error("Evidence parent must be owned by current user")
  if ((metadata.mode & 0o077) !== 0) throw new Error("Evidence parent must be owner-only")
}

function readJsonFile(path: string, label: string): unknown {
  const absolute = realRegularFile(path, label)
  const metadata = statSync(absolute)
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error(`${label} must be owned by current user`)
  if ((metadata.mode & 0o077) !== 0) throw new Error(`${label} must be owner-only`)
  return JSON.parse(readFileSync(absolute, "utf8"))
}

export function writeH3PostInstallEvidence(
  rawArtifactArchivePath: string,
  dmgPath: string,
  authorityPath: string,
  humanInputPath: string,
  outputPath: string,
  inspector: H3PostInstallInspector = systemH3PostInstallInspector,
  now: () => Date = () => new Date(),
): { path: string; sha256: string } {
  const absoluteOutput = resolve(outputPath)
  assertOwnerOnlyDirectory(dirname(absoluteOutput))
  const evidence = generateH3PostInstallEvidence(
    rawArtifactArchivePath,
    dmgPath,
    readJsonFile(authorityPath, "Artifact authority"),
    readJsonFile(humanInputPath, "H3 human input"),
    inspector,
    now,
  )
  const bytes = canonicalH3PostInstallEvidence(evidence)
  const descriptor = openSync(absoluteOutput, "wx", 0o600)
  try {
    fchmodSync(descriptor, 0o600)
    writeFileSync(descriptor, bytes, "utf8")
  } finally {
    closeSync(descriptor)
  }
  return { path: absoluteOutput, sha256: digest(bytes) }
}

export function verifyH3PostInstallEvidenceFile(path: string): { path: string; sha256: string; evidence: H3PostInstallEvidence } {
  const absolute = realRegularFile(path, "Evidence")
  const metadata = statSync(absolute)
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error("Evidence must be owned by current user")
  if ((metadata.mode & 0o777) !== 0o600) throw new Error("Evidence mode must be 0600")
  assertOwnerOnlyDirectory(dirname(absolute))
  const bytes = readFileSync(absolute, "utf8")
  const evidence = validateH3PostInstallEvidence(JSON.parse(bytes))
  if (bytes !== canonicalH3PostInstallEvidence(evidence)) throw new Error("Evidence JSON is not canonical")
  return { path: absolute, sha256: digest(bytes), evidence }
}

if (import.meta.main) {
  process.umask(0o077)
  const [operation, first, second, third, fourth, fifth] = process.argv.slice(2)
  if (operation === "generate" && first && second && third && fourth && fifth) {
    console.log(JSON.stringify(writeH3PostInstallEvidence(first, second, third, fourth, fifth)))
  } else if (operation === "validate" && first && !second) {
    const result = verifyH3PostInstallEvidenceFile(first)
    console.log(JSON.stringify({ ok: true, path: result.path, sha256: result.sha256, schemaVersion: result.evidence.schemaVersion }))
  } else {
    throw new Error(
      "Usage: h3-post-install-evidence.ts generate RAW_CANDIDATE_ARTIFACT_ZIP DMG_PATH ARTIFACT_AUTHORITY_JSON HUMAN_INPUT_JSON OUTPUT_JSON"
      + " | validate EVIDENCE_JSON",
    )
  }
}
