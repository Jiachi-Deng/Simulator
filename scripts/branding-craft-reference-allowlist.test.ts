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

  test('M1 runtime terminology remains scoped to the Host Agent implementation', () => {
    expect(categoryForCraftReference({
      path: 'packages/host-agent-run-core/src/run-core.ts',
      line: 'A visible Craft turn has priority.',
      value: 'Craft',
    })?.id).toBe('m1-host-agent-craft-runtime-terminology')
    expect(categoryForCraftReference({
      path: 'apps/electron/src/renderer/components/UnrelatedProductCopy.tsx',
      line: 'Welcome to Craft',
      value: 'Craft',
    })).toBeUndefined()

    const smokePath = 'apps/electron/src/main/host-module-coordinator-smoke.ts'
    for (const line of [
      'throw new Error(`Visible Craft Host identity changed during ${phase}`)',
      'await smoke.sessionManager.sendMessage(session.id, `Visible Craft independence marker: ${marker}`)',
      'throw new Error(`Visible Craft Turn did not complete exactly once for ${marker}`)',
    ]) {
      expect(categoryForCraftReference({ path: smokePath, line, value: 'Craft' })?.id)
        .toBe('m1-host-agent-craft-runtime-terminology')
    }
    expect(categoryForCraftReference({
      path: smokePath,
      line: 'Visible Craft acceptance copy for an unrelated fourth assertion',
      value: 'Craft',
    })).toBeUndefined()

    expect(categoryForCraftReference({
      path: 'scripts/qa/run-open-design-m1-machine-evidence.ts',
      line: "throw new Error('Craft main PID exited')",
      value: 'Craft',
    })?.id).toBe('m1-host-agent-craft-runtime-terminology')
    expect(categoryForCraftReference({
      path: 'scripts/qa/unrelated-product-copy.ts',
      line: 'Welcome to Craft',
      value: 'Craft',
    })).toBeUndefined()

    expect(categoryForCraftReference({
      path: 'docs/module-architecture.md',
      line: '### Craft priority 与失败结果',
      value: 'Craft',
    })?.id).toBe('m1-host-agent-architecture-craft-runtime-terminology')
    expect(categoryForCraftReference({
      path: 'docs/module-architecture.md',
      line: 'Welcome to Craft',
      value: 'Craft',
    })).toBeUndefined()
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
    expect(builderConfig).toContain('copyright: Copyright © 2026 Craft Docs Ltd. and Simulator contributors')
    expect(builderConfig).not.toContain('maintainer:')
    expect(builderConfig.match(/artifactName: "Simulator-\$\{arch\}/g)).toHaveLength(4)
    expect(dmgScript).toContain('DMG_NAME="Simulator-${ARCH}.dmg"')
  })
})
