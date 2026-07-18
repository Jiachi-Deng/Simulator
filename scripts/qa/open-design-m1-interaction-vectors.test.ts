import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OPEN_DESIGN_M1_CASES } from './open-design-m1-cases'
import {
  OPEN_DESIGN_M1_CASES_V2,
  OPEN_DESIGN_M1_CASE_MANIFEST_V2_SHA256,
  OPEN_DESIGN_M1_INTERACTION_VECTORS,
  OPEN_DESIGN_M1_INTERACTION_VECTORS_CANONICAL_SHA256,
  openDesignM1InteractionVectorSha256,
  renderOpenDesignM1CaseManifestV2,
} from './open-design-m1-interaction-vectors'

const roots: string[] = []
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('OpenDesign M1 fixed-cases/v2 interaction authority', () => {
  it('adds a separately pinned v2 prompt/vector authority without mutating frozen v1 inputs', () => {
    expect(OPEN_DESIGN_M1_CASES_V2).toHaveLength(20)
    expect(OPEN_DESIGN_M1_INTERACTION_VECTORS).toHaveLength(20)
    expect(sha256(JSON.stringify(OPEN_DESIGN_M1_INTERACTION_VECTORS)))
      .toBe(OPEN_DESIGN_M1_INTERACTION_VECTORS_CANONICAL_SHA256)
    expect(sha256(renderOpenDesignM1CaseManifestV2())).toBe(OPEN_DESIGN_M1_CASE_MANIFEST_V2_SHA256)
    for (let index = 0; index < OPEN_DESIGN_M1_CASES.length; index += 1) {
      const v1 = OPEN_DESIGN_M1_CASES[index]!
      const v2 = OPEN_DESIGN_M1_CASES_V2[index]!
      const vector = OPEN_DESIGN_M1_INTERACTION_VECTORS[index]!
      expect(v2.id).toBe(v1.id)
      expect(v2.seedArchiveSha256).toBe(v1.seedArchiveSha256)
      expect(v2.prompt.startsWith(v1.prompt)).toBe(true)
      expect(v2.prompt).toContain('M1 fixed-cases/v2')
      expect(v2.interactionVectorSha256).toBe(openDesignM1InteractionVectorSha256(vector))
      expect(vector.caseId).toBe(v1.id)
    }
  })

  it('contains only semantic hooks and enumerated actions, never arbitrary CSS or JavaScript payloads', () => {
    for (const vector of OPEN_DESIGN_M1_INTERACTION_VECTORS) {
      for (const target of vector.targets) expect(target.semanticId).toMatch(new RegExp(`^${vector.caseId}\\.`))
      for (const capture of vector.captures) {
        expect(Object.keys(capture).some((key) => ['selector', 'script', 'javascript', 'expression'].includes(key))).toBe(false)
      }
      for (const scenario of vector.scenarios) {
        expect(scenario.reset).toBe('clear-origin-storage-and-reload')
        for (const action of scenario.actions) {
          expect(['pointerClick', 'replaceText', 'pressKeys', 'setViewport']).toContain(action.kind)
          expect(Object.keys(action).some((key) => ['selector', 'script', 'javascript', 'expression'].includes(key))).toBe(false)
        }
      }
    }
  })

  it('materializes a standalone owner-only fixed-cases/v2 authority and unchanged seed bytes', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'open-design-m1-v2-'))
    roots.push(parent)
    const output = join(parent, 'fixed-cases-v2')
    const child = Bun.spawn([process.execPath, 'scripts/qa/generate-open-design-m1-case-artifacts-v2.ts', output], {
      cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect(exitCode, stderr).toBe(0)
    const status = JSON.parse(stdout)
    expect(status).toMatchObject({ status: 'ready', authorityVersion: 2, cases: 20 })
    const authority = JSON.parse(await readFile(join(output, 'authority.json'), 'utf8'))
    expect(authority.caseManifestSha256).toBe(OPEN_DESIGN_M1_CASE_MANIFEST_V2_SHA256)
    expect(authority.interactionVectorsSha256).toBe(OPEN_DESIGN_M1_INTERACTION_VECTORS_CANONICAL_SHA256)
    expect(authority.cases.map((value: { seedArchiveSha256: string }) => value.seedArchiveSha256))
      .toEqual(OPEN_DESIGN_M1_CASES.map((value) => value.seedArchiveSha256))
  })
})
