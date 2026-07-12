import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  CRAFT_REFERENCE_ALLOWLIST,
  CRAFT_REFERENCE_PATTERN,
  categoryForCraftReference,
  type CraftReference,
} from './branding-craft-reference-allowlist'

const repoRoot = resolve(import.meta.dir, '..')

function trackedFiles(): string[] {
  const result = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: repoRoot })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().split('\0').filter(Boolean)
}

function craftReferences(): CraftReference[] {
  const references: CraftReference[] = []

  for (const path of trackedFiles()) {
    const contents = readFileSync(resolve(repoRoot, path))
    if (contents.includes(0)) continue

    for (const line of contents.toString('utf8').split('\n')) {
      for (const match of line.matchAll(CRAFT_REFERENCE_PATTERN)) {
        references.push({ path, line, value: match[0] })
      }
    }
  }

  return references
}

describe('remaining Craft references', () => {
  const references = craftReferences()

  test('every reference has a documented compatibility or attribution reason', () => {
    const unclassified = references
      .filter((reference) => !categoryForCraftReference(reference))
      .map(({ path, line, value }) => `${path}: ${value} in ${line.trim()}`)

    expect(unclassified).toEqual([])
  })

  test('every allowlist category covers at least one current reference', () => {
    const unused = CRAFT_REFERENCE_ALLOWLIST
      .filter((category) => !references.some((reference) => category.matches(reference)))
      .map((category) => category.id)

    expect(unused).toEqual([])
  })
})
