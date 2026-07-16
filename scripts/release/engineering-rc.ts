import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { spawnSync } from "node:child_process"

export interface RepositoryState {
  dirty: boolean
  sourceSha: string
  mainSha: string
  tags: string[]
}

export interface ValidationInput {
  rootDir: string
  rcLabel: string
  ref: string
  repository: RepositoryState
}

export interface ValidationCheck {
  id: string
  ok: boolean
  message: string
  details?: string[]
}

export interface ValidationResult {
  schemaVersion: 1
  ok: boolean
  rcLabel: string
  productVersion: string | null
  ref: string
  sourceSha: string
  mainSha: string
  checks: ValidationCheck[]
}

const RC_LABEL = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.([1-9]\d*)$/
const RELEASE_NOTE_TEMPLATE_LINES = new Set([
  "# Pending Release Notes",
  "## Features",
  "## Improvements",
  "## Bug Fixes",
  "## Breaking Changes",
])

function manifestPaths(rootDir: string): string[] {
  const paths = [join(rootDir, "package.json")]
  for (const parentName of ["apps", "packages"]) {
    const parent = join(rootDir, parentName)
    if (!existsSync(parent)) continue
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || (parentName === "apps" && entry.name === "online-docs")) continue
      const path = join(parent, entry.name, "package.json")
      if (existsSync(path)) paths.push(path)
    }
  }
  return paths.sort()
}

function noteContentLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("<!--"))
}

function hasExactVersionHeading(content: string, version: string): boolean {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const token = new RegExp(`(^|[^0-9A-Za-z.-])${escaped}($|[^0-9A-Za-z.-])`)
  return content.split(/\r?\n/).some((line) => /^#{1,6}\s+\S/.test(line) && token.test(line))
}

function validReleaseNoteBullets(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(?:[-+*]|\d+\.)\s+(.+?)\s*$/)?.[1] ?? "")
    .filter((text) => /[\p{L}\p{N}]/u.test(text))
    .filter((text) => !/^This file accumulates release notes/i.test(text))
}

function nextNotePayload(content: string): string[] {
  return noteContentLines(content).filter(
    (line) => !RELEASE_NOTE_TEMPLATE_LINES.has(line) && !line.startsWith("This file accumulates "),
  )
}

export function productVersionFromRcLabel(rcLabel: string): string | null {
  const match = RC_LABEL.exec(rcLabel)
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null
}

export function validateEngineeringRc(input: ValidationInput): ValidationResult {
  const { rootDir, rcLabel, ref, repository } = input
  const productVersion = productVersionFromRcLabel(rcLabel)
  const checks: ValidationCheck[] = []
  const add = (check: ValidationCheck): void => void checks.push(check)

  add({
    id: "label.rc-semver",
    ok: productVersion !== null,
    message: "Engineering bundle label must be canonical SemVer X.Y.Z-rc.N.",
  })
  add({ id: "repository.clean", ok: !repository.dirty, message: "Repository must be clean." })
  add({
    id: "repository.exact-main",
    ok: repository.sourceSha === repository.mainSha && ref === repository.sourceSha,
    message: "Ref and source SHA must exactly equal the origin/main tip.",
    details: [`ref=${ref}`, `source=${repository.sourceSha}`, `main=${repository.mainSha}`],
  })

  const mismatches: string[] = []
  for (const path of manifestPaths(rootDir)) {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as { version?: string }
    if (productVersion === null || manifest.version !== productVersion) {
      mismatches.push(`${relative(rootDir, path)}: ${manifest.version ?? "<missing>"}`)
    }
  }
  add({
    id: "manifests.product-version",
    ok: mismatches.length === 0,
    message: "All distributable workspace manifests must match the stable Host product version derived from the RC label.",
    ...(mismatches.length ? { details: mismatches } : {}),
  })

  const notePath = join(
    rootDir,
    "apps/electron/resources/release-notes",
    productVersion === null ? "<invalid-rc-label>.md" : `${productVersion}.md`,
  )
  const noteContent = existsSync(notePath) ? readFileSync(notePath, "utf8") : ""
  const noteBullets = validReleaseNoteBullets(noteContent)
  add({
    id: "release-note.product-versioned",
    ok: productVersion !== null && hasExactVersionHeading(noteContent, productVersion) && noteBullets.length > 0,
    message: "The Host product release note must have a heading containing the exact product version and at least one substantive Markdown bullet.",
  })

  const nextPath = join(rootDir, "apps/electron/resources/release-notes/next.md")
  const pending = existsSync(nextPath) ? nextNotePayload(readFileSync(nextPath, "utf8")) : ["<missing next.md>"]
  add({
    id: "release-note.next-archived",
    ok: pending.length === 0,
    message: "next.md must contain only its empty template after RC notes are archived.",
    ...(pending.length ? { details: pending } : {}),
  })

  const conflictingTags = repository.tags.filter((tag) => tag === rcLabel || tag === `v${rcLabel}`).sort()
  add({
    id: "repository.tag-available",
    ok: conflictingTags.length === 0,
    message: "Neither the plain nor v-prefixed RC tag may already exist.",
    ...(conflictingTags.length ? { details: conflictingTags } : {}),
  })

  return {
    schemaVersion: 1,
    ok: checks.every((check) => check.ok),
    rcLabel,
    productVersion,
    ref,
    sourceSha: repository.sourceSha,
    mainSha: repository.mainSha,
    checks,
  }
}

function git(rootDir: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: rootDir, encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`)
  return result.stdout.trim()
}

export function readRepositoryState(rootDir: string, ref: string): RepositoryState {
  return {
    dirty: git(rootDir, ["status", "--porcelain"]) !== "",
    sourceSha: git(rootDir, ["rev-parse", `${ref}^{commit}`]),
    mainSha: git(rootDir, ["rev-parse", "refs/remotes/origin/main^{commit}"]),
    tags: git(rootDir, ["tag", "--list"]).split("\n").filter(Boolean).sort(),
  }
}

function parseArgs(args: string[]): { rcLabel: string; ref: string; rootDir: string } {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!key?.startsWith("--") || !value) throw new Error("Usage: engineering-rc.ts --label X.Y.Z-rc.N --ref SHA [--root DIR]")
    values.set(key, value)
  }
  const rcLabel = values.get("--label")
  const ref = values.get("--ref")
  if (!rcLabel || !ref) throw new Error("Both --label and --ref are required.")
  return { rcLabel, ref, rootDir: values.get("--root") ?? join(import.meta.dir, "../..") }
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const result = validateEngineeringRc({ ...args, repository: readRepositoryState(args.rootDir, args.ref) })
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.ok ? 0 : 1)
  } catch (error) {
    console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2))
    process.exit(2)
  }
}
