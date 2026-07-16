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
  moduleAgentRun: Record<string, unknown>,
): string {
  const sessionDir = join(workspaceRoot, 'sessions', sessionId)
  mkdirSync(sessionDir, { recursive: true })
  const sessionFile = join(sessionDir, 'session.jsonl')
  const header = {
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
    moduleAgentRun,
  }
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
  it('reaps valid ownership before ready and preserves invalid ownership without queued recovery', () => {
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
    const invalidDir = writeSession(workspaceRoot, 'invalid-transient', ownership({ unexpected: true }))

    const script = `
      import { existsSync } from 'node:fs';
      import { SessionManager } from ${JSON.stringify(SESSION_MANAGER_URL)};
      const manager = new SessionManager();
      let queuedRecoveries = 0;
      manager.processNextQueuedMessage = () => { queuedRecoveries += 1; };
      await manager.reloadSessions();
      await new Promise((resolve) => setTimeout(resolve, 25));
      console.log(JSON.stringify({
        queuedRecoveries,
        exposedSessions: manager.getSessions().map((session) => session.id),
        validExists: existsSync(${JSON.stringify(validDir)}),
        invalidExists: existsSync(${JSON.stringify(invalidDir)}),
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
      validExists: boolean
      invalidExists: boolean
    }
    expect(output).toEqual({
      queuedRecoveries: 0,
      exposedSessions: [],
      validExists: false,
      invalidExists: true,
    })
    expect(existsSync(invalidDir)).toBe(true)
  })
})
