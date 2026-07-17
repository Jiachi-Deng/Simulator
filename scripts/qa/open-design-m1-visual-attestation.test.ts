import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDeterministicMachineEvidenceFixture,
  type MachineEvidenceAuthority,
} from './open-design-m1-machine-evidence'
import { OPEN_DESIGN_M1_CASES } from './open-design-m1-cases'
import { OPEN_DESIGN_RC_SOURCE_SHA } from './open-design-rc-acceptance-evidence'
import {
  OPEN_DESIGN_M1_VISUAL_ARTIFACT_NAME,
  OPEN_DESIGN_M1_VISUAL_FILE_COUNT,
  createOpenDesignM1VisualAttestation,
  validateOpenDesignM1VisualAttestation,
  visualAttestationTestOnly,
  type VisualDecisionInput,
  type VisualProducerAuthority,
} from './open-design-m1-visual-attestation'

const roots: string[] = []
const canonical = (value: unknown): string => `${JSON.stringify(value)}\n`
const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const lkgCatalog = { fixture: 'lkg-catalog' }
const lkgEnvelope = { fixture: 'lkg-envelope' }
const rcCatalog = { fixture: 'rc-catalog' }
const rcEnvelope = { fixture: 'rc-envelope' }

const machineAuthority: MachineEvidenceAuthority = Object.freeze({
  hostHeadSha: '1234567890abcdef1234567890abcdef12345678',
  producerRunId: 9001,
  producerRunAttempt: 1,
  hostBuildRunId: 8001,
  hostArtifactSha256: 'a'.repeat(64),
  lkg: {
    archiveSha256: 'b'.repeat(64),
    catalogIssuedAt: '2026-07-16T22:00:00.000Z',
    catalogSequence: 2,
    catalogSha256: sha(JSON.stringify(lkgCatalog)),
    envelopeSha256: sha(JSON.stringify(lkgEnvelope)),
    expiresAt: '2026-07-18T22:00:00.000Z',
    extractedManifestSha256: 'c'.repeat(64),
  },
  rc: {
    archiveSha256: 'd'.repeat(64),
    catalogIssuedAt: '2026-07-17T00:00:00.000Z',
    catalogSequence: 3,
    catalogSha256: sha(JSON.stringify(rcCatalog)),
    envelopeSha256: sha(JSON.stringify(rcEnvelope)),
    expiresAt: '2026-07-18T22:00:00.000Z',
    extractedManifestSha256: 'e'.repeat(64),
    sourceSha: OPEN_DESIGN_RC_SOURCE_SHA,
  },
})

const authority: VisualProducerAuthority = Object.freeze({
  machineHeadSha: machineAuthority.hostHeadSha,
  machineRunId: machineAuthority.producerRunId,
  machineRunAttempt: 1,
  visualHeadSha: machineAuthority.hostHeadSha,
  visualRunId: 9002,
  visualRunAttempt: 1,
})

function decisions(): VisualDecisionInput[] {
  return OPEN_DESIGN_M1_CASES.map((testCase, index) => ({
    caseId: testCase.id,
    decision: 'PASS',
    reviewedAt: new Date(Date.parse('2026-07-17T02:00:00.000Z') + index * 1_000).toISOString(),
  }))
}

async function fixture(): Promise<{
  parent: string
  machineRoot: string
  decisionsPath: string
  visualRoot: string
}> {
  const parent = await mkdtemp(join(tmpdir(), 'open-design-m1-visual-test-'))
  roots.push(parent)
  const machineRoot = join(parent, 'machine')
  const decisionsPath = join(parent, 'decisions.json')
  const visualRoot = join(parent, 'visual')
  await createDeterministicMachineEvidenceFixture(machineRoot, machineAuthority)
  await writeFile(decisionsPath, canonical(decisions()), { mode: 0o600 })
  return { parent, machineRoot, decisionsPath, visualRoot }
}

async function produce(): Promise<Awaited<ReturnType<typeof fixture>>> {
  const value = await fixture()
  await createOpenDesignM1VisualAttestation(
    value.machineRoot,
    value.decisionsPath,
    value.visualRoot,
    authority,
    '2026-07-17T03:00:00.000Z',
  )
  return value
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('OpenDesign M1 visual attestation producer contract', () => {
  it('creates and validates the exact two-file cross-bound attestation', async () => {
    const value = await produce()
    const result = await validateOpenDesignM1VisualAttestation(value.visualRoot, value.machineRoot, authority)
    expect(result.artifactName).toBe(OPEN_DESIGN_M1_VISUAL_ARTIFACT_NAME)
    expect(result.fileCount).toBe(OPEN_DESIGN_M1_VISUAL_FILE_COUNT)
    expect(result.objectPath).toBe('visual-attestation.json')
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(result.machineManifestSha256).toMatch(/^[0-9a-f]{64}$/)

    const output = JSON.parse(await readFile(join(value.visualRoot, 'visual-attestation.json'), 'utf8'))
    expect(output.decisions).toHaveLength(20)
    expect(output.decisions[0]).toEqual(expect.objectContaining({
      caseId: 'D01',
      decision: 'PASS',
      previewObjectPath: 'previews/new/D01.png',
    }))
    expect(Object.keys(output.machineAuthority).sort()).toEqual([
      'artifactName', 'batchDigest', 'headSha', 'hostArtifactSha256', 'machineManifestSha256',
      'rcArchiveSha256', 'rcCatalogIssuedAt', 'rcCatalogSequence', 'rcSourceSha',
      'runAttempt', 'runId', 'workflowPath',
    ].sort())
  })

  it('rejects unknown fields and machine-reference substitutions after resealing', async () => {
    const unknown = await produce()
    await visualAttestationTestOnly.replaceCanonicalJson(unknown.visualRoot, (value) => {
      value.unknown = true
    })
    await expect(validateOpenDesignM1VisualAttestation(unknown.visualRoot, unknown.machineRoot, authority))
      .rejects.toThrow('invalid: $')

    const substituted = await produce()
    await visualAttestationTestOnly.replaceCanonicalJson(substituted.visualRoot, (value) => {
      const list = value.decisions as Array<Record<string, unknown>>
      list[0].previewSha256 = 'f'.repeat(64)
    })
    await expect(validateOpenDesignM1VisualAttestation(substituted.visualRoot, substituted.machineRoot, authority))
      .rejects.toThrow('does not match machine authority')
  })

  it('rejects reordered, failed, stale, non-canonical, and oversize decision inputs', async () => {
    const reordered = await fixture()
    const reorderedDecisions = decisions()
    ;[reorderedDecisions[0], reorderedDecisions[1]] = [reorderedDecisions[1], reorderedDecisions[0]]
    await writeFile(reordered.decisionsPath, canonical(reorderedDecisions), { mode: 0o600 })
    await expect(createOpenDesignM1VisualAttestation(
      reordered.machineRoot, reordered.decisionsPath, reordered.visualRoot, authority, '2026-07-17T03:00:00.000Z',
    )).rejects.toThrow('$decisions[0].caseId')

    const failed = await fixture()
    const failedDecisions = decisions().map((decision) => ({ ...decision })) as Array<Record<string, unknown>>
    failedDecisions[0].decision = 'FAIL'
    await writeFile(failed.decisionsPath, canonical(failedDecisions), { mode: 0o600 })
    await expect(createOpenDesignM1VisualAttestation(
      failed.machineRoot, failed.decisionsPath, failed.visualRoot, authority, '2026-07-17T03:00:00.000Z',
    )).rejects.toThrow('$decisions[0].decision')

    const stale = await fixture()
    const staleDecisions = decisions()
    staleDecisions[0] = { ...staleDecisions[0], reviewedAt: '2026-07-17T01:00:00.000Z' }
    await writeFile(stale.decisionsPath, canonical(staleDecisions), { mode: 0o600 })
    await expect(createOpenDesignM1VisualAttestation(
      stale.machineRoot, stale.decisionsPath, stale.visualRoot, authority, '2026-07-17T03:00:00.000Z',
    )).rejects.toThrow('$decisions[0].reviewedAt')

    const nonCanonical = await fixture()
    await writeFile(nonCanonical.decisionsPath, `${canonical(decisions())} `, { mode: 0o600 })
    await expect(createOpenDesignM1VisualAttestation(
      nonCanonical.machineRoot, nonCanonical.decisionsPath, nonCanonical.visualRoot, authority, '2026-07-17T03:00:00.000Z',
    )).rejects.toThrow('not canonical compact JSON')

    const oversize = await fixture()
    await writeFile(oversize.decisionsPath, Buffer.alloc(8 * 1024 + 1, 0x20), { mode: 0o600 })
    await expect(createOpenDesignM1VisualAttestation(
      oversize.machineRoot, oversize.decisionsPath, oversize.visualRoot, authority, '2026-07-17T03:00:00.000Z',
    )).rejects.toThrow('violates file constraints')
  })

  it('rejects extra files, symlinks, checksum changes, and producer authority drift', async () => {
    const extra = await produce()
    await writeFile(join(extra.visualRoot, 'extra.json'), '{}\n', { mode: 0o600 })
    await expect(validateOpenDesignM1VisualAttestation(extra.visualRoot, extra.machineRoot, authority))
      .rejects.toThrow('artifact inventory')

    const linked = await produce()
    await rm(join(linked.visualRoot, 'SHA256SUMS'))
    await symlink('visual-attestation.json', join(linked.visualRoot, 'SHA256SUMS'))
    await expect(validateOpenDesignM1VisualAttestation(linked.visualRoot, linked.machineRoot, authority))
      .rejects.toThrow('symlink')

    const changed = await produce()
    await writeFile(join(changed.visualRoot, 'SHA256SUMS'), `${'0'.repeat(64)}  visual-attestation.json\n`, { mode: 0o600 })
    await expect(validateOpenDesignM1VisualAttestation(changed.visualRoot, changed.machineRoot, authority))
      .rejects.toThrow('SHA256SUMS')

    const drifted = await produce()
    await expect(validateOpenDesignM1VisualAttestation(drifted.visualRoot, drifted.machineRoot, {
      ...authority,
      visualHeadSha: '9'.repeat(40),
    })).rejects.toThrow('authority')
  })

  it('runs the offline CLI without network access or caller-supplied authority hashes', async () => {
    const value = await fixture()
    const process = spawnSync('bun', [
      join(import.meta.dir, 'open-design-m1-visual-attestation.ts'),
      'produce',
      '--machine-root', value.machineRoot,
      '--machine-run-id', String(authority.machineRunId),
      '--machine-run-attempt', '1',
      '--machine-head-sha', authority.machineHeadSha,
      '--visual-root', value.visualRoot,
      '--visual-run-id', String(authority.visualRunId),
      '--visual-run-attempt', '1',
      '--visual-head-sha', authority.visualHeadSha,
      '--decisions', value.decisionsPath,
      '--completed-at', '2026-07-17T03:00:00.000Z',
    ], { encoding: 'utf8' })
    expect(process.status, process.stderr).toBe(0)
    const result = JSON.parse(process.stdout)
    expect(result.artifactName).toBe(OPEN_DESIGN_M1_VISUAL_ARTIFACT_NAME)
    expect(await readFile(join(value.visualRoot, 'SHA256SUMS'), 'utf8')).toMatch(/^[0-9a-f]{64}  visual-attestation\.json\n$/)

    const validate = spawnSync('bun', [
      join(import.meta.dir, 'open-design-m1-visual-attestation.ts'),
      'validate',
      '--machine-root', value.machineRoot,
      '--machine-run-id', String(authority.machineRunId),
      '--machine-run-attempt', '1',
      '--machine-head-sha', authority.machineHeadSha,
      '--visual-root', value.visualRoot,
      '--visual-run-id', String(authority.visualRunId),
      '--visual-run-attempt', '1',
      '--visual-head-sha', authority.visualHeadSha,
    ], { encoding: 'utf8' })
    expect(validate.status, validate.stderr).toBe(0)
  })

  it('fails closed on an absent visual artifact directory', async () => {
    const value = await fixture()
    const missing = join(value.parent, 'missing')
    await expect(validateOpenDesignM1VisualAttestation(missing, value.machineRoot, authority)).rejects.toThrow()

    const empty = join(value.parent, 'empty')
    await mkdir(empty, { mode: 0o700 })
    await expect(validateOpenDesignM1VisualAttestation(empty, value.machineRoot, authority))
      .rejects.toThrow('artifact inventory')
  })
})
