import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const roots: string[] = []
const SESSION_MANAGER_URL = pathToFileURL(join(import.meta.dir, 'SessionManager.ts')).href

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function ownership(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transient: true,
    contractVersion: 2,
    moduleId: 'open-design',
    runHandle: `run_${'1'.repeat(32)}`,
    idempotencyKeyDigest: '2'.repeat(64),
    requestDigest: '3'.repeat(64),
    workerEpoch: 'epoch_1234',
    state: 'running',
    ...overrides,
  }
}

function writeSession(
  workspaceRoot: string,
  sessionId: string,
  moduleAgentRun?: unknown,
): string {
  const sessionDir = join(workspaceRoot, 'sessions', sessionId)
  mkdirSync(sessionDir, { recursive: true })
  const sessionFile = join(sessionDir, 'session.jsonl')
  const header: Record<string, unknown> = {
    id: sessionId,
    workspaceRootPath: workspaceRoot,
    workingDirectory: workspaceRoot,
    hidden: true,
    createdAt: 1,
    lastUsedAt: 2,
    messageCount: 1,
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  }
  if (moduleAgentRun !== undefined) header.moduleAgentRun = moduleAgentRun
  const queued = {
    id: `queued-${sessionId}`,
    type: 'user',
    content: 'must never execute after restart',
    timestamp: 2,
    isQueued: true,
  }
  writeFileSync(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(queued)}\n`)
  return sessionDir
}

describe('transient Module startup quarantine', () => {
  it('reaps valid ownership, physically quarantines malformed claims, and preserves ordinary recovery', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'module-startup-config-'))
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'module-startup-workspace-'))
    roots.push(configDir, workspaceRoot)

    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      workspaces: [{
        id: 'workspace-1',
        name: 'Workspace',
        rootPath: workspaceRoot,
        createdAt: 1,
      }],
      activeWorkspaceId: 'workspace-1',
      activeSessionId: null,
      llmConnections: [],
    }))
    writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({
      id: 'workspace-1',
      name: 'Workspace',
      slug: 'workspace',
      createdAt: 1,
      updatedAt: 1,
    }))

    const validDir = writeSession(workspaceRoot, 'valid-transient', ownership())
    const invalidContractDir = writeSession(
      workspaceRoot,
      'invalid-contract',
      ownership({ contractVersion: 3 }),
    )
    const invalidStateDir = writeSession(
      workspaceRoot,
      'invalid-state',
      ownership({ state: 'resuming' }),
    )
    const missingField = ownership()
    delete missingField.requestDigest
    const missingFieldDir = writeSession(workspaceRoot, 'missing-field', missingField)
    const ordinaryDir = writeSession(workspaceRoot, 'ordinary-session')
    const quarantineRoot = join(workspaceRoot, 'sessions', '.module-agent-quarantine')

    const script = `
      import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
      import { join } from 'node:path';
      import { SessionManager } from ${JSON.stringify(SESSION_MANAGER_URL)};
      const manager = new SessionManager();
      let queuedRecoveries = 0;
      manager.processNextQueuedMessage = () => { queuedRecoveries += 1; };
      await manager.reloadSessions();
      const invalidOpenResults = await Promise.all([
        manager.getSession('invalid-contract'),
        manager.getSession('invalid-state'),
        manager.getSession('missing-field'),
      ]);
      const ordinaryOpen = await manager.getSession('ordinary-session');
      await new Promise((resolve) => setTimeout(resolve, 25));
      const quarantineEntries = existsSync(${JSON.stringify(quarantineRoot)})
        ? readdirSync(${JSON.stringify(quarantineRoot)}).sort()
        : [];
      const manifests = quarantineEntries.map((entry) => JSON.parse(
        readFileSync(join(${JSON.stringify(quarantineRoot)}, entry, 'quarantine.json'), 'utf8'),
      ));
      console.log(JSON.stringify({
        queuedRecoveries,
        exposedSessions: manager.getSessions().map((session) => session.id),
        residue: manager.getModuleAgentSessionResidueSnapshot(),
        validExists: existsSync(${JSON.stringify(validDir)}),
        invalidSourceExists: [
          ${JSON.stringify(invalidContractDir)},
          ${JSON.stringify(invalidStateDir)},
          ${JSON.stringify(missingFieldDir)},
        ].map((path) => existsSync(path)),
        invalidOpenResults: invalidOpenResults.map((session) => session?.id ?? null),
        ordinaryExists: existsSync(${JSON.stringify(ordinaryDir)}),
        ordinaryOpen: ordinaryOpen?.id ?? null,
        quarantineEntries,
        manifests,
        quarantineRootMode: statSync(${JSON.stringify(quarantineRoot)}).mode & 0o777,
        manifestModes: quarantineEntries.map((entry) => (
          statSync(join(${JSON.stringify(quarantineRoot)}, entry, 'quarantine.json')).mode & 0o777
        )),
      }));
      manager.cleanup();
    `
    const result = Bun.spawnSync([process.execPath, '--eval', script], {
      env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.exitCode, result.stderr.toString()).toBe(0)
    const resultLine = result.stdout.toString().split('\n').find((line) => line.startsWith('{'))
    expect(resultLine, result.stdout.toString()).toBeTruthy()
    const output = JSON.parse(resultLine!) as {
      queuedRecoveries: number
      exposedSessions: string[]
      residue: { hiddenSessions: number; transientSessions: number; quarantinedSessions: number }
      validExists: boolean
      invalidSourceExists: boolean[]
      invalidOpenResults: Array<string | null>
      ordinaryExists: boolean
      ordinaryOpen: string | null
      quarantineEntries: string[]
      manifests: Array<{
        schemaVersion: number
        kind: string
        reasonCode: string
        sessionId: string
      }>
      quarantineRootMode: number
      manifestModes: number[]
    }
    expect(output.queuedRecoveries).toBe(1)
    expect(output.exposedSessions).toEqual(['ordinary-session'])
    expect(output.residue).toEqual({
      hiddenSessions: 1,
      transientSessions: 0,
      quarantinedSessions: 3,
    })
    expect(output.validExists).toBe(false)
    expect(output.invalidSourceExists).toEqual([false, false, false])
    expect(output.invalidOpenResults).toEqual([null, null, null])
    expect(output.ordinaryExists).toBe(true)
    expect(output.ordinaryOpen).toBe('ordinary-session')
    expect(output.quarantineEntries).toHaveLength(3)
    if (process.platform !== 'win32') {
      expect(output.quarantineRootMode).toBe(0o700)
      expect(output.manifestModes).toEqual([0o600, 0o600, 0o600])
    }
    expect(output.manifests.map((manifest) => manifest.sessionId).sort()).toEqual([
      'invalid-contract',
      'invalid-state',
      'missing-field',
    ])
    for (const manifest of output.manifests) {
      expect(manifest).toMatchObject({
        schemaVersion: 1,
        kind: 'module-agent-cleanup-debt',
        reasonCode: 'MALFORMED_MODULE_AGENT_RUN',
      })
    }
  })
})
