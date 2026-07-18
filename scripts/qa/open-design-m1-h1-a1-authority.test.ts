import { afterEach, describe, expect, it } from 'bun:test'
import { createHmac } from 'node:crypto'
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claimOpenDesignM1H1A1Authority,
  initializeOpenDesignM1H1A1Authority,
  sealOpenDesignM1H1A1Authority,
  validateOpenDesignM1H1A1Authority,
  validateOpenDesignM1H1A1Claim,
  type H1A1AcceptanceRoots,
  type H1A1AuthorityResult,
  type H1A1EvidenceIdentity,
  type H1A1ReleaseIdentity,
} from './open-design-m1-h1-a1-authority'
import { canonicalJson, sha256 } from './open-design-m1-local-evidence'

const roots: string[] = []
const NOW = Date.parse('2026-07-18T01:00:00.000Z')
const KEY = Buffer.alloc(32, 0x42)
const HMAC = '8'.repeat(64)

interface Fixture {
  readonly parent: string
  readonly pendingRoot: string
  readonly authorityRoot: string
  readonly preflightRoot: string
  readonly connectionRoot: string
  readonly release: H1A1ReleaseIdentity
  readonly evidence: H1A1EvidenceIdentity
  readonly acceptance: H1A1AcceptanceRoots
}

async function ownerDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function evidenceDirectory(path: string, objectPath: string, value: unknown): Promise<string> {
  await ownerDirectory(path)
  const source = canonicalJson(value)
  const digest = sha256(source)
  await writeFile(join(path, objectPath), source, { mode: 0o600 })
  await chmod(join(path, objectPath), 0o600)
  await writeFile(join(path, 'SHA256SUMS'), `${digest}  ${objectPath}\n`, { mode: 0o600 })
  await chmod(join(path, 'SHA256SUMS'), 0o600)
  return digest
}

function keyCommitment(key = KEY, hmac = HMAC): string {
  return createHmac('sha256', key)
    .update('open-design-m1-h1-a1-authority-v1\0', 'utf8')
    .update(hmac, 'utf8')
    .digest('hex')
}

async function fixture(options: { commitmentKey?: Buffer } = {}): Promise<Fixture> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'open-design-h1-a1-authority-test-')))
  roots.push(parent)
  await chmod(parent, 0o700)
  const pendingRoot = join(parent, 'pending')
  const authorityRoot = join(parent, 'authority')
  const preflightRoot = join(parent, 'preflight')
  const connectionRoot = join(parent, 'connection')
  const home = join(parent, 'home')
  const config = join(parent, 'config')
  const profile = join(parent, 'profile')
  await Promise.all([ownerDirectory(home), ownerDirectory(config), ownerDirectory(profile)])
  const release: H1A1ReleaseIdentity = Object.freeze({
    sourceSha: '1234567890abcdef1234567890abcdef12345678',
    hostBuildRunId: 8_001,
    hostArtifactId: 8_002,
    hostArtifactName: 'simulator-0.12.0-rc.6-macos-arm64-unsigned',
    hostArtifactDigest: `sha256:${'a'.repeat(64)}`,
  })
  const preflightSha256 = await evidenceDirectory(preflightRoot, 'h1-preflight.json', {
    schemaVersion: 2,
    kind: 'open-design-m1-h1-preflight-evidence',
    authority: release,
    staging: {},
    launch: { configRealpath: config, profileRealpath: profile },
    observation: { observedAt: new Date(NOW - 1_000).toISOString(), verifierDidNotSendTurn: true },
  })
  const connectionSha256 = await evidenceDirectory(connectionRoot, 'h1-connection.json', {
    schemaVersion: 3,
    kind: 'open-design-m1-h1-connection-evidence',
    preflight: { rootRealpath: preflightRoot, objectPath: 'h1-preflight.json', sha256: preflightSha256 },
    connectionAuthority: {
      schemaVersion: 1,
      authenticated: true,
      authorityHmacSha256: HMAC,
      authorityKeyCommitmentSha256: keyCommitment(options.commitmentKey),
    },
    observation: { observedAt: new Date(NOW).toISOString(), verifierDidNotSendTurn: true },
  })
  await initializeOpenDesignM1H1A1Authority(pendingRoot, () => KEY)
  return {
    parent,
    pendingRoot,
    authorityRoot,
    preflightRoot,
    connectionRoot,
    release,
    evidence: { preflightRootRealpath: preflightRoot, preflightSha256, connectionRootRealpath: connectionRoot, connectionSha256 },
    acceptance: { homeRealpath: home, configRealpath: config, userDataRealpath: profile, profileRealpath: profile },
  }
}

async function seal(value: Fixture): Promise<H1A1AuthorityResult> {
  return sealOpenDesignM1H1A1Authority({
    pendingRoot: value.pendingRoot,
    authorityRoot: value.authorityRoot,
    release: value.release,
    evidence: value.evidence,
    acceptance: value.acceptance,
  })
}

function expected(value: Fixture, authority: H1A1AuthorityResult) {
  return {
    ...value.release,
    handoffSha256: authority.authoritySha256,
    connectionSha256: value.evidence.connectionSha256,
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('OpenDesign M1 H1-A1 one-time authority', () => {
  it('atomically seals an exact owner-only authority and retires the pending capsule', async () => {
    const value = await fixture()
    const authority = await seal(value)
    expect((await readdir(value.authorityRoot)).sort()).toEqual(['SHA256SUMS', 'authority-key.bin', 'authority.json'])
    await expect(readdir(value.pendingRoot)).rejects.toThrow()
    expect(await validateOpenDesignM1H1A1Authority(value.authorityRoot, expected(value, authority))).toEqual(authority)
    const manifestSource = await readFile(join(value.authorityRoot, 'authority.json'), 'utf8')
    const manifest = JSON.parse(manifestSource)
    expect(manifest.key).toEqual({ objectPath: 'authority-key.bin', bytes: 32, sha256: sha256(KEY) })
    expect(manifest.connectionAuthority).toEqual({ schemaVersion: 1, authenticated: true, authorityHmacSha256: HMAC })
    expect(manifestSource).not.toContain(KEY.toString('base64'))
    expect(manifestSource).not.toContain('slug')
    expect(manifestSource).not.toContain('provider')
    expect(manifestSource).not.toContain('model')
    expect(manifestSource).not.toContain('credential')
  })

  it('rejects a wrong pending key even when its capsule is internally checksummed', async () => {
    const value = await fixture({ commitmentKey: Buffer.alloc(32, 0x43) })
    await expect(seal(value)).rejects.toThrow('does not prove possession')
    expect(await readdir(value.parent)).not.toContain('authority')
    expect(await readdir(value.parent)).toContain('pending')
  })

  it('rejects wrong source, Artifact, public hashes, and noncanonical acceptance paths', async () => {
    const value = await fixture()
    const authority = await seal(value)
    for (const mutation of [
      { sourceSha: 'f'.repeat(40) },
      { hostArtifactId: value.release.hostArtifactId + 1 },
      { hostArtifactDigest: `sha256:${'b'.repeat(64)}` },
      { handoffSha256: 'c'.repeat(64) },
      { connectionSha256: 'd'.repeat(64) },
    ]) {
      await expect(validateOpenDesignM1H1A1Authority(
        value.authorityRoot, { ...expected(value, authority), ...mutation },
      )).rejects.toThrow('expected handoff authority')
    }

    const linked = await fixture()
    const alternate = join(linked.parent, 'alternate-home')
    await ownerDirectory(alternate)
    const symlinkPath = join(linked.parent, 'linked-home')
    await symlink(alternate, symlinkPath)
    await expect(sealOpenDesignM1H1A1Authority({
      pendingRoot: linked.pendingRoot,
      authorityRoot: linked.authorityRoot,
      release: linked.release,
      evidence: linked.evidence,
      acceptance: { ...linked.acceptance, homeRealpath: symlinkPath },
    })).rejects.toThrow('canonical owner-only directory')

    const wrongAuthorityPath = await fixture()
    await expect(sealOpenDesignM1H1A1Authority({
      pendingRoot: wrongAuthorityPath.pendingRoot,
      authorityRoot: join(wrongAuthorityPath.parent, 'alternate-authority'),
      release: wrongAuthorityPath.release,
      evidence: wrongAuthorityPath.evidence,
      acceptance: wrongAuthorityPath.acceptance,
    })).rejects.toThrow('fixed sibling')
  })

  it('rejects symlink, hardlink, permission, inventory, canonical JSON, and content replacement drift', async () => {
    const linked = await fixture()
    await unlink(join(linked.pendingRoot, 'authority-key.bin'))
    await symlink(join(linked.parent, 'missing-key'), join(linked.pendingRoot, 'authority-key.bin'))
    await expect(seal(linked)).rejects.toThrow()

    const hardlinked = await fixture()
    const copy = join(hardlinked.parent, 'hardlinked-key')
    await link(join(hardlinked.pendingRoot, 'authority-key.bin'), copy)
    await expect(seal(hardlinked)).rejects.toThrow('owner-only regular file')

    const permissive = await fixture()
    await chmod(join(permissive.pendingRoot, 'authority-key.bin'), 0o644)
    await expect(seal(permissive)).rejects.toThrow('owner-only regular file')

    const extra = await fixture()
    await writeFile(join(extra.pendingRoot, 'unexpected'), 'x', { mode: 0o600 })
    await expect(seal(extra)).rejects.toThrow('artifact inventory')

    const replaced = await fixture()
    const authority = await seal(replaced)
    await unlink(join(replaced.authorityRoot, 'authority-key.bin'))
    await writeFile(join(replaced.authorityRoot, 'authority-key.bin'), Buffer.alloc(32, 0x44), { mode: 0o600 })
    await chmod(join(replaced.authorityRoot, 'authority-key.bin'), 0o600)
    await expect(validateOpenDesignM1H1A1Authority(
      replaced.authorityRoot, expected(replaced, authority),
    )).rejects.toThrow('$authority.key')

    const evidenceReplacement = await fixture()
    await seal(evidenceReplacement)
    const connectionPath = join(evidenceReplacement.connectionRoot, 'h1-connection.json')
    const connection = JSON.parse(await readFile(connectionPath, 'utf8'))
    connection.observation.observedAt = new Date(NOW + 1).toISOString()
    await writeFile(connectionPath, canonicalJson(connection), { mode: 0o600 })
    await chmod(connectionPath, 0o600)
    const replacementDigest = sha256(canonicalJson(connection))
    await writeFile(
      join(evidenceReplacement.connectionRoot, 'SHA256SUMS'),
      `${replacementDigest}  h1-connection.json\n`, { mode: 0o600 },
    )
    await chmod(join(evidenceReplacement.connectionRoot, 'SHA256SUMS'), 0o600)
    await expect(validateOpenDesignM1H1A1Authority(
      evidenceReplacement.authorityRoot,
    )).rejects.toThrow('expected public hash')

    const noncanonical = await fixture()
    await seal(noncanonical)
    const manifestPath = join(noncanonical.authorityRoot, 'authority.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    await chmod(manifestPath, 0o600)
    await expect(validateOpenDesignM1H1A1Authority(noncanonical.authorityRoot)).rejects.toThrow('canonical compact JSON')
  })

  it('claims exactly once and leaves an invalid existing marker fail-closed', async () => {
    const value = await fixture()
    const authority = await seal(value)
    const input = {
      authorityRoot: value.authorityRoot,
      ...expected(value, authority),
      producerRunId: 90_001,
      producerRunAttempt: 2,
      now: () => NOW,
    }
    const claim = await claimOpenDesignM1H1A1Authority(input)
    expect(claim.claimFileRealpath).toBe(join(value.parent, 'claims', authority.authoritySha256, 'claim.json'))
    const claimMetadata = await lstatOwner(claim.claimFileRealpath)
    expect(claimMetadata.mode & 0o777).toBe(0o600)
    const claimSource = await readFile(claim.claimFileRealpath, 'utf8')
    expect(claimSource).not.toContain(KEY.toString('base64'))
    expect(claimSource).not.toContain(sha256(KEY))
    expect(claimSource).not.toContain('slug')
    expect(await validateOpenDesignM1H1A1Claim(claim.claimFileRealpath, input)).toEqual(claim)
    await expect(validateOpenDesignM1H1A1Claim(claim.claimFileRealpath, {
      ...input, producerRunAttempt: 3,
    })).rejects.toThrow('one-time producer claim')
    await writeFile(claim.claimFileRealpath, 'invalid', { mode: 0o600 })
    await expect(claimOpenDesignM1H1A1Authority(input)).rejects.toThrow('already attempted')
  })
})

async function lstatOwner(path: string) {
  const metadata = await import('node:fs/promises').then(({ lstat }) => lstat(path))
  expect(metadata.nlink).toBe(1)
  if (typeof process.getuid === 'function') expect(metadata.uid).toBe(process.getuid())
  return metadata
}
