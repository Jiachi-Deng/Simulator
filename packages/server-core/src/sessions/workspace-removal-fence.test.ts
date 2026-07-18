import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const roots: string[] = []
const SESSION_MANAGER_URL = pathToFileURL(join(import.meta.dir, 'SessionManager.ts')).href

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeWorkspace(root: string, id: string): { id: string; name: string; rootPath: string; createdAt: number } {
  mkdirSync(root, { recursive: true })
  const workspace = { id, name: id, rootPath: root, createdAt: 1 }
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    id,
    name: id,
    slug: id,
    createdAt: 1,
    updatedAt: 1,
  }))
  return workspace
}

describe('workspace removal transient Module fence', () => {
  it('fences creation synchronously, waits for in-flight creation, reaps Modules, and preserves visible Sessions', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'workspace-removal-config-'))
    const successRoot = mkdtempSync(join(tmpdir(), 'workspace-removal-success-'))
    const failureRoot = mkdtempSync(join(tmpdir(), 'workspace-removal-failure-'))
    roots.push(configDir, successRoot, failureRoot)
    const successWorkspace = writeWorkspace(successRoot, 'workspace-success')
    const failureWorkspace = writeWorkspace(failureRoot, 'workspace-failure')
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      workspaces: [successWorkspace, failureWorkspace],
      activeWorkspaceId: successWorkspace.id,
      activeSessionId: null,
      llmConnections: [],
    }))
    writeFileSync(join(configDir, 'config-defaults.json'), JSON.stringify({
      version: 'test',
      description: 'workspace removal test defaults',
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
      import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { createSession as createStoredSession } from '@craft-agent/shared/sessions';
      import { SessionManager, createManagedSession } from ${JSON.stringify(SESSION_MANAGER_URL)};

      const successWorkspace = ${JSON.stringify(successWorkspace)};
      const failureWorkspace = ${JSON.stringify(failureWorkspace)};
      const ownership = (suffix) => ({
        transient: true,
        contractVersion: 2,
        moduleId: 'org.simulator.open-design',
        runHandle: 'run_' + suffix.repeat(32),
        idempotencyKeyDigest: suffix.repeat(64),
        requestDigest: (suffix === '1' ? '2' : '3').repeat(64),
        workerEpoch: 'epoch_workspace_removal_' + suffix,
        state: 'accepted',
      });
      const addOrdinary = async (manager, workspace, name) => {
        const stored = await createStoredSession(workspace.rootPath, { name });
        const managed = createManagedSession(stored, workspace, { messagesLoaded: true });
        manager.sessions.set(managed.id, managed);
        return managed;
      };

      const successManager = new SessionManager();
      const ordinary = await addOrdinary(successManager, successWorkspace, 'Ordinary visible Session');
      const malformedResidue = join(
        successWorkspace.rootPath,
        'sessions',
        '.module-agent-quarantine',
        'malformed-residue',
      );
      mkdirSync(malformedResidue, { recursive: true });
      writeFileSync(join(malformedResidue, 'quarantine.json'), '{"kind":"module-agent-cleanup-debt"}');
      successManager.malformedModuleAgentSessionIds.add('malformed-session');
      successManager.malformedModuleAgentResidues.set(
        successWorkspace.id,
        new Map([['malformed-session', new Set([malformedResidue])]]),
      );
      let releaseCreation;
      const creationGate = new Promise((resolve) => { releaseCreation = resolve; });
      let signalCreationEntered;
      const creationEntered = new Promise((resolve) => { signalCreationEntered = resolve; });
      const originalCanonicalBoundaryPath = successManager.canonicalBoundaryPath.bind(successManager);
      let delayed = false;
      successManager.canonicalBoundaryPath = async (path) => {
        if (!delayed && path === join(successWorkspace.rootPath, 'sessions')) {
          delayed = true;
          signalCreationEntered();
          await creationGate;
        }
        return originalCanonicalBoundaryPath(path);
      };

      const firstCreation = successManager.createSession(successWorkspace.id, {
        name: 'OpenDesign',
        hidden: true,
        workingDirectory: 'none',
      }, { moduleAgentRun: ownership('1') });
      await creationEntered;

      let sharedRemoveCalls = 0;
      let zeroModulesAtSharedRemove = false;
      let zeroMalformedResidueAtSharedRemove = false;
      let ordinaryPresentAtSharedRemove = false;
      const removal = successManager.removeWorkspaceAfterTransientModuleCleanup(
        successWorkspace.id,
        () => {
          sharedRemoveCalls += 1;
          zeroModulesAtSharedRemove = [...successManager.sessions.values()]
            .every((session) => session.workspace.id !== successWorkspace.id || session.moduleAgentRun === undefined);
          zeroMalformedResidueAtSharedRemove = !existsSync(malformedResidue)
            && !successManager.malformedModuleAgentSessionIds.has('malformed-session');
          ordinaryPresentAtSharedRemove = successManager.sessions.has(ordinary.id);
          return 'removed';
        },
      );

      let secondCreationError = '';
      try {
        await successManager.createSession(successWorkspace.id, {
          hidden: true,
          workingDirectory: 'none',
        }, { moduleAgentRun: ownership('4') });
      } catch (error) {
        secondCreationError = error instanceof Error ? error.message : String(error);
      }
      await Promise.resolve();
      const sharedRemoveBeforeRelease = sharedRemoveCalls;
      releaseCreation();
      const createdModule = await firstCreation;
      const removalResult = await removal;

      const failureManager = new SessionManager();
      const failureOrdinary = await addOrdinary(failureManager, failureWorkspace, 'Stable visible Session');
      const failureStored = await createStoredSession(failureWorkspace.rootPath, {
        name: 'Failing OpenDesign',
        hidden: true,
        moduleAgentRun: ownership('5'),
      });
      const failureModule = createManagedSession(failureStored, failureWorkspace, { messagesLoaded: true });
      failureModule.agent = {
        isProcessing: () => false,
        disposeAndReap: async () => { throw new Error('strict reap failed'); },
        dispose: () => undefined,
      };
      failureManager.sessions.set(failureModule.id, failureModule);
      let failedSharedRemoveCalls = 0;
      let removalFailure = '';
      try {
        await failureManager.removeWorkspaceAfterTransientModuleCleanup(failureWorkspace.id, () => {
          failedSharedRemoveCalls += 1;
          return true;
        });
      } catch (error) {
        removalFailure = error instanceof Error ? error.message : String(error);
      }
      let postFailureModuleError = '';
      try {
        await failureManager.createSession(failureWorkspace.id, {
          hidden: true,
          workingDirectory: 'none',
        }, { moduleAgentRun: ownership('6') });
      } catch (error) {
        postFailureModuleError = error instanceof Error ? error.message : String(error);
      }
      const postFailureOrdinary = await failureManager.createSession(failureWorkspace.id, {
        name: 'Main workspace remains usable',
        workingDirectory: 'none',
      });

      console.log('RESULT:' + JSON.stringify({
        sharedRemoveBeforeRelease,
        sharedRemoveCalls,
        secondCreationError,
        removalResult,
        zeroModulesAtSharedRemove,
        zeroMalformedResidueAtSharedRemove,
        ordinaryPresentAtSharedRemove,
        ordinaryStillPresent: successManager.sessions.has(ordinary.id),
        moduleReapedFromMemory: !successManager.sessions.has(createdModule.id),
        moduleReapedFromDisk: !existsSync(join(successWorkspace.rootPath, 'sessions', createdModule.id)),
        failedSharedRemoveCalls,
        removalFailure,
        postFailureModuleError,
        failureOrdinaryPresent: failureManager.sessions.has(failureOrdinary.id),
        postFailureOrdinaryCreated: failureManager.sessions.has(postFailureOrdinary.id),
        failedModuleRetained: failureManager.sessions.has(failureModule.id),
      }));
      successManager.cleanup();
      failureManager.cleanup();
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
    const output = JSON.parse(resultLine!.slice('RESULT:'.length)) as Record<string, unknown>
    expect(output).toEqual({
      sharedRemoveBeforeRelease: 0,
      sharedRemoveCalls: 1,
      secondCreationError: 'Workspace removal has fenced transient Module creation',
      removalResult: 'removed',
      zeroModulesAtSharedRemove: true,
      zeroMalformedResidueAtSharedRemove: true,
      ordinaryPresentAtSharedRemove: true,
      ordinaryStillPresent: true,
      moduleReapedFromMemory: true,
      moduleReapedFromDisk: true,
      failedSharedRemoveCalls: 0,
      removalFailure: 'Workspace workspace-failure removal was fenced because transient Module cleanup failed',
      postFailureModuleError: 'Workspace removal has fenced transient Module creation',
      failureOrdinaryPresent: true,
      postFailureOrdinaryCreated: true,
      failedModuleRetained: true,
    })
  })
})
