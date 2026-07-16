import { describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { publicWrapperFailure } from './host-module-smoke-public-failure'

const repositoryRoot = resolve(import.meta.dir, '..', '..', '..')
const scriptPath = join(repositoryRoot, 'apps/electron/scripts/host-module-coordinator-smoke.ts')
const mainSmokePath = join(repositoryRoot, 'apps/electron/src/main/host-module-coordinator-smoke.ts')
const v2FixturePath = join(
  repositoryRoot,
  'packages/module-coordinator/fixtures/packaged-fake-module/bin/module-v2.ts',
)
const workflowPath = join(repositoryRoot, '.github/workflows/module-coordinator.yml')

async function invoke(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<{ exitCode: number; stderr: string }> {
  const child = Bun.spawn([process.execPath, scriptPath, ...arguments_], {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ])
  return { exitCode, stderr }
}

async function compileExecutable(root: string, name: string, sourceText: string): Promise<string> {
  const source = join(root, `${name}.ts`)
  const executable = join(root, process.platform === 'win32' ? `${name}.exe` : name)
  await writeFile(source, sourceText)
  const build = Bun.spawnSync([
    process.execPath,
    'build',
    '--compile',
    source,
    '--outfile',
    executable,
  ], { stdout: 'ignore', stderr: 'ignore' })
  if (build.exitCode !== 0) throw new Error('watchdog fixture compilation failed')
  if (process.platform !== 'win32') await chmod(executable, 0o700)
  return executable
}

function processOrGroupExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

describe('Electron packaged Host Agent smoke scenarios', () => {
  it('publishes only fixed wrapper codes and byte/status detail keys', () => {
    const known = new Error('SMOKE_CHILD_FAILED status=64 phase=90 resultBytes=12 stdoutBytes=3 stderrBytes=9')
    expect(publicWrapperFailure(known)).toBe(known.message)

    expect(publicWrapperFailure(new Error('RAW_SECRET_MARKER'))).toBe('SMOKE_INTERNAL_ERROR')
    expect(publicWrapperFailure(new Error('SMOKE_CHILD_FAILED internalToken=123'))).toBe('SMOKE_INTERNAL_ERROR')
    expect(publicWrapperFailure(new Error('SMOKE_CHILD_FAILED INTERNAL_TOKEN=123'))).toBe('SMOKE_INTERNAL_ERROR')
    expect(publicWrapperFailure(new Error('SMOKE_CHILD_FAILED phase=worker-recovery'))).toBe('SMOKE_INTERNAL_ERROR')
    expect(publicWrapperFailure(new Error('SMOKE_CHILD_FAILED phase=91'))).toBe('SMOKE_INTERNAL_ERROR')
    expect(publicWrapperFailure(new Error('SMOKE_CHILD_FAILED phase=90 phase=90'))).toBe('SMOKE_INTERNAL_ERROR')
  })

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

  it('force-reaps a SIGTERM-resistant child and only its collected detached provider group', async () => {
    if (process.platform === 'win32') return
    const root = await realpath(await mkdtemp(join(tmpdir(), 'simulator-smoke-watchdog-')))
    try {
      const evidencePath = join(root, 'provider-pgid.txt')
      const provider = await compileExecutable(root, 'detached-provider', [
        "process.on('SIGTERM', () => undefined)",
        'setInterval(() => undefined, 1_000)',
      ].join('\n'))
      const fakeApp = await compileExecutable(root, 'fake-app', [
        "import { writeFileSync } from 'node:fs'",
        `const provider = Bun.spawn([${JSON.stringify(provider)}], { detached: true, stdout: 'ignore', stderr: 'ignore' })`,
        "const resultPath = process.argv.find((value) => value.startsWith('--host-module-smoke-result='))?.split('=', 2)[1]",
        "if (!resultPath) process.exit(65)",
        `writeFileSync(${JSON.stringify(evidencePath)}, String(provider.pid))`,
        "writeFileSync(resultPath, JSON.stringify({ ok: false, secret: 'RAW_RESULT_SECRET_MARKER', smokeOwnedProcessGroups: [provider.pid] }))",
        "process.stdout.write('RAW_STDOUT_SECRET_MARKER')",
        "process.stderr.write('RAW_STDERR_SECRET_MARKER')",
        "process.on('SIGTERM', () => undefined)",
        'setInterval(() => undefined, 1_000)',
      ].join('\n'))

      const result = await invoke([
        '--app', fakeApp,
        '--scenario', 'v2-open-design-rc',
      ], {
        SIMULATOR_HOST_MODULE_ACCEPTANCE_TEST: '1',
        // Leave enough launch headroom for loaded CI runners; this fixture is
        // testing TERM -> KILL ownership, not executable startup latency.
        SIMULATOR_HOST_MODULE_ACCEPTANCE_OUTER_TIMEOUT_MS: '5000',
        SIMULATOR_HOST_MODULE_ACCEPTANCE_GRACE_MS: '100',
        SIMULATOR_HOST_MODULE_ACCEPTANCE_FORCE_WAIT_MS: '500',
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('SMOKE_CHILD_TIMEOUT')
      expect(result.stderr).toContain('stdoutBytes=')
      expect(result.stderr).toContain('stderrBytes=')
      expect(result.stderr).not.toContain('RAW_STDOUT_SECRET_MARKER')
      expect(result.stderr).not.toContain('RAW_STDERR_SECRET_MARKER')
      expect(result.stderr).not.toContain('RAW_RESULT_SECRET_MARKER')
      expect(result.stderr).not.toContain(root)

      const providerPgid = Number(await readFile(evidencePath, 'utf8'))
      expect(Number.isSafeInteger(providerPgid)).toBe(true)
      const deadline = Date.now() + 2_000
      while ((processOrGroupExists(providerPgid) || processOrGroupExists(-providerPgid)) && Date.now() < deadline) {
        await Bun.sleep(25)
      }
      expect(processOrGroupExists(providerPgid)).toBe(false)
      expect(processOrGroupExists(-providerPgid)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 12_000)

  it('maps only the exact OpenDesign rollback and RC versions to their fixture entrypoints', async () => {
    const source = await readFile(scriptPath, 'utf8')
    const mainSource = await readFile(mainSmokePath, 'utf8')
    const v2FixtureSource = await readFile(v2FixturePath, 'utf8')
    expect(source).toContain("moduleId: 'org.simulator.open-design'")
    expect(source).toContain("version: '0.14.5'")
    expect(source).toContain("contractVersion: 1")
    expect(source).toContain("fixtureEntry: 'module.ts'")
    expect(source).toContain("version: '0.14.6-rc.1'")
    expect(source).toContain("contractVersion: 2")
    expect(source).toContain("fixtureEntry: 'module-v2.ts'")
    expect(source).toContain('deterministic-packaged-protocol-fixture-not-real-rc-or-paid-preview-acceptance')
    expect(source).toContain('result.workerCrashRecovered !== true')
    expect(source).toContain('hostAgentRuntime.workerEpochRotated !== true')
    expect(source).toContain('hostAgentRuntime.zeroHiddenSessions !== true')
    expect(source).toContain('waitForProcessesToExit(observedPids as number[], 10_000)')
    expect(source).toContain('waitForProcessGroupsToExit(providerProcessGroups as number[], 10_000)')
    expect(source).toContain("'craft-before-module'")
    expect(source).toContain("'craft-after-worker-recovery'")
    expect(source).toContain("'craft-after-daemon-recovery'")
    expect(mainSource).toContain("runVisibleCraftTurn('craft-before-module')")
    expect(mainSource).toContain("runVisibleCraftTurn('craft-after-worker-recovery')")
    expect(mainSource).toContain("runVisibleCraftTurn('craft-after-daemon-recovery')")
    expect(mainSource).toContain('await assertOldBearerRejected(')
    expect(mainSource).toContain('await waitForCleanJourneySnapshot(')
    expect(mainSource).toContain('return waitForAcceptedValue({')
    expect(mainSource).toContain('watchdog.assertMayCommitSuccess()')
    expect(mainSource).toContain("errorCode: 'SMOKE_TIMEOUT'")
    expect(mainSource).toContain('sessionPersistenceVerified')
    expect(mainSource).not.toContain('        sessionPath,')
    expect(mainSource).toContain("execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,comm=']")
    expect(mainSource).toContain("'module-provider-root'")
    expect(mainSource).toContain('sameProcessLostItsExecutableName')
    expect(v2FixtureSource).toContain('const SAFE_SHIM_DIAGNOSTIC_CODES = new Set([')
    expect(v2FixtureSource).toContain(
      "return code && SAFE_SHIM_DIAGNOSTIC_CODES.has(code) ? code : 'INTERNAL_ERROR'",
    )
    expect(v2FixtureSource).toContain('failure: publicFailure(error)')
    expect(v2FixtureSource).toContain("fail(publicShimDiagnostic(stderr), { bytes: stderr.byteLength, status: exitCode })")
    expect(v2FixtureSource).not.toContain('String(error)')
    expect(v2FixtureSource).not.toContain('  tokenFile: hostAgentTokenFile,\n}))')
    expect(source).toContain('OUTER_WATCHDOG_TIMEOUT_MS = INNER_WATCHDOG_TIMEOUT_MS')
    expect(source).toContain("child.kill('SIGTERM')")
    expect(source).toContain("child.kill('SIGKILL')")
    expect(source).toContain('collectedSmokeOwnedProcessGroups(resultPath)')
    expect(source).not.toContain('new Response(child.stdout).text()')
    expect(source).not.toContain('new Response(child.stderr).text()')
  })

  it('validates packaged assets and runs v1 then v2 against the same app', async () => {
    const workflow = Bun.YAML.parse(await readFile(workflowPath, 'utf8')) as Record<string, any>
    const publicFailurePath = 'apps/electron/scripts/host-module-smoke-public-failure.ts'
    expect(workflow.on.pull_request.paths).toContain(publicFailurePath)
    expect(workflow.on.push.paths).toContain(publicFailurePath)
    const requiredIsolationPaths = [
      'packages/server-core/src/handlers/session-manager-interface.ts',
      'packages/server-core/src/sessions/**',
      'packages/shared/src/sessions/**',
      'packages/shared/tests/persistence-queue.test.ts',
      'packages/shared/src/agent/backend/types.ts',
      'packages/shared/src/agent/claude-agent.ts',
      'packages/shared/src/agent/__tests__/claude-agent-module-process-lifecycle.test.ts',
      'packages/shared/src/agent/pi-agent.ts',
      'packages/shared/src/agent/core/pre-tool-use.ts',
      'packages/shared/src/agent/module-agent-tool-boundary.ts',
      'packages/shared/src/agent/__tests__/module-agent-tool-boundary.test.ts',
      'packages/shared/src/agent/provider-process-reaper.ts',
      'packages/shared/src/agent/provider-process-reaper.test.ts',
      'packages/shared/src/agent/index.ts',
      'packages/pi-agent-server/src/file-tool-path-input.ts',
      'packages/pi-agent-server/src/file-tool-path-input.test.ts',
      'packages/pi-agent-server/src/index.ts',
      'apps/electron/src/main/module-agent-worker-recovery.ts',
      'apps/electron/src/main/module-agent-worker-recovery.test.ts',
      'apps/electron/src/main/host-module-smoke-deadline.ts',
      'apps/electron/src/main/host-module-smoke-deadline.test.ts',
    ]
    for (const path of requiredIsolationPaths) {
      expect(workflow.on.pull_request.paths).toContain(path)
      expect(workflow.on.push.paths).toContain(path)
    }
    const job = workflow.jobs['module-coordinator-electron-packaged-smoke']
    const isolationIndex = job.steps.findIndex((step: Record<string, unknown>) => (
      step.name === 'Validate Host Agent Session isolation seams'
    ))
    const shimIndex = job.steps.findIndex((step: Record<string, unknown>) => (
      step.name === 'Validate Host-owned zero-argument Shim launcher'
    ))
    const runCoreIndex = job.steps.findIndex((step: Record<string, unknown>) => (
      step.name === 'Validate Host Agent Run Core closure'
    ))
    const validationIndex = job.steps.findIndex((step: Record<string, unknown>) => (
      step.name === 'Validate exact packaged Host Agent resources'
    ))
    const v1Index = job.steps.findIndex((step: Record<string, unknown>) => (
      step.name === 'Run packaged v1 OpenDesign Compatibility protocol fixture'
    ))
    const v2Index = job.steps.findIndex((step: Record<string, unknown>) => (
      step.name === 'Run packaged v2 OpenDesign ordinary Shim protocol fixture'
    ))
    expect(isolationIndex).toBeGreaterThan(-1)
    expect(runCoreIndex).toBeGreaterThan(isolationIndex)
    expect(shimIndex).toBeGreaterThan(runCoreIndex)
    expect(validationIndex).toBeGreaterThan(shimIndex)
    expect(v1Index).toBeGreaterThan(validationIndex)
    expect(v2Index).toBeGreaterThan(v1Index)
    const validation = job.steps[validationIndex]
    const isolation = job.steps[isolationIndex]
    const shim = job.steps[shimIndex]
    expect(isolation.run).toContain('packages/server-core/src/sessions/module-agent-admission.test.ts')
    expect(isolation.run).toContain('packages/server-core/src/sessions/create-managed-session.test.ts')
    expect(isolation.run).toContain('packages/server-core/src/sessions/claude-disposal-containment.test.ts')
    expect(isolation.run).toContain('packages/server-core/src/sessions/module-agent-adapter.test.ts')
    expect(isolation.run).toContain('packages/server-core/src/sessions/transient-module-startup.test.ts')
    expect(isolation.run).toContain('packages/server-core/src/sessions/transient-session-reap.test.ts')
    expect(isolation.run).toContain('packages/server-core/src/sessions/visible-craft-turn-gate.test.ts')
    expect(isolation.run).toContain('packages/server-core/src/sessions/visible-craft-turn-priority.test.ts')
    expect(isolation.run).toContain('packages/shared/tests/persistence-queue.test.ts')
    expect(isolation.run).toContain('packages/shared/src/sessions/__tests__/module-agent-run.test.ts')
    expect(isolation.run).toContain('packages/shared/src/sessions/__tests__/bundle.test.ts')
    expect(isolation.run).toContain('packages/shared/src/agent/__tests__/claude-agent-module-process-lifecycle.test.ts')
    expect(isolation.run).toContain('packages/shared/src/agent/__tests__/module-agent-tool-boundary.test.ts')
    expect(isolation.run).toContain('packages/shared/src/agent/provider-process-reaper.test.ts')
    expect(isolation.run).toContain('packages/pi-agent-server/src/file-tool-path-input.test.ts')
    expect(isolation.run).toContain('apps/electron/src/main/module-agent-runtime.test.ts')
    expect(isolation.run).toContain('apps/electron/src/main/module-agent-worker-recovery.test.ts')
    expect(isolation.run).toContain('apps/electron/src/main/host-module-smoke-deadline.test.ts')
    expect(job.steps[runCoreIndex].run).toBe('bun run validate:host-agent-run-core')
    expect(shim.run).toContain('bun run validate:host-agent-shim')
    expect(shim.run).toContain('apps/electron/src/host-agent/__tests__/resource-integrity.test.ts')
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
