import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

const path = '.github/workflows/open-design-m1-machine-evidence.yml'
const source = readFileSync(path, 'utf8')
const runnerSource = readFileSync('scripts/qa/run-open-design-m1-machine-evidence.ts', 'utf8')
const workflow = parse(source) as Record<string, any>
const dispatch = workflow.on.workflow_dispatch
const job = workflow.jobs['produce-machine-evidence']

describe('OpenDesign M1 machine evidence workflow', () => {
  it('has exactly three non-evidence workflow inputs', () => {
    expect(Object.keys(dispatch.inputs).sort()).toEqual([
      'acceptance_confirmation', 'host_build_run_id', 'paid_turns_approved',
    ])
    expect(source).not.toContain('records_base64')
    expect(source).not.toContain('evidence_bundle_base64')
    expect(source).not.toContain('result_path')
  })

  it('is fixed to the protected Apple Silicon self-hosted runner and Environment', () => {
    expect(job['runs-on']).toEqual(['self-hosted', 'macOS', 'ARM64', 'simulator-open-design-m1'])
    expect(job.environment.name).toBe('open-design-m1-machine-evidence')
    expect(job.if).toContain("vars.OPEN_DESIGN_M1_MACHINE_EVIDENCE_ENABLED == 'true'")
    expect(job.if).toContain('github.run_attempt == 1')
    expect(job.if).toContain('inputs.paid_turns_approved == true')
    expect(source).toContain('persist-credentials: false')
    expect(source).toContain('bun install --frozen-lockfile --ignore-scripts')
  })

  it('runs only the direct real producer and seals the exact artifact', () => {
    expect(source).toContain('SIMULATOR_M1_MACHINE_REAL: packaged-open-design-direct-observation')
    expect(source).toContain('bun scripts/qa/run-open-design-m1-machine-evidence.ts')
    expect(source).toContain('test "$(jq -er .fileCount')
    expect(source).toContain('= 150')
    expect(source).toContain('name: open-design-m1-machine-evidence')
    expect(source).not.toContain('--fixture')
  })

  it('downloads the raw Host artifact by ID and safely extracts its exact Engineering RC closure', () => {
    expect(source).toContain('actions/artifacts/$HOST_ARTIFACT_ID/zip')
    expect(source).not.toContain('gh run download')
    expect(source).toContain('with zipfile.ZipFile(archive) as source:')
    expect(source).toContain('name in seen')
    expect(source).toContain('stat.S_ISLNK(mode)')
    expect(source).toContain('info.flag_bits & 1')
    expect(source).toContain('info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)')
    expect(source).toContain('extracted != expected_files')
    expect(source).toContain('Host artifact checksum mismatch')
    for (const expected of [
      'Simulator-arm64.dmg', 'Simulator-arm64.zip', 'app-inventory.jsonl',
      'attestations/provenance.sigstore.json', 'attestations/sbom.sigstore.json',
      'bundle-metadata.json', 'dmg-app-inventory.raw.jsonl', 'dmg-signatures.json',
      'package-verification-code.txt', 'packaged-files.sha256', 'rc-validation.json',
      'sbom.spdx.json', 'transport-normalization-policy.json', 'verification-input.json',
      'zip-app-inventory.raw.jsonl', 'zip-signatures.json', 'RELEASE_NOTES.md', 'SHA256SUMS',
    ]) expect(source).toContain(`"${expected}"`)
  })

  it('authenticates exact main Host build and preserves the paid failure-stop boundary', () => {
    expect(source).toContain('test "$(jq -r .head_sha <<<"$host_run")" = "$GITHUB_SHA"')
    expect(source).toContain('test "$(jq -r .path <<<"$host_run")" = ".github/workflows/engineering-rc.yml"')
    expect(source).toContain('test "$(jq -r .run_attempt <<<"$host_run")" = "1"')
    expect(source).toContain('RUN_OPEN_DESIGN_M1_40_PAID_TURNS_STOP_ON_FIRST_FAILURE')
    expect(source).toContain('test "$GITHUB_RUN_ATTEMPT" = "1"')
    expect(runnerSource).toContain('(run.run_attempt as number) > 0')
    expect(runnerSource).not.toContain('run.run_attempt === 1')
  })

  it('requires real external Host Agent SSE interposition before any paid Turn', () => {
    expect(runnerSource).toContain("producer !== 'external-host-agent-sse-proxy'")
    expect(runnerSource).toContain("rendererCall('openDesignAcceptance', 'getBlackoutProxyCapability')")
    expect(runnerSource).toContain("rendererCall('openDesignAcceptance', 'armNextBlackout',")
    expect(runnerSource).toContain("rendererCall('openDesignAcceptance', 'takeBlackoutEvidence'")
    expect(runnerSource).toContain("waitFor('terminal Host blackout evidence'")
    expect(runnerSource).not.toContain('fetch(`${origin}/health`')
    expect(runnerSource.indexOf('await requireExternalBlackoutProxy(craftCdp)'))
      .toBeLessThan(runnerSource.indexOf("stack: 'old'"))
    expect(runnerSource.indexOf('await requireAuthenticatedCraftRuntime(craftCdp)'))
      .toBeLessThan(runnerSource.indexOf("stack: 'old'"))
    expect(runnerSource.indexOf('await requireRuntimeCleanup(craftCdp, 1_000)'))
      .toBeLessThan(runnerSource.indexOf("stack: 'old'"))
    expect(runnerSource).toContain('await requireOpenDesignHostRuntime(origin)')
    expect(runnerSource).toContain("rendererCall('openDesignAcceptance', 'getModuleAgentRuntimeSnapshot')")
    expect(runnerSource).not.toContain('activeRuns: 0, hiddenSessions: craft.hiddenSessions, moduleSessions: 0')
    expect(source).toContain('proxy_bun=$(realpath "$(command -v bun)")')
    expect(source).toContain('proxy_script=$(realpath scripts/qa/run-host-agent-blackout-proxy.ts)')
    expect(source).toContain('(( (8#$mode & 8#022) == 0 ))')
    expect(runnerSource.indexOf('await preflightExternalBlackoutProxyChild(blackoutProxyChild, staging)'))
      .toBeLessThan(runnerSource.indexOf('let app = await appLaunch(executable, userData, blackoutProxyChild)'))
    const main = runnerSource.slice(runnerSource.indexOf('async function main()'))
    expect(main.indexOf('await preflightRealPackagedV2ProxyAttach({'))
      .toBeLessThan(main.indexOf('await runFixedPaidTurnBatch('))
    const realAttach = runnerSource.slice(
      runnerSource.indexOf('async function preflightRealPackagedV2ProxyAttach'),
      runnerSource.indexOf('async function requireProcessTreeReaped'),
    )
    expect(realAttach).toContain("await armExternalBlackoutProxy(options.craftCdp, 'D01', 1)")
    expect(realAttach).toContain("waitFor('real packaged v2 blackout proxy process attach'")
    expect(realAttach).toContain("waitFor('real packaged v2 blackout proxy cleanup'")
    expect(realAttach).toContain('await requireRuntimeCleanup(options.craftCdp, 5_000)')
    expect(realAttach).toContain('await requirePaidTurnRuntimeBaseline(options.craftCdp)')
    expect(realAttach).not.toContain('startRun(')
  })

  it('does not pass Actions credentials or runner metadata into packaged Simulator', () => {
    const launch = runnerSource.slice(
      runnerSource.indexOf('async function appLaunch'),
      runnerSource.indexOf('async function stopApp'),
    )
    expect(launch).not.toContain('...process.env')
    for (const forbidden of ['GH_TOKEN', 'GITHUB_TOKEN', 'ACTIONS_', 'RUNNER_']) {
      expect(launch).not.toContain(forbidden)
    }
    expect(launch).toContain("['HOME', 'PATH', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING']")
    expect(launch).toContain("environment.SIMULATOR_HOST_MODULE_ACCEPTANCE = '1'")
    expect(launch).toContain('environment.SIMULATOR_HOST_AGENT_BLACKOUT_PROXY_BUN_PATH = blackoutProxyChild.bunPath')
    expect(launch).toContain('environment.SIMULATOR_HOST_AGENT_BLACKOUT_PROXY_SCRIPT_PATH = blackoutProxyChild.scriptPath')
  })

  it('observes cleanup and the full packaged App descendant process tree', () => {
    expect(runnerSource).toContain('snapshot.v1.activeRuns + snapshot.v2.activeRuns')
    expect(runnerSource).toContain('snapshot.v1.moduleSessions + snapshot.v2.moduleSessions')
    expect(runnerSource).toContain('snapshot.sessions.hiddenSessions === 0')
    expect(runnerSource).toContain('snapshot.sessions.transientSessions === 0')
    expect(runnerSource).toContain('snapshot.sessions.quarantinedSessions === 0')
    expect(runnerSource).not.toContain('moduleAgentRun')
    expect(runnerSource).not.toContain('window.electronAPI.getSessions()')
    expect(runnerSource).toContain('await descendantProcessSnapshot(app.pid)')
    expect(runnerSource).toContain('await requireProcessTreeReaped(finalProcessTree)')
    expect(runnerSource).toContain('await residualOwnedModuleProcessCount(userData, blackoutProxyChild.scriptPath)')
    expect(runnerSource).toContain("spawn('/bin/ps', ['-axo', 'pid=,ppid=,command=']")
  })

  it('captures the actual Preview URL in a temporary CDP target and closes every HTTP body', () => {
    expect(runnerSource).toContain('`${cdpOrigin}/json/new?${encodeURIComponent(canonicalUrl)}`')
    expect(runnerSource).toContain('`${cdpOrigin}/json/close/${encodeURIComponent(id)}`')
    expect(runnerSource).toContain("(state as JsonObject).href === canonicalUrl")
    expect(runnerSource).toContain('await response.body?.cancel()')
    expect(runnerSource).not.toContain('options.moduleCdp.screenshot()')
  })
})
