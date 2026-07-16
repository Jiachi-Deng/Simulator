import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OPEN_DESIGN_M1_CASES, createOpenDesignM1SeedArchive } from './open-design-m1-cases'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('OpenDesign M1 fixed A/B case set', () => {
  it('locks exactly four cases in each approved product group', () => {
    expect(OPEN_DESIGN_M1_CASES).toHaveLength(20)
    expect(new Set(OPEN_DESIGN_M1_CASES.map((testCase) => testCase.id)).size).toBe(20)
    expect(new Set(OPEN_DESIGN_M1_CASES.map((testCase) => testCase.prompt)).size).toBe(20)
    for (const group of ['dashboard', 'landing', 'editor', 'settings', 'follow-up']) {
      expect(OPEN_DESIGN_M1_CASES.filter((testCase) => testCase.group === group), group).toHaveLength(4)
    }
  })

  it('requires deterministic files, content markers, Preview, and human visual assertions', () => {
    for (const testCase of OPEN_DESIGN_M1_CASES) {
      expect(testCase.seedArchiveSha256, testCase.id).toMatch(/^[0-9a-f]{64}$/)
      expect(testCase.previewRoute, testCase.id).toBe('/')
      expect(testCase.requiredFiles, testCase.id).toEqual([
        'index.html', 'src/main.js', 'src/styles.css', `evidence/${testCase.id}.json`,
      ])
      expect(testCase.requiredContent.map((entry) => entry.path), testCase.id).toEqual([...testCase.requiredFiles])
      for (const content of testCase.requiredContent) expect(testCase.prompt, testCase.id).toContain(content.marker)
      expect(testCase.prompt, testCase.id).toContain('Preview')
      expect(testCase.visualAssertion.length, testCase.id).toBeGreaterThan(20)
    }
  })

  it('reproduces every locked seed archive byte-for-byte', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-design-m1-cases-'))
    roots.push(root)
    for (const testCase of OPEN_DESIGN_M1_CASES) {
      const digest = await createOpenDesignM1SeedArchive(testCase, join(root, `${testCase.id}.tar.gz`))
      expect(digest, testCase.id).toBe(testCase.seedArchiveSha256)
    }
  })
})
