import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  closeSync,
  fchmodSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"
import {
  canonicalH3PostInstallEvidence,
  generateH3PostInstallEvidence,
  inspectH3RawCandidateArchive,
  systemH3PostInstallInspector,
  validateH3PostInstallHumanInput,
  validateH3PostInstallEvidence,
  verifyH3PostInstallEvidenceFile,
  type H3CandidateArtifactAuthority,
  type H3PostInstallEvidence,
  type H3PostInstallHumanInput,
  type H3PostInstallInspector,
} from "./h3-post-install-evidence"

const REPOSITORY = "Jiachi-Deng/Simulator" as const
const REPOSITORY_ID = 1_298_254_148
const WORKFLOW_PATH = ".github/workflows/signed-macos-host-acceptance.yml" as const
const WORKFLOW_DISPLAY_NAME = "Signed macOS Host acceptance Candidate" as const
const GH = "/opt/homebrew/bin/gh" as const
const GH_REALPATH_PREFIX = "/opt/homebrew/Cellar/gh/" as const
const GH_TIMEOUT_MS = 60_000
const MAX_GH_BINARY_BYTES = 128 * 1024 * 1024
const SHA256 = /^[0-9a-f]{64}$/
const SOURCE_SHA = /^[0-9a-f]{40}$/
const POSITIVE_ID = /^[1-9][0-9]*$/
const SERVICE_DIGEST = /^sha256:[0-9a-f]{64}$/
const CANONICAL_UTC = /^\d{4}-(?:0[1-9]|1[0-2])-(?:[0-2]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/
const MAX_GITHUB_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_AUTHORITY_BYTES = 64 * 1024
const MAX_POST_INSTALL_BYTES = 256 * 1024

export const H3_POST_INSTALL_AUTHORITY_CLOSURE = Object.freeze([
  "SHA256SUMS",
  "post-install-authority.json",
  "post-install.json",
] as const)

type JsonObject = Record<string, unknown>

export const H3_GITHUB_API_ARGUMENT_PREFIX = Object.freeze([
  "api",
  "--hostname",
  "github.com",
  "--method",
  "GET",
] as const)

export interface H3GhBinaryIdentity {
  linkPath: typeof GH
  realPath: string
  version: string
  bytes: number
  sha256: string
  device: string
  inode: string
}

export interface H3GhCommandOptions {
  encoding: "utf8"
  maxBuffer: number
  timeout: number
  env: NodeJS.ProcessEnv
}

export interface H3GhCommandResult {
  status: number | null
  stdout: string
  stderr: string
  error?: NodeJS.ErrnoException
}

/** Narrow seam used only to prove the exact `gh api` invocation boundary. */
export interface H3GhApiCommandRunner {
  inspectIdentity(): H3GhBinaryIdentity
  run(command: string, args: readonly string[], options: H3GhCommandOptions): H3GhCommandResult
}

export interface H3AuthenticatedCandidateAuthority {
  repository: typeof REPOSITORY
  repositoryId: typeof REPOSITORY_ID
  sourceSha: string
  headBranch: "main"
  runId: string
  runAttempt: number
  workflowPath: typeof WORKFLOW_PATH
  workflowDisplayName: typeof WORKFLOW_DISPLAY_NAME
  candidateWorkflowName: "signed-macos-host-acceptance.yml"
  event: "workflow_dispatch"
  status: "completed"
  conclusion: "success"
  artifactId: string
  artifactName: string
  artifactServiceDigest: string
  artifactExpired: false
  rawCandidateBytes: number
  rawCandidateSha256: string
  candidateDmgBytes: number
  candidateDmgSha256: string
  githubClient: {
    linkPath: typeof GH
    realPath: string
    version: string
    bytes: number
    sha256: string
  }
  authenticatedAt: string
}

export interface H3AuthorityAuthenticator {
  authenticate(rawArtifactArchivePath: string): H3AuthenticatedCandidateAuthority
}

export interface H3PostInstallAuthorityEvidence {
  schemaVersion: 1
  kind: "simulator-h3-post-install-authority"
  repository: typeof REPOSITORY
  authenticatedAt: string
  github: {
    repositoryId: typeof REPOSITORY_ID
    sourceSha: string
    headBranch: "main"
    runId: string
    runAttempt: number
    workflowPath: typeof WORKFLOW_PATH
    workflowDisplayName: typeof WORKFLOW_DISPLAY_NAME
    candidateWorkflowName: "signed-macos-host-acceptance.yml"
    event: "workflow_dispatch"
    status: "completed"
    conclusion: "success"
    artifactId: string
    artifactName: string
    artifactServiceDigest: string
    artifactExpired: false
  }
  rawCandidate: { bytes: number; sha256: string }
  candidate: { dmgBytes: number; dmgSha256: string }
  githubClient: H3AuthenticatedCandidateAuthority["githubClient"]
  postInstall: { path: "post-install.json"; bytes: number; sha256: string }
}

export interface H3PostInstallAuthorityDependencies {
  authenticator: H3AuthorityAuthenticator
  inspector: H3PostInstallInspector
  now: () => Date
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function object(value: unknown, label: string): JsonObject {
  if (!isObject(value)) throw new Error(`${label} must be an object`)
  return value
}

function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error(`${label} keys differ`)
  }
}

function string(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`Invalid ${label}`)
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`Invalid ${label}`)
  return value as number
}

function canonicalTimestamp(value: unknown, label: string): string {
  const result = string(value, CANONICAL_UTC, label)
  if (new Date(result).toISOString() !== result) throw new Error(`${label} must be canonical UTC`)
  return result
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
  return JSON.stringify(value)
}

function canonical(value: unknown): string {
  return `${stable(value)}\n`
}

export function createH3GithubEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = source.HOME
  if (typeof home !== "string" || !home.startsWith("/") || /[\r\n]/.test(home)) {
    throw new Error("H3 GitHub authority requires one absolute HOME")
  }
  const token = source.GH_TOKEN ?? source.GITHUB_TOKEN
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    GH_PROMPT_DISABLED: "1",
    GH_PAGER: "cat",
    PAGER: "cat",
    NO_COLOR: "1",
  }
  if (typeof token === "string") environment.GH_TOKEN = token
  return environment
}

export function sanitizeH3GhDiagnostic(value: string, exactSecrets: readonly string[] = []): string {
  let redacted = value
  for (const secret of exactSecrets) {
    if (secret.length > 0) redacted = redacted.split(secret).join("[REDACTED TOKEN]")
  }
  return redacted
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED TOKEN]")
    .replace(/(^|\n)(?:Authorization|Proxy-Authorization):[^\n]*/gi, "$1Authorization: [REDACTED]")
    .slice(0, 2_048)
    .trim()
}

function sha256FileBytes(path: string): { bytes: number; sha256: string; device: string; inode: string } {
  const metadata = statSync(path, { bigint: true })
  if (!metadata.isFile() || metadata.nlink !== 1n || metadata.size < 1n
    || metadata.size > BigInt(MAX_GH_BINARY_BYTES) || (metadata.mode & 0o111n) === 0n
    || (metadata.mode & 0o022n) !== 0n) {
    throw new Error("Pinned gh executable must be one non-writable executable regular file")
  }
  return {
    bytes: Number(metadata.size),
    sha256: sha256(readFileSync(path)),
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
  }
}

function inspectH3GhBinaryIdentity(): H3GhBinaryIdentity {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("H3 GitHub authority authentication requires macOS arm64")
  }
  const link = lstatSync(GH)
  if ((!link.isFile() && !link.isSymbolicLink())
    || (typeof process.getuid === "function" && link.uid !== 0 && link.uid !== process.getuid())) {
    throw new Error("Pinned gh entry must be owned by root or the current macOS user")
  }
  const realPath = realpathSync(GH)
  if (!realPath.startsWith(GH_REALPATH_PREFIX) || /[\r\n]/.test(realPath)) {
    throw new Error("Pinned gh executable must resolve inside the Homebrew Cellar")
  }
  const before = sha256FileBytes(realPath)
  const versionResult = spawnSync(realPath, ["version"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: GH_TIMEOUT_MS,
    env: createH3GithubEnvironment(),
  })
  if (versionResult.error || versionResult.status !== 0) throw new Error("Pinned gh version inspection failed")
  const version = versionResult.stdout.split("\n", 1)[0]?.trim() ?? ""
  if (!/^gh version (?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*) \([^\r\n]+\)$/.test(version)) {
    throw new Error("Pinned gh version output differs")
  }
  const after = sha256FileBytes(realPath)
  assertH3GhBinaryIdentityUnchanged(
    { linkPath: GH, realPath, version, ...before },
    { linkPath: GH, realPath, version, ...after },
  )
  return { linkPath: GH, realPath, version, ...after }
}

export function assertH3GhBinaryIdentityUnchanged(before: H3GhBinaryIdentity, after: H3GhBinaryIdentity): void {
  if (stable(before) !== stable(after)) throw new Error("Pinned gh executable identity drifted during H3 authentication")
}

const systemH3GhApiCommandRunner: H3GhApiCommandRunner = {
  inspectIdentity: inspectH3GhBinaryIdentity,
  run(command, args, options) {
    const result = spawnSync(command, [...args], options)
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error,
    }
  },
}

export function runH3GhApiCommand(
  identity: H3GhBinaryIdentity,
  endpoint: string,
  runner: H3GhApiCommandRunner,
  environmentSource: NodeJS.ProcessEnv = process.env,
): JsonObject {
  if (!/^repos\/Jiachi-Deng\/Simulator\/actions\/(?:runs\/[1-9][0-9]*(?:\/artifacts\?per_page=100)?|artifacts\/[1-9][0-9]*)$/.test(endpoint)) {
    throw new Error("GitHub API endpoint differs from the fixed H3 authority boundary")
  }
  const before = runner.inspectIdentity()
  assertH3GhBinaryIdentityUnchanged(identity, before)
  const environment = createH3GithubEnvironment(environmentSource)
  let result: H3GhCommandResult
  try {
    result = runner.run(identity.realPath, [...H3_GITHUB_API_ARGUMENT_PREFIX, endpoint], {
      encoding: "utf8",
      maxBuffer: MAX_GITHUB_RESPONSE_BYTES,
      timeout: GH_TIMEOUT_MS,
      env: environment,
    })
  } finally {
    const after = runner.inspectIdentity()
    assertH3GhBinaryIdentityUnchanged(identity, after)
    assertH3GhBinaryIdentityUnchanged(before, after)
  }
  if (result.error || result.status !== 0) {
    const diagnostic = sanitizeH3GhDiagnostic([
      result.error?.message ?? "",
      result.stderr,
      result.stdout,
    ].filter(Boolean).join("\n"), [environment.GH_TOKEN ?? ""])
    const status = result.error?.code ?? (result.status === null ? "unknown exit" : `exit ${result.status}`)
    throw new Error(`Authenticated GitHub API query failed (${status})${diagnostic ? `: ${diagnostic}` : ""}`)
  }
  if (Buffer.byteLength(result.stdout) > MAX_GITHUB_RESPONSE_BYTES) throw new Error("GitHub API response exceeds the H3 bound")
  try {
    return object(JSON.parse(result.stdout), "GitHub API response")
  } catch {
    throw new Error("Authenticated GitHub API response is not valid JSON")
  }
}

function validateAuthenticatedAuthority(value: unknown): H3AuthenticatedCandidateAuthority {
  const authority = object(value, "H3 authenticated Candidate authority")
  exactKeys(authority, [
    "artifactExpired", "artifactId", "artifactName", "artifactServiceDigest", "authenticatedAt",
    "candidateDmgBytes", "candidateDmgSha256", "candidateWorkflowName", "conclusion", "event", "headBranch",
    "githubClient", "rawCandidateBytes", "rawCandidateSha256", "repository", "repositoryId", "runAttempt", "runId", "sourceSha",
    "status", "workflowDisplayName", "workflowPath",
  ], "H3 authenticated Candidate authority")
  if (authority.repository !== REPOSITORY || authority.repositoryId !== REPOSITORY_ID || authority.headBranch !== "main"
    || authority.workflowPath !== WORKFLOW_PATH || authority.workflowDisplayName !== WORKFLOW_DISPLAY_NAME
    || authority.candidateWorkflowName !== "signed-macos-host-acceptance.yml" || authority.event !== "workflow_dispatch"
    || authority.status !== "completed" || authority.conclusion !== "success" || authority.artifactExpired !== false) {
    throw new Error("H3 authenticated Candidate authority differs from the fixed release authority")
  }
  const sourceSha = string(authority.sourceSha, SOURCE_SHA, "sourceSha")
  const runId = string(authority.runId, POSITIVE_ID, "runId")
  const artifactId = string(authority.artifactId, POSITIVE_ID, "artifactId")
  const artifactName = string(
    authority.artifactName,
    /^simulator-host-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?-macos-arm64-developer-id-candidate-[0-9a-f]{40}$/,
    "artifactName",
  )
  if (!artifactName.endsWith(`-${sourceSha}`)) throw new Error("Authenticated Artifact name differs from source SHA")
  const artifactServiceDigest = string(authority.artifactServiceDigest, SERVICE_DIGEST, "artifactServiceDigest")
  const rawCandidateSha256 = string(authority.rawCandidateSha256, SHA256, "rawCandidateSha256")
  if (artifactServiceDigest !== `sha256:${rawCandidateSha256}`) {
    throw new Error("Raw Candidate archive digest differs from GitHub Artifact service digest")
  }
  string(authority.candidateDmgSha256, SHA256, "candidateDmgSha256")
  positiveInteger(authority.rawCandidateBytes, "rawCandidateBytes")
  positiveInteger(authority.candidateDmgBytes, "candidateDmgBytes")
  positiveInteger(authority.runAttempt, "runAttempt")
  const githubClient = object(authority.githubClient, "githubClient")
  exactKeys(githubClient, ["bytes", "linkPath", "realPath", "sha256", "version"], "githubClient")
  if (githubClient.linkPath !== GH
    || typeof githubClient.realPath !== "string" || !githubClient.realPath.startsWith(GH_REALPATH_PREFIX)
    || typeof githubClient.version !== "string"
    || !/^gh version (?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*) \([^\r\n]+\)$/.test(githubClient.version)) {
    throw new Error("Invalid authenticated githubClient identity")
  }
  positiveInteger(githubClient.bytes, "githubClient.bytes")
  string(githubClient.sha256, SHA256, "githubClient.sha256")
  const authenticatedAt = canonicalTimestamp(authority.authenticatedAt, "authenticatedAt")
  if (Date.parse(authenticatedAt) > Date.now()) throw new Error("Authenticated authority timestamp is in the future")
  return authority as unknown as H3AuthenticatedCandidateAuthority
}

export const systemH3AuthorityAuthenticator: H3AuthorityAuthenticator = {
  authenticate(rawArtifactArchivePath) {
    const gh = inspectH3GhBinaryIdentity()
    try {
      const local = inspectH3RawCandidateArchive(rawArtifactArchivePath)
      const run = runH3GhApiCommand(gh, `repos/${REPOSITORY}/actions/runs/${local.runId}`, systemH3GhApiCommandRunner)
      const repository = object(run.repository, "workflow run repository")
      const headRepository = object(run.head_repository, "workflow run head repository")
      if (String(run.id) !== local.runId || run.run_attempt !== local.runAttempt || run.path !== WORKFLOW_PATH
        || run.name !== WORKFLOW_DISPLAY_NAME || run.head_sha !== local.sourceSha || run.head_branch !== "main"
        || run.event !== "workflow_dispatch" || run.status !== "completed" || run.conclusion !== "success"
        || repository.id !== REPOSITORY_ID || repository.full_name !== REPOSITORY
        || headRepository.id !== REPOSITORY_ID || headRepository.full_name !== REPOSITORY) {
        throw new Error("Authenticated GitHub workflow run differs from the raw Candidate")
      }
      const listing = runH3GhApiCommand(
        gh,
        `repos/${REPOSITORY}/actions/runs/${local.runId}/artifacts?per_page=100`,
        systemH3GhApiCommandRunner,
      )
      if (!Array.isArray(listing.artifacts) || !Number.isSafeInteger(listing.total_count)
        || listing.total_count !== listing.artifacts.length || (listing.total_count as number) > 100) {
        throw new Error("GitHub Artifact listing is malformed or incomplete")
      }
      const candidates = listing.artifacts.filter((candidate) => isObject(candidate) && candidate.name === local.artifactName)
      if (candidates.length !== 1) throw new Error("Expected exactly one authenticated Candidate Artifact")
      const listedArtifact = candidates[0]!
      const listedArtifactId = positiveInteger(listedArtifact.id, "listed Artifact ID")
      const artifact = runH3GhApiCommand(
        gh,
        `repos/${REPOSITORY}/actions/artifacts/${listedArtifactId}`,
        systemH3GhApiCommandRunner,
      )
      const workflowRun = object(artifact.workflow_run, "Artifact workflow_run")
      if (artifact.id !== listedArtifactId || artifact.name !== local.artifactName
        || artifact.digest !== listedArtifact.digest || artifact.expired !== false
        || artifact.size_in_bytes !== local.rawArchiveBytes
        || String(workflowRun.id) !== local.runId || workflowRun.head_sha !== local.sourceSha
        || workflowRun.head_branch !== "main" || workflowRun.repository_id !== REPOSITORY_ID
        || workflowRun.head_repository_id !== REPOSITORY_ID) {
        throw new Error("Authenticated Artifact workflow authority differs")
      }
      return validateAuthenticatedAuthority({
        repository: REPOSITORY,
        repositoryId: REPOSITORY_ID,
        sourceSha: local.sourceSha,
        headBranch: "main",
        runId: local.runId,
        runAttempt: local.runAttempt,
        workflowPath: WORKFLOW_PATH,
        workflowDisplayName: WORKFLOW_DISPLAY_NAME,
        candidateWorkflowName: local.workflowName,
        event: "workflow_dispatch",
        status: "completed",
        conclusion: "success",
        artifactId: String(artifact.id),
        artifactName: local.artifactName,
        artifactServiceDigest: artifact.digest,
        artifactExpired: artifact.expired,
        rawCandidateBytes: local.rawArchiveBytes,
        rawCandidateSha256: local.rawArchiveSha256,
        candidateDmgBytes: local.dmgBytes,
        candidateDmgSha256: local.dmgSha256,
        githubClient: {
          linkPath: gh.linkPath,
          realPath: gh.realPath,
          version: gh.version,
          bytes: gh.bytes,
          sha256: gh.sha256,
        },
        authenticatedAt: new Date().toISOString(),
      })
    } finally {
      assertH3GhBinaryIdentityUnchanged(gh, inspectH3GhBinaryIdentity())
    }
  },
}

function authorityTuple(authorityValue: H3AuthenticatedCandidateAuthority): Pick<
  H3PostInstallAuthorityEvidence,
  "github" | "rawCandidate" | "candidate" | "githubClient"
> {
  const authority = validateAuthenticatedAuthority(authorityValue)
  return {
    github: {
      repositoryId: authority.repositoryId,
      sourceSha: authority.sourceSha,
      headBranch: authority.headBranch,
      runId: authority.runId,
      runAttempt: authority.runAttempt,
      workflowPath: authority.workflowPath,
      workflowDisplayName: authority.workflowDisplayName,
      candidateWorkflowName: authority.candidateWorkflowName,
      event: authority.event,
      status: authority.status,
      conclusion: authority.conclusion,
      artifactId: authority.artifactId,
      artifactName: authority.artifactName,
      artifactServiceDigest: authority.artifactServiceDigest,
      artifactExpired: authority.artifactExpired,
    },
    rawCandidate: { bytes: authority.rawCandidateBytes, sha256: authority.rawCandidateSha256 },
    candidate: { dmgBytes: authority.candidateDmgBytes, dmgSha256: authority.candidateDmgSha256 },
    githubClient: authority.githubClient,
  }
}

function authorityEvidence(
  authorityValue: H3AuthenticatedCandidateAuthority,
  postInstallBytes: string,
): H3PostInstallAuthorityEvidence {
  const authority = validateAuthenticatedAuthority(authorityValue)
  const tuple = authorityTuple(authority)
  return validateH3PostInstallAuthorityEvidence({
    schemaVersion: 1,
    kind: "simulator-h3-post-install-authority",
    repository: REPOSITORY,
    authenticatedAt: authority.authenticatedAt,
    ...tuple,
    postInstall: { path: "post-install.json", bytes: Buffer.byteLength(postInstallBytes), sha256: sha256(postInstallBytes) },
  })
}

export function validateH3PostInstallAuthorityEvidence(value: unknown): H3PostInstallAuthorityEvidence {
  const evidence = object(value, "H3 post-install authority evidence")
  exactKeys(evidence, ["authenticatedAt", "candidate", "github", "githubClient", "kind", "postInstall", "rawCandidate", "repository", "schemaVersion"], "H3 post-install authority evidence")
  if (evidence.schemaVersion !== 1 || evidence.kind !== "simulator-h3-post-install-authority" || evidence.repository !== REPOSITORY) {
    throw new Error("H3 post-install authority identity differs")
  }
  const github = object(evidence.github, "github")
  exactKeys(github, [
    "artifactExpired", "artifactId", "artifactName", "artifactServiceDigest", "candidateWorkflowName", "conclusion",
    "event", "headBranch", "repositoryId", "runAttempt", "runId", "sourceSha", "status", "workflowDisplayName", "workflowPath",
  ], "github")
  const rawCandidate = object(evidence.rawCandidate, "rawCandidate")
  exactKeys(rawCandidate, ["bytes", "sha256"], "rawCandidate")
  const candidate = object(evidence.candidate, "candidate")
  exactKeys(candidate, ["dmgBytes", "dmgSha256"], "candidate")
  const postInstall = object(evidence.postInstall, "postInstall")
  exactKeys(postInstall, ["bytes", "path", "sha256"], "postInstall")
  validateAuthenticatedAuthority({
    repository: REPOSITORY,
    repositoryId: github.repositoryId,
    sourceSha: github.sourceSha,
    headBranch: github.headBranch,
    runId: github.runId,
    runAttempt: github.runAttempt,
    workflowPath: github.workflowPath,
    workflowDisplayName: github.workflowDisplayName,
    candidateWorkflowName: github.candidateWorkflowName,
    event: github.event,
    status: github.status,
    conclusion: github.conclusion,
    artifactId: github.artifactId,
    artifactName: github.artifactName,
    artifactServiceDigest: github.artifactServiceDigest,
    artifactExpired: github.artifactExpired,
    rawCandidateBytes: rawCandidate.bytes,
    rawCandidateSha256: rawCandidate.sha256,
    candidateDmgBytes: candidate.dmgBytes,
    candidateDmgSha256: candidate.dmgSha256,
    githubClient: evidence.githubClient,
    authenticatedAt: evidence.authenticatedAt,
  })
  if (postInstall.path !== "post-install.json") throw new Error("Post-install authority path differs")
  positiveInteger(postInstall.bytes, "postInstall.bytes")
  string(postInstall.sha256, SHA256, "postInstall.sha256")
  return evidence as unknown as H3PostInstallAuthorityEvidence
}

function requireOwnerOnlyDirectory(path: string, empty = false): string {
  const absolute = resolve(path)
  const metadata = lstatSync(absolute)
  if (path !== absolute || !metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(absolute) !== absolute
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid()) || (metadata.mode & 0o777) !== 0o700
    || (empty && readdirSync(absolute).length !== 0)) {
    throw new Error("H3 authority closure directory must be canonical, owner-only, and empty when required")
  }
  return absolute
}

function readOwnerOnly(path: string, label: string, maximumBytes: number): Buffer {
  const absolute = resolve(path)
  const metadata = lstatSync(absolute)
  if (path !== absolute || !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || realpathSync(absolute) !== absolute || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    || (metadata.mode & 0o777) !== 0o600 || metadata.size < 1 || metadata.size > maximumBytes) {
    throw new Error(`${label} must be one canonical owner-only regular file`)
  }
  return readFileSync(absolute)
}

function writeOwnerOnly(path: string, bytes: string): void {
  const descriptor = openSync(path, "wx", 0o600)
  try {
    fchmodSync(descriptor, 0o600)
    writeFileSync(descriptor, bytes)
  } finally {
    closeSync(descriptor)
  }
}

function compareAuthority(evidence: H3PostInstallAuthorityEvidence, current: H3AuthenticatedCandidateAuthority): void {
  const expected = authorityTuple(current)
  if (stable(evidence.github) !== stable(expected.github)
    || stable(evidence.rawCandidate) !== stable(expected.rawCandidate)
    || stable(evidence.candidate) !== stable(expected.candidate)
    || stable(evidence.githubClient) !== stable(expected.githubClient)) {
    throw new Error("H3 post-install authority differs from the independently authenticated GitHub Candidate")
  }
}

export function writeH3PostInstallAuthorityClosure(
  rawArtifactArchivePath: string,
  dmgPath: string,
  humanInputPath: string,
  outputRootPath: string,
  dependencies: H3PostInstallAuthorityDependencies,
): { root: string; authoritySha256: string; postInstallSha256: string } {
  const root = requireOwnerOnlyDirectory(outputRootPath, true)
  const humanBytes = readOwnerOnly(humanInputPath, "H3 post-install human input", 64 * 1024)
  const human = validateH3PostInstallHumanInput(JSON.parse(humanBytes.toString("utf8")))
  const authority = validateAuthenticatedAuthority(dependencies.authenticator.authenticate(rawArtifactArchivePath))
  const legacyAuthority: H3CandidateArtifactAuthority = {
    artifactName: authority.artifactName,
    artifactId: authority.artifactId,
    artifactDigest: authority.artifactServiceDigest,
    runId: authority.runId,
  }
  const postInstall = generateH3PostInstallEvidence(
    rawArtifactArchivePath,
    dmgPath,
    legacyAuthority,
    human,
    dependencies.inspector,
    dependencies.now,
  )
  if (postInstall.sourceSha !== authority.sourceSha || postInstall.dmgBytes !== authority.candidateDmgBytes
    || postInstall.dmgSha256 !== authority.candidateDmgSha256) {
    throw new Error("Post-install inspection differs from the authenticated raw Candidate")
  }
  if (Date.parse(authority.authenticatedAt) > Date.parse(postInstall.installedAt)) {
    throw new Error("H3 Stage-1 GitHub authentication must precede the post-install inspection")
  }
  const postInstallBytes = canonicalH3PostInstallEvidence(postInstall)
  const authorityObject = authorityEvidence(authority, postInstallBytes)
  const authorityBytes = canonical(authorityObject)
  try {
    writeOwnerOnly(join(root, "post-install.json"), postInstallBytes)
    writeOwnerOnly(join(root, "post-install-authority.json"), authorityBytes)
    const checksums = H3_POST_INSTALL_AUTHORITY_CLOSURE.filter((path) => path !== "SHA256SUMS")
      .map((path) => `${sha256(readFileSync(join(root, path)))}  ${path}`).join("\n") + "\n"
    writeOwnerOnly(join(root, "SHA256SUMS"), checksums)
    return { root, authoritySha256: sha256(authorityBytes), postInstallSha256: sha256(postInstallBytes) }
  } catch (error) {
    for (const path of H3_POST_INSTALL_AUTHORITY_CLOSURE) rmSync(join(root, path), { force: true })
    throw error
  }
}

export function verifyH3PostInstallAuthorityClosure(
  rootPath: string,
  rawArtifactArchivePath: string,
  authenticator: H3AuthorityAuthenticator = systemH3AuthorityAuthenticator,
): { root: string; authoritySha256: string; postInstallSha256: string; authority: H3PostInstallAuthorityEvidence; postInstallPath: string } {
  const root = requireOwnerOnlyDirectory(rootPath)
  const actual = readdirSync(root).sort()
  const expected = [...H3_POST_INSTALL_AUTHORITY_CLOSURE].sort()
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error("H3 post-install authority closure differs")
  }
  const authorityBytes = readOwnerOnly(join(root, "post-install-authority.json"), "H3 post-install authority", MAX_AUTHORITY_BYTES)
  const authority = validateH3PostInstallAuthorityEvidence(JSON.parse(authorityBytes.toString("utf8")))
  if (!authorityBytes.equals(Buffer.from(canonical(authority)))) throw new Error("H3 post-install authority is not canonical")
  const postInstallPath = join(root, "post-install.json")
  const postInstallBytes = readOwnerOnly(postInstallPath, "H3 post-install evidence", MAX_POST_INSTALL_BYTES)
  const postInstall = verifyH3PostInstallEvidenceFile(postInstallPath)
  if (postInstallBytes.length !== authority.postInstall.bytes || postInstall.sha256 !== authority.postInstall.sha256) {
    throw new Error("H3 post-install evidence differs from the authority closure")
  }
  if (postInstall.evidence.sourceSha !== authority.github.sourceSha
    || postInstall.evidence.hostBuildRunId !== authority.github.runId
    || postInstall.evidence.artifactId !== authority.github.artifactId
    || postInstall.evidence.artifactName !== authority.github.artifactName
    || postInstall.evidence.artifactDigest !== authority.github.artifactServiceDigest
    || postInstall.evidence.dmgBytes !== authority.candidate.dmgBytes
    || postInstall.evidence.dmgSha256 !== authority.candidate.dmgSha256) {
    throw new Error("H3 post-install claims differ from the authenticated authority tuple")
  }
  if (Date.parse(authority.authenticatedAt) > Date.parse(postInstall.evidence.installedAt)) {
    throw new Error("H3 Stage-1 GitHub authentication must precede the sealed post-install inspection")
  }
  const sumsBytes = readOwnerOnly(join(root, "SHA256SUMS"), "H3 post-install authority checksums", 4096)
  const expectedSums = H3_POST_INSTALL_AUTHORITY_CLOSURE.filter((path) => path !== "SHA256SUMS")
    .map((path) => `${sha256(readFileSync(join(root, path)))}  ${path}`).join("\n") + "\n"
  if (sumsBytes.toString("utf8") !== expectedSums) throw new Error("H3 post-install authority SHA256SUMS differs")
  const current = validateAuthenticatedAuthority(authenticator.authenticate(rawArtifactArchivePath))
  compareAuthority(authority, current)
  return {
    root,
    authoritySha256: sha256(authorityBytes),
    postInstallSha256: postInstall.sha256,
    authority,
    postInstallPath,
  }
}

export function assertH3PostInstallLiveEvidenceMatches(
  sealedValue: unknown,
  liveValue: unknown,
): void {
  const sealed = validateH3PostInstallEvidence(sealedValue)
  const live = validateH3PostInstallEvidence(liveValue)
  if (canonicalH3PostInstallEvidence(sealed) !== canonicalH3PostInstallEvidence(live)) {
    throw new Error("Pre-restore live Candidate inspection differs from the sealed Stage-1 post-install evidence")
  }
}

/**
 * Production-only pre-restore gate.  This must run while the Candidate is still
 * installed at /Applications/Simulator.app.  Unlike the portable closure
 * verifier, it deliberately exposes no authenticator or Inspector injection
 * seam: GitHub authority, the retained DMG, and every reproducible installed
 * App field are inspected again by the production implementations.
 */
export function verifyH3PostInstallAuthorityClosureLive(
  rootPath: string,
  rawArtifactArchivePath: string,
  dmgPath: string,
  humanInputPath: string,
): {
  root: string
  authoritySha256: string
  postInstallSha256: string
  postInstall: H3PostInstallEvidence
} {
  const closure = verifyH3PostInstallAuthorityClosure(
    rootPath,
    rawArtifactArchivePath,
    systemH3AuthorityAuthenticator,
  )
  const sealed = verifyH3PostInstallEvidenceFile(closure.postInstallPath).evidence
  if (Date.parse(sealed.installedAt) > Date.now()) throw new Error("Stage-1 installedAt is in the future")
  const humanBytes = readOwnerOnly(humanInputPath, "H3 post-install human input", 64 * 1024)
  const human = validateH3PostInstallHumanInput(JSON.parse(humanBytes.toString("utf8")))
  const legacyAuthority: H3CandidateArtifactAuthority = {
    artifactName: closure.authority.github.artifactName,
    artifactId: closure.authority.github.artifactId,
    artifactDigest: closure.authority.github.artifactServiceDigest,
    runId: closure.authority.github.runId,
  }
  const live = generateH3PostInstallEvidence(
    rawArtifactArchivePath,
    dmgPath,
    legacyAuthority,
    human,
    systemH3PostInstallInspector,
    () => new Date(sealed.installedAt),
  )
  assertH3PostInstallLiveEvidenceMatches(sealed, live)
  return {
    root: closure.root,
    authoritySha256: closure.authoritySha256,
    postInstallSha256: closure.postInstallSha256,
    postInstall: sealed,
  }
}

if (import.meta.main) {
  process.umask(0o077)
  const [operation, first, second, third, fourth, fifth] = process.argv.slice(2)
  if (operation === "generate" && first && second && third && fourth && !fifth) {
    const result = writeH3PostInstallAuthorityClosure(first, second, third, fourth, {
      authenticator: systemH3AuthorityAuthenticator,
      inspector: systemH3PostInstallInspector,
      now: () => new Date(),
    })
    console.log(JSON.stringify({ ok: true, ...result }))
  } else if (operation === "pre-restore-verify" && first && second && third && fourth && !fifth) {
    const result = verifyH3PostInstallAuthorityClosureLive(first, second, third, fourth)
    console.log(JSON.stringify({
      ok: true,
      root: result.root,
      authoritySha256: result.authoritySha256,
      postInstallSha256: result.postInstallSha256,
    }))
  } else if (operation === "validate" && first && second && !third) {
    const result = verifyH3PostInstallAuthorityClosure(first, second)
    console.log(JSON.stringify({ ok: true, root: result.root, authoritySha256: result.authoritySha256, postInstallSha256: result.postInstallSha256 }))
  } else {
    throw new Error(
      "Usage: h3-post-install-authority.ts generate RAW_CANDIDATE_ARTIFACT_ZIP DMG_PATH HUMAN_INPUT_JSON EMPTY_AUTHORITY_CLOSURE_DIR"
      + " | pre-restore-verify AUTHORITY_CLOSURE_DIR RAW_CANDIDATE_ARTIFACT_ZIP DMG_PATH HUMAN_INPUT_JSON"
      + " | validate AUTHORITY_CLOSURE_DIR RAW_CANDIDATE_ARTIFACT_ZIP",
    )
  }
}
