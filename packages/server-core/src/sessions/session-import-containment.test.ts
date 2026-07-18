import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const roots: string[] = []
const SESSION_MANAGER_URL = pathToFileURL(join(import.meta.dir, 'SessionManager.ts')).href

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('renderer Session import containment', () => {
  it('rejects alias/collision/protected storage and cannot mint an invisible Session', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'session-import-config-'))
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'session-import-workspace-'))
    roots.push(configDir, workspaceRoot)
    const workspace = {
      id: 'workspace-import-containment',
      name: 'Import Containment',
      rootPath: workspaceRoot,
      createdAt: 1,
    }
    writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({
      ...workspace,
      slug: workspace.id,
      updatedAt: 1,
    }))
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
      activeSessionId: null,
      llmConnections: [],
    }))
    writeFileSync(join(configDir, 'config-defaults.json'), JSON.stringify({
      version: 'test',
      description: 'session import containment defaults',
      defaults: {
        notificationsEnabled: false,
        colorTheme: 'default',
        autoCapitalisation: true,
        sendMessageKey: 'enter',
        spellCheck: false,
        keepAwakeWhileRunning: false,
        richToolDescriptions: true,
      },
      workspaceDefaults: {
        thinkingLevel: 'off',
        permissionMode: 'ask',
        cyclablePermissionModes: ['safe', 'ask', 'allow-all'],
        localMcpServers: { enabled: true },
      },
    }))

    const script = `
      import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { createSession as createStoredSession } from '@craft-agent/shared/sessions';
      import { SessionManager, createManagedSession } from ${JSON.stringify(SESSION_MANAGER_URL)};

      const workspace = ${JSON.stringify(workspace)};
      const manager = new SessionManager();
      const ownership = {
        transient: true,
        contractVersion: 2,
        moduleId: 'org.simulator.open-design',
        runHandle: 'run_' + '1'.repeat(32),
        idempotencyKeyDigest: '2'.repeat(64),
        requestDigest: '3'.repeat(64),
        workerEpoch: 'epoch_import_containment',
        state: 'accepted',
      };
      const protectedStored = await createStoredSession(workspace.rootPath, {
        name: 'Protected Module',
        hidden: true,
        moduleAgentRun: ownership,
      }, { sessionId: 'module-protected' });
      const protectedManaged = createManagedSession(protectedStored, workspace, { messagesLoaded: true });
      manager.sessions.set(protectedManaged.id, protectedManaged);

      const bundle = (id, hidden = false) => ({
        version: 1,
        session: { header: { id, createdAt: 1, hidden }, messages: [] },
        files: [],
      });
      const capture = async (fn) => {
        try { await fn(); return ''; }
        catch (error) { return error instanceof Error ? error.message : String(error); }
      };

      const aliasError = await capture(() => manager.importSession(workspace.id, bundle('alias/victim'), 'move'));
      const staleDir = join(workspace.rootPath, 'sessions', 'stale-session');
      mkdirSync(staleDir, { recursive: true });
      const sentinel = join(staleDir, 'sentinel.txt');
      writeFileSync(sentinel, 'keep-me');
      const staleError = await capture(() => manager.importSession(workspace.id, bundle('stale-session'), 'move'));
      const protectedError = await capture(() => manager.importSession(workspace.id, bundle('module-protected'), 'move'));
      const imported = await manager.importSession(workspace.id, bundle('imported-visible', true), 'move');
      const importedManaged = manager.sessions.get(imported.sessionId);

      console.log('RESULT:' + JSON.stringify({
        aliasError,
        staleError,
        protectedError,
        sentinel: readFileSync(sentinel, 'utf8'),
        importedId: imported.sessionId,
        importedHidden: importedManaged?.hidden,
        protectedStillPresent: manager.sessions.has(protectedManaged.id),
      }));
      manager.cleanup();
    `
    const result = Bun.spawnSync([process.execPath, '--eval', script], {
      cwd: join(import.meta.dir, '..', '..', '..', '..'),
      env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.exitCode, result.stderr.toString()).toBe(0)
    const resultLine = result.stdout.toString().split('\n').find((line) => line.startsWith('RESULT:'))
    expect(resultLine, result.stdout.toString()).toBeTruthy()
    expect(JSON.parse(resultLine!.slice('RESULT:'.length))).toEqual({
      aliasError: 'Invalid session bundle',
      staleError: 'Session stale-session already exists in target workspace',
      protectedError: 'Path is unavailable',
      sentinel: 'keep-me',
      importedId: 'imported-visible',
      importedHidden: false,
      protectedStillPresent: true,
    })
  })
})
