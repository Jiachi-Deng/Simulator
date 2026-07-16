import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dir, '..', '..', '..')
const scriptPath = join(repositoryRoot, 'apps/electron/scripts/host-module-coordinator-smoke.ts')
const workflowPath = join(repositoryRoot, '.github/workflows/module-coordinator.yml')

async function invoke(arguments_: readonly string[]): Promise<{ exitCode: number; stderr: string }> {
  const child = Bun.spawn([process.execPath, scriptPath, ...arguments_], {
    cwd: repositoryRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ])
  return { exitCode, stderr }
}

describe('Electron packaged Host Agent smoke scenarios', () => {
  it('rejects missing, unknown, invalid, and duplicate scenario arguments before setup', async () => {
    const missing = await invoke([])
    expect(missing.exitCode).not.toBe(0)
    expect(missing.stderr).toContain('--scenario is required')

    const unknown = await invoke(['--not-a-smoke-option', 'value'])
    expect(unknown.exitCode).not.toBe(0)
    expect(unknown.stderr).toContain('Unknown argument')

    const invalid = await invoke(['--scenario', 'stable'])
    expect(invalid.exitCode).not.toBe(0)
    expect(invalid.stderr).toContain('--scenario must be v1-compat or v2-open-design-rc')

    const duplicate = await invoke(['--scenario', 'v1-compat', '--scenario', 'v2-open-design-rc'])
    expect(duplicate.exitCode).not.toBe(0)
    expect(duplicate.stderr).toContain('--scenario may be specified only once')
  })

  it('maps only the exact OpenDesign rollback and RC versions to their fixture entrypoints', async () => {
    const source = await readFile(scriptPath, 'utf8')
    expect(source).toContain("moduleId: 'org.simulator.open-design'")
    expect(source).toContain("version: '0.14.5'")
    expect(source).toContain("contractVersion: 1")
    expect(source).toContain("fixtureEntry: 'module.ts'")
    expect(source).toContain("version: '0.14.6-rc.1'")
    expect(source).toContain("contractVersion: 2")
    expect(source).toContain("fixtureEntry: 'module-v2.ts'")
    expect(source).toContain('deterministic-packaged-protocol-fixture-not-real-rc-or-paid-preview-acceptance')
  })

  it('validates packaged assets and runs v1 then v2 against the same app', async () => {
    const workflow = Bun.YAML.parse(await readFile(workflowPath, 'utf8')) as Record<string, any>
    const job = workflow.jobs['module-coordinator-electron-packaged-smoke']
    const validationIndex = job.steps.findIndex((step: Record<string, unknown>) => (
      step.name === 'Validate exact packaged Host Agent resources'
    ))
    const v1Index = job.steps.findIndex((step: Record<string, unknown>) => (
      step.name === 'Run packaged v1 OpenDesign Compatibility protocol fixture'
    ))
    const v2Index = job.steps.findIndex((step: Record<string, unknown>) => (
      step.name === 'Run packaged v2 OpenDesign ordinary Shim protocol fixture'
    ))
    expect(validationIndex).toBeGreaterThan(-1)
    expect(v1Index).toBeGreaterThan(validationIndex)
    expect(v2Index).toBeGreaterThan(v1Index)
    const validation = job.steps[validationIndex]
    expect(validation.run).toContain('bun scripts/validate-assets.ts --packaged-app "$app_path"')
    expect(validation.run).toContain('PACKAGED_SIMULATOR_APP=$app_path')
    const v1 = job.steps[v1Index]
    const v2 = job.steps[v2Index]
    expect(v1.run).toContain('--scenario v1-compat')
    expect(v2.run).toContain('--scenario v2-open-design-rc')
    expect(v1.run).toContain('$PACKAGED_SIMULATOR_APP')
    expect(v2.run).toContain('$PACKAGED_SIMULATOR_APP')
  })
})
