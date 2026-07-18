import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  H3_GITHUB_API_ARGUMENT_PREFIX,
  H3_POST_INSTALL_AUTHORITY_CLOSURE,
  assertH3GhBinaryIdentityUnchanged,
  assertH3PostInstallLiveEvidenceMatches,
  createH3GithubEnvironment,
  runH3GhApiCommand,
  sanitizeH3GhDiagnostic,
  validateH3PostInstallAuthorityEvidence,
  verifyH3PostInstallAuthorityClosure,
  writeH3PostInstallAuthorityClosure,
  type H3AuthenticatedCandidateAuthority,
  type H3AuthorityAuthenticator,
  type H3GhApiCommandRunner,
  type H3GhBinaryIdentity,
} from "./h3-post-install-authority"
import { generateH3PostInstallEvidence, type H3PostInstallInspector } from "./h3-post-install-evidence"

const root = join(import.meta.dir, ".tmp-h3-post-install-authority")
const sourceSha = "a".repeat(40)
const artifactName = `simulator-host-0.12.0-macos-arm64-developer-id-candidate-${sourceSha}`
const rawSha = "b".repeat(64)
const authenticatedAt = new Date(Date.now() - 2_000).toISOString()
const authority: H3AuthenticatedCandidateAuthority = {
  repository: "Jiachi-Deng/Simulator",
  repositoryId: 1_298_254_148,
  sourceSha,
  headBranch: "main",
  runId: "12345",
  runAttempt: 1,
  workflowPath: ".github/workflows/signed-macos-host-acceptance.yml",
  workflowDisplayName: "Signed macOS Host acceptance Candidate",
  candidateWorkflowName: "signed-macos-host-acceptance.yml",
  event: "workflow_dispatch",
  status: "completed",
  conclusion: "success",
  artifactId: "67890",
  artifactName,
  artifactServiceDigest: `sha256:${rawSha}`,
  artifactExpired: false,
  rawCandidateBytes: 123456,
  rawCandidateSha256: rawSha,
  candidateDmgBytes: 98765,
  candidateDmgSha256: "c".repeat(64),
  githubClient: {
    linkPath: "/opt/homebrew/bin/gh",
    realPath: "/opt/homebrew/Cellar/gh/2.86.0/bin/gh",
    version: "gh version 2.86.0 (2026-01-21)",
    bytes: 35_925_986,
    sha256: "9".repeat(64),
  },
  authenticatedAt,
}
const authenticator: H3AuthorityAuthenticator = { authenticate: () => ({ ...authority, authenticatedAt: new Date().toISOString() }) }
const inspector: H3PostInstallInspector = {
  inspect() {
    return {
      sourceSha,
      hostBuildRunId: authority.runId,
      artifactName,
      dmgPath: "/verified/Simulator-arm64.dmg",
      dmgBytes: authority.candidateDmgBytes,
      dmgSha256: authority.candidateDmgSha256,
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

function setup(): { humanPath: string; outputRoot: string } {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { mode: 0o700 })
  chmodSync(root, 0o700)
  const outputRoot = join(root, "authority")
  mkdirSync(outputRoot, { mode: 0o700 })
  chmodSync(outputRoot, 0o700)
  const humanPath = join(root, "human.json")
  writeFileSync(humanPath, JSON.stringify({
    environmentKind: "clean-vm",
    existingAppBeforeInstall: false,
    backupPath: "N/A",
    restoreStatus: "NOT NEEDED",
  }), { mode: 0o600 })
  return { humanPath, outputRoot }
}

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("H3 two-stage post-install authority", () => {
  test("the generate CLI rejects every trailing argument", () => {
    const result = spawnSync(process.execPath, [
      join(import.meta.dir, "h3-post-install-authority.ts"),
      "generate", "raw.zip", "candidate.dmg", "human.json", "closure", "unexpected",
    ], { encoding: "utf8" })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Usage: h3-post-install-authority.ts")
  })

  test("stage 1 seals the authenticated GitHub tuple, raw Candidate, and post-install hash", () => {
    const fixture = setup()
    const result = writeH3PostInstallAuthorityClosure(
      "/verified/raw-candidate.zip",
      "/verified/Simulator-arm64.dmg",
      fixture.humanPath,
      fixture.outputRoot,
      { authenticator, inspector, now: () => new Date() },
    )
    expect(result.authoritySha256).toMatch(/^[0-9a-f]{64}$/)
    expect(result.postInstallSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(join(fixture.outputRoot, "SHA256SUMS"), "utf8")).toContain("post-install-authority.json")
    expect(H3_POST_INSTALL_AUTHORITY_CLOSURE).toEqual([
      "SHA256SUMS", "post-install-authority.json", "post-install.json",
    ])
    const evidence = validateH3PostInstallAuthorityEvidence(
      JSON.parse(readFileSync(join(fixture.outputRoot, "post-install-authority.json"), "utf8")),
    )
    expect(evidence.github).toMatchObject({
      sourceSha,
      headBranch: "main",
      runId: "12345",
      runAttempt: 1,
      conclusion: "success",
      artifactId: "67890",
      artifactName,
      artifactServiceDigest: `sha256:${rawSha}`,
    })
    expect(evidence.rawCandidate).toEqual({ bytes: 123456, sha256: rawSha })
    expect(evidence.postInstall.sha256).toBe(result.postInstallSha256)
    const schema = JSON.parse(readFileSync(join(import.meta.dir, "schemas", "h3-post-install-authority-v1.schema.json"), "utf8"))
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties.github.additionalProperties).toBe(false)
    expect(schema.properties.github.properties.headBranch.const).toBe("main")
    expect(schema.properties.github.properties.conclusion.const).toBe("success")
  })

  test("stage 2 independently authenticates and rejects online authority drift", () => {
    const fixture = setup()
    writeH3PostInstallAuthorityClosure(
      "/verified/raw-candidate.zip", "/verified/Simulator-arm64.dmg", fixture.humanPath, fixture.outputRoot,
      { authenticator, inspector, now: () => new Date() },
    )
    let queries = 0
    const independent: H3AuthorityAuthenticator = {
      authenticate() {
        queries += 1
        return { ...authority, authenticatedAt: new Date().toISOString() }
      },
    }
    expect(verifyH3PostInstallAuthorityClosure(fixture.outputRoot, "/verified/raw-candidate.zip", independent)).toMatchObject({
      root: fixture.outputRoot,
    })
    expect(queries).toBe(1)
    const drifted: H3AuthorityAuthenticator = {
      authenticate: () => ({ ...authority, artifactId: "67891", authenticatedAt: new Date().toISOString() }),
    }
    expect(() => verifyH3PostInstallAuthorityClosure(
      fixture.outputRoot, "/verified/raw-candidate.zip", drifted,
    )).toThrow("independently authenticated")
  })

  test("a hand-written canonical post-install JSON cannot satisfy the closure verifier", () => {
    const fixture = setup()
    writeH3PostInstallAuthorityClosure(
      "/verified/raw-candidate.zip", "/verified/Simulator-arm64.dmg", fixture.humanPath, fixture.outputRoot,
      { authenticator, inspector, now: () => new Date() },
    )
    writeFileSync(join(fixture.outputRoot, "post-install.json"), `${readFileSync(join(fixture.outputRoot, "post-install.json"), "utf8")} `, { mode: 0o600 })
    expect(() => verifyH3PostInstallAuthorityClosure(
      fixture.outputRoot, "/verified/raw-candidate.zip", authenticator,
    )).toThrow(/canonical|differs/)
  })

  test("fails closed for service/raw digest mismatch and relaxed authority fields", () => {
    expect(() => validateH3PostInstallAuthorityEvidence({
      schemaVersion: 1,
      kind: "simulator-h3-post-install-authority",
      repository: "Jiachi-Deng/Simulator",
      authenticatedAt,
      github: {
        repositoryId: 1_298_254_148,
        sourceSha,
        headBranch: "main",
        runId: "12345",
        runAttempt: 1,
        workflowPath: ".github/workflows/signed-macos-host-acceptance.yml",
        workflowDisplayName: "Signed macOS Host acceptance Candidate",
        candidateWorkflowName: "signed-macos-host-acceptance.yml",
        event: "workflow_dispatch",
        status: "completed",
        conclusion: "success",
        artifactId: "67890",
        artifactName,
        artifactServiceDigest: `sha256:${"9".repeat(64)}`,
        artifactExpired: false,
      },
      githubClient: authority.githubClient,
      rawCandidate: { bytes: 123, sha256: rawSha },
      candidate: { dmgBytes: 456, dmgSha256: "c".repeat(64) },
      postInstall: { path: "post-install.json", bytes: 789, sha256: "d".repeat(64) },
    })).toThrow("Raw Candidate archive digest")
  })

  test("production authority path is fixed to gh and performs both run and Artifact queries", () => {
    const source = readFileSync(join(import.meta.dir, "h3-post-install-authority.ts"), "utf8")
    expect(source).toContain('const GH = "/opt/homebrew/bin/gh"')
    expect(H3_GITHUB_API_ARGUMENT_PREFIX).toEqual(["api", "--hostname", "github.com", "--method", "GET"])
    expect(source).toContain("actions/runs/${local.runId}")
    expect(source).toContain("actions/runs/${local.runId}/artifacts?per_page=100")
    expect(source).toContain("actions/artifacts/${listedArtifactId}")
    expect(source).toContain("artifact.size_in_bytes !== local.rawArchiveBytes")
    expect(source).toContain("inspectH3RawCandidateArchive(rawArtifactArchivePath)")
    expect(source).toContain('operation === "pre-restore-verify"')
    expect(source).toContain("systemH3PostInstallInspector")
  })

  test("pre-restore live comparison rejects a fake generator Inspector and resealed machine claims", () => {
    const installedAt = new Date().toISOString()
    const human = {
      environmentKind: "clean-vm",
      existingAppBeforeInstall: false,
      backupPath: "N/A",
      restoreStatus: "NOT NEEDED",
    } as const
    const legacy = {
      artifactName,
      artifactId: authority.artifactId,
      artifactDigest: authority.artifactServiceDigest,
      runId: authority.runId,
    }
    const sealed = generateH3PostInstallEvidence(
      "/verified/raw-candidate.zip",
      "/verified/Simulator-arm64.dmg",
      legacy,
      human,
      { inspect: () => ({ ...inspector.inspect("", "", legacy, "/Applications/Simulator.app", human), installedAppIdentitySha256: "f".repeat(64) }) },
      () => new Date(installedAt),
    )
    const live = generateH3PostInstallEvidence(
      "/verified/raw-candidate.zip",
      "/verified/Simulator-arm64.dmg",
      legacy,
      human,
      inspector,
      () => new Date(installedAt),
    )
    expect(() => assertH3PostInstallLiveEvidenceMatches(sealed, live)).toThrow("Pre-restore live Candidate inspection differs")
    expect(() => assertH3PostInstallLiveEvidenceMatches(live, live)).not.toThrow()
  })

  test("GitHub authority child environment ignores host, enterprise token, debug, proxy, and custom CA controls", () => {
    const environment = createH3GithubEnvironment({
      HOME: "/Users/test",
      GH_TOKEN: "github-token",
      GITHUB_TOKEN: "actions-token",
      GH_HOST: "attacker.example",
      GH_ENTERPRISE_TOKEN: "enterprise-secret",
      GH_DEBUG: "api",
      GH_REPO: "attacker/repo",
      HTTPS_PROXY: "https://attacker.example",
      HTTP_PROXY: "http://attacker.example",
      ALL_PROXY: "socks5://attacker.example",
      SSL_CERT_FILE: "/attacker/ca.pem",
      SSL_CERT_DIR: "/attacker/certs",
    })
    expect(environment).toEqual({
      HOME: "/Users/test",
      GH_TOKEN: "github-token",
      LANG: "C",
      LC_ALL: "C",
      GH_PROMPT_DISABLED: "1",
      GH_PAGER: "cat",
      PAGER: "cat",
      NO_COLOR: "1",
    })
  })

  test("each GitHub API command uses the fixed hostname, minimal environment, timeout, and pre/post executable identity", () => {
    const identity: H3GhBinaryIdentity = {
      linkPath: "/opt/homebrew/bin/gh",
      realPath: "/opt/homebrew/Cellar/gh/2.86.0/bin/gh",
      version: "gh version 2.86.0 (2026-01-21)",
      bytes: 123,
      sha256: "a".repeat(64),
      device: "1",
      inode: "2",
    }
    const calls: Array<{ command: string; args: readonly string[]; options: Parameters<H3GhApiCommandRunner["run"]>[2] }> = []
    let inspections = 0
    const runner: H3GhApiCommandRunner = {
      inspectIdentity() {
        inspections += 1
        return identity
      },
      run(command, args, options) {
        calls.push({ command, args, options })
        return { status: 0, stdout: '{"ok":true}', stderr: "" }
      },
    }
    expect(runH3GhApiCommand(
      identity,
      "repos/Jiachi-Deng/Simulator/actions/runs/12345",
      runner,
      {
        HOME: "/Users/test",
        GITHUB_TOKEN: "actions-token",
        GH_HOST: "attacker.example",
        GH_DEBUG: "api",
        HTTPS_PROXY: "https://attacker.example",
        NODE_OPTIONS: "--require=/attacker.js",
      },
    )).toEqual({ ok: true })
    expect(inspections).toBe(2)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      command: identity.realPath,
      args: ["api", "--hostname", "github.com", "--method", "GET", "repos/Jiachi-Deng/Simulator/actions/runs/12345"],
      options: {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 60_000,
        env: {
          HOME: "/Users/test",
          LANG: "C",
          LC_ALL: "C",
          GH_PROMPT_DISABLED: "1",
          GH_PAGER: "cat",
          PAGER: "cat",
          NO_COLOR: "1",
          GH_TOKEN: "actions-token",
        },
      },
    })
  })

  test("GitHub API runner redacts failures and rejects executable drift after the command", () => {
    const identity: H3GhBinaryIdentity = {
      linkPath: "/opt/homebrew/bin/gh",
      realPath: "/opt/homebrew/Cellar/gh/2.86.0/bin/gh",
      version: "gh version 2.86.0 (2026-01-21)",
      bytes: 123,
      sha256: "a".repeat(64),
      device: "1",
      inode: "2",
    }
    const token = "arbitrary-secret-token-value-without-a-known-prefix"
    let inspection = 0
    let failedInspections = 0
    const failedRunner: H3GhApiCommandRunner = {
      inspectIdentity: () => {
        failedInspections += 1
        return identity
      },
      run: () => ({ status: 1, stdout: `response ${token}`, stderr: `Authorization: token ${token}` }),
    }
    let failure = ""
    try {
      runH3GhApiCommand(
        identity,
        "repos/Jiachi-Deng/Simulator/actions/artifacts/67890",
        failedRunner,
        { HOME: "/Users/test", GH_TOKEN: token },
      )
    } catch (error) {
      failure = String(error)
    }
    expect(failure).toContain("Authenticated GitHub API query failed")
    expect(failure).not.toContain(token)
    expect(failedInspections).toBe(2)

    const driftRunner: H3GhApiCommandRunner = {
      inspectIdentity() {
        inspection += 1
        return inspection === 1 ? identity : { ...identity, sha256: "b".repeat(64) }
      },
      run: () => ({ status: 0, stdout: '{"ok":true}', stderr: "" }),
    }
    expect(() => runH3GhApiCommand(
      identity,
      "repos/Jiachi-Deng/Simulator/actions/runs/12345/artifacts?per_page=100",
      driftRunner,
      { HOME: "/Users/test" },
    )).toThrow("identity drifted")
  })

  test("GitHub diagnostics redact tokens and executable identity drift fails closed", () => {
    const diagnostic = sanitizeH3GhDiagnostic(
      "Authorization: token ghp_abcdefghijklmnopqrstuvwxyz123456\nProxy-Authorization: secret\nsk-abcdefghijklmnopqrstuvwxyz123456",
    )
    expect(diagnostic).not.toContain("ghp_")
    expect(diagnostic).not.toContain("sk-")
    expect(diagnostic).not.toContain("Proxy-Authorization: secret")
    const identity = {
      linkPath: "/opt/homebrew/bin/gh" as const,
      realPath: "/opt/homebrew/Cellar/gh/2.86.0/bin/gh",
      version: "gh version 2.86.0 (2026-01-21)",
      bytes: 123,
      sha256: "a".repeat(64),
      device: "1",
      inode: "2",
    }
    expect(() => assertH3GhBinaryIdentityUnchanged(identity, identity)).not.toThrow()
    expect(() => assertH3GhBinaryIdentityUnchanged(identity, { ...identity, sha256: "b".repeat(64) })).toThrow("identity drifted")
  })
})
