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

  test('scanner detects bare Craft domains and the former package support address', () => {
    expect([...'https://craft.do'.matchAll(CRAFT_REFERENCE_PATTERN)].map((match) => match[0])).toEqual(['craft.do'])
    expect([...'support@craft.do'.matchAll(CRAFT_REFERENCE_PATTERN)].map((match) => match[0])).toEqual(['support@craft.do'])
  })

  test('current package metadata and desktop artifacts use Simulator ownership', () => {
    const electronPackage = JSON.parse(readFileSync(resolve(repoRoot, 'apps/electron/package.json'), 'utf8'))
    const serverPackage = JSON.parse(readFileSync(resolve(repoRoot, 'packages/server/package.json'), 'utf8'))
    const builderConfig = readFileSync(resolve(repoRoot, 'apps/electron/electron-builder.yml'), 'utf8')
    const dmgScript = readFileSync(resolve(repoRoot, 'apps/electron/scripts/build-dmg.sh'), 'utf8')

    expect(electronPackage.author).toEqual({
      name: 'Simulator contributors',
      url: 'https://github.com/Jiachi-Deng/Simulator',
    })
    expect(serverPackage.author).toEqual(electronPackage.author)
    expect(builderConfig).toContain('copyright: Copyright © 2026 Simulator contributors')
    expect(builderConfig).toContain('maintainer: "Simulator contributors (https://github.com/Jiachi-Deng/Simulator)"')
    expect(builderConfig.match(/artifactName: "Simulator-\$\{arch\}/g)).toHaveLength(4)
    expect(dmgScript).toContain('DMG_NAME="Simulator-${ARCH}.dmg"')
  })
})
