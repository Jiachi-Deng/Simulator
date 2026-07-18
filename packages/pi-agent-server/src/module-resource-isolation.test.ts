import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModuleResourceIsolation } from './module-resource-isolation.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('transient Module Pi resource isolation', () => {
  it('does not execute cwd or agentDir extensions and loads no ambient resources', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-module-resource-isolation-'))
    roots.push(root)
    const cwd = join(root, 'working-directory')
    const agentDir = join(root, 'agent-directory')
    const projectMarker = join(root, 'project-extension-ran')
    const globalMarker = join(root, 'global-extension-ran')
    mkdirSync(join(cwd, '.pi', 'extensions'), { recursive: true })
    mkdirSync(join(cwd, '.pi', 'skills', 'model-skill'), { recursive: true })
    mkdirSync(join(agentDir, 'extensions'), { recursive: true })
    writeFileSync(
      join(cwd, '.pi', 'extensions', 'project-marker.ts'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(projectMarker)}, 'ran'); export default () => {};`,
    )
    writeFileSync(
      join(agentDir, 'extensions', 'global-marker.ts'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(globalMarker)}, 'ran'); export default () => {};`,
    )
    writeFileSync(
      join(cwd, '.pi', 'skills', 'model-skill', 'SKILL.md'),
      '---\nname: model-skill\ndescription: must stay isolated\n---\n',
    )
    writeFileSync(join(cwd, 'AGENTS.md'), 'untrusted model-authored context')

    const { settingsManager, resourceLoader } = await createModuleResourceIsolation(cwd, agentDir)

    expect(settingsManager?.isProjectTrusted()).toBe(false)
    expect(resourceLoader?.getExtensions().extensions).toEqual([])
    expect(resourceLoader?.getSkills().skills).toEqual([])
    expect(resourceLoader?.getPrompts().prompts).toEqual([])
    expect(resourceLoader?.getThemes().themes).toEqual([])
    expect(resourceLoader?.getAgentsFiles().agentsFiles).toEqual([])
    expect(existsSync(projectMarker)).toBe(false)
    expect(existsSync(globalMarker)).toBe(false)
  })
})
