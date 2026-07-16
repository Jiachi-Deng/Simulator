import { describe, expect, it, mock } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import {
  ClaudeAgent,
  resolveClaudeProcessSpawnOverride,
} from '../claude-agent.ts';
import type { ProviderProcessTree } from '../provider-process-reaper.ts';

interface ClaudeProcessHarness {
  spawnModuleClaudeProcess(options: SpawnOptions): ChildProcess;
  disposeAndReap(): Promise<void>;
  moduleProcessTrees: Set<ProviderProcessTree>;
  currentQuery: {
    close(): void;
    return(value?: unknown): Promise<unknown>;
  } | null;
  currentQueryAbortController: { abort(): void } | null;
  persistentInput?: { end(): void };
  activeTurnChannel?: { end(): void };
  destroy(): void;
}

function createAgentHarness(): ClaudeProcessHarness {
  const agent = Object.create(ClaudeAgent.prototype) as ClaudeProcessHarness;
  agent.moduleProcessTrees = new Set();
  agent.currentQuery = null;
  agent.currentQueryAbortController = null;
  // The production destroy() clears unrelated agent state. These focused tests
  // bypass construction of those services and exercise only provider cleanup.
  agent.destroy = () => {};
  return agent;
}

function spawnModuleCommand(
  agent: ClaudeProcessHarness,
  command: string,
  args: string[],
): ChildProcess {
  return agent.spawnModuleClaudeProcess({
    command,
    args,
    cwd: process.cwd(),
    env: { ...process.env },
    signal: new AbortController().signal,
  });
}

function spawnModuleHelper(agent: ClaudeProcessHarness, source: string): ChildProcess {
  return spawnModuleCommand(agent, process.execPath, ['-e', source]);
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function processGroupIsAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!predicate()) throw new Error('Timed out waiting for deterministic process state');
}

function killOwnedProcessGroup(pgid: number | undefined): void {
  if (!pgid) return;
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function stopOwnedProcessGroup(pgid: number | undefined): Promise<void> {
  killOwnedProcessGroup(pgid);
  if (pgid) await waitUntil(() => !processGroupIsAlive(pgid));
}

async function stopOrdinaryChild(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid && pidIsAlive(pid)) child.kill('SIGKILL');
  if (pid) await waitUntil(() => !pidIsAlive(pid));
}

async function waitForStdoutMarker(
  child: ChildProcess,
  marker: string,
  timeoutMs = 5_000,
): Promise<void> {
  const stdout = child.stdout;
  if (!stdout) throw new Error('Fixture stdout pipe is unavailable');

  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for fixture stdout marker'));
    }, timeoutMs);
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.includes(marker)) {
        cleanup();
        resolve();
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error('Fixture exited before emitting its stdout marker'));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      stdout.off('data', onData);
      child.off('exit', onExit);
    };
    stdout.on('data', onData);
    child.once('exit', onExit);
  });
}

describe('ClaudeAgent transient Module process lifecycle', () => {
  const testOnPosix = process.platform === 'win32' ? it.skip : it;

  it('leaves ordinary visible Host Sessions on the Claude SDK default spawn model', () => {
    const moduleSpawner = mock((_options: SpawnOptions) => ({} as SpawnedProcess));

    const ordinaryOptions = resolveClaudeProcessSpawnOverride(
      { moduleAgentRun: undefined },
      moduleSpawner,
      'darwin',
    );
    const nonTransientOptions = resolveClaudeProcessSpawnOverride(
      { moduleAgentRun: { transient: false } },
      moduleSpawner,
      'darwin',
    );
    const transientOptions = resolveClaudeProcessSpawnOverride(
      { moduleAgentRun: { transient: true } },
      moduleSpawner,
      'darwin',
    );

    expect(Object.hasOwn(ordinaryOptions, 'spawnClaudeCodeProcess')).toBe(false);
    expect(Object.hasOwn(nonTransientOptions, 'spawnClaudeCodeProcess')).toBe(false);
    expect(transientOptions.spawnClaudeCodeProcess).toBe(moduleSpawner);
    expect(resolveClaudeProcessSpawnOverride(
      { moduleAgentRun: { transient: true } },
      moduleSpawner,
      'win32',
    )).toEqual({});
    expect(moduleSpawner).not.toHaveBeenCalled();
  });

  testOnPosix('spawns transient Module Claude in a dedicated process group', async () => {
    const agent = createAgentHarness();
    const child = spawnModuleHelper(agent, 'setInterval(() => {}, 1_000)');
    const pid = child.pid;
    expect(pid).toBeNumber();

    try {
      await waitUntil(() => pidIsAlive(pid!));
      // A detached POSIX child becomes leader of a group whose PGID is its PID.
      expect(processGroupIsAlive(pid!)).toBe(true);
      expect(agent.moduleProcessTrees.size).toBe(1);

      await agent.disposeAndReap();

      expect(processGroupIsAlive(pid!)).toBe(false);
      expect(agent.moduleProcessTrees.size).toBe(0);
    } finally {
      await stopOwnedProcessGroup(pid);
    }
  });

  const nodeExecutable = Bun.which('node');
  const testWithNodeOnPosix = process.platform === 'win32' || !nodeExecutable
    ? it.skip
    : it;

  testWithNodeOnPosix('continuously discards Module stderr so Node pipe backpressure cannot deadlock stdout', async () => {
    const agent = createAgentHarness();
    const marker = 'MODULE_STDERR_DRAINED';
    const source = [
      'const chunk = Buffer.alloc(64 * 1024, 0x78)',
      'let remaining = 8 * 1024 * 1024',
      'function pump() {',
      '  while (remaining > 0) {',
      '    const size = Math.min(chunk.length, remaining)',
      '    remaining -= size',
      "    if (!process.stderr.write(chunk.subarray(0, size))) { process.stderr.once('drain', pump); return }",
      '  }',
      `  process.stdout.write(${JSON.stringify(`${marker}\n`)})`,
      '  setInterval(() => {}, 1_000)',
      '}',
      'pump()',
    ].join('\n');
    const child = spawnModuleCommand(agent, nodeExecutable!, ['-e', source]);
    const pid = child.pid;
    expect(pid).toBeNumber();

    try {
      // stdin/stdout remain available exactly as required by SpawnedProcess.
      expect(child.stdin).toBeTruthy();
      expect(child.stdout).toBeTruthy();
      // resume() flows bytes directly to a discard sink; no data listener can
      // retain provider output or forward it to logs.
      expect(child.stderr?.readableFlowing).toBe(true);
      expect(child.stderr?.listenerCount('data')).toBe(0);

      // With an unread Node pipe this 8 MiB fixture blocks before the marker.
      await waitForStdoutMarker(child, marker);

      await agent.disposeAndReap();
      expect(processGroupIsAlive(pid!)).toBe(false);
      expect(agent.moduleProcessTrees.size).toBe(0);
    } finally {
      await stopOwnedProcessGroup(pid);
    }
  });

  testOnPosix('disposeAndReap does not resolve until a Claude descendant is gone', async () => {
    const agent = createAgentHarness();
    const tempDir = mkdtempSync(join(tmpdir(), 'simulator-claude-module-tree-'));
    const readyPath = join(tempDir, 'descendant-ready');
    const descendantSource = [
      "const { writeFileSync } = require('node:fs')",
      "process.once('SIGTERM', () => setTimeout(() => process.exit(0), 250))",
      `writeFileSync(${JSON.stringify(readyPath)}, String(process.pid))`,
      'setInterval(() => {}, 1_000)',
    ].join(';');
    const parentSource = [
      "const { spawn } = require('node:child_process')",
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' })`,
      'setInterval(() => {}, 1_000)',
    ].join(';');
    const parent = spawnModuleHelper(agent, parentSource);
    const parentPid = parent.pid;
    expect(parentPid).toBeNumber();

    try {
      await waitUntil(() => existsSync(readyPath));
      const descendantPid = Number(readFileSync(readyPath, 'utf8'));
      expect(descendantPid).toBeNumber();
      expect(pidIsAlive(descendantPid)).toBe(true);

      let disposeSettled = false;
      const dispose = agent.disposeAndReap().finally(() => {
        disposeSettled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(disposeSettled).toBe(false);
      expect(pidIsAlive(descendantPid)).toBe(true);

      await dispose;
      expect(disposeSettled).toBe(true);
      expect(processGroupIsAlive(parentPid!)).toBe(false);
      expect(pidIsAlive(descendantPid)).toBe(false);
      expect(agent.moduleProcessTrees.size).toBe(0);
    } finally {
      await stopOwnedProcessGroup(parentPid);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  testOnPosix('retains cleanup debt on iterator/reap failure without signaling an ordinary Host process', async () => {
    const agent = createAgentHarness();
    const moduleChild = spawnModuleHelper(agent, 'setInterval(() => {}, 1_000)');
    const modulePid = moduleChild.pid;
    const ordinaryHostChild = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000)'],
      { detached: false, stdio: 'ignore' },
    );
    const ordinaryPid = ordinaryHostChild.pid;
    expect(modulePid).toBeNumber();
    expect(ordinaryPid).toBeNumber();

    const iteratorError = new Error('fixture iterator return failed');
    const reapError = new Error('fixture process acknowledgement failed');
    const cleanupDebt = {
      reap: mock(async () => { throw reapError; }),
      isAlive: mock(() => true),
    } as unknown as ProviderProcessTree;
    agent.moduleProcessTrees.add(cleanupDebt);
    agent.currentQuery = {
      close: mock(() => {}),
      return: mock(async () => { throw iteratorError; }),
    };
    agent.currentQueryAbortController = { abort: mock(() => {}) };

    try {
      await waitUntil(() => pidIsAlive(modulePid!) && pidIsAlive(ordinaryPid!));

      let failure: unknown;
      try {
        await agent.disposeAndReap();
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([iteratorError, reapError]);
      expect(cleanupDebt.reap).toHaveBeenCalledTimes(1);
      expect(agent.moduleProcessTrees.size).toBe(1);
      expect(agent.moduleProcessTrees.has(cleanupDebt)).toBe(true);
      expect(processGroupIsAlive(modulePid!)).toBe(false);
      // The ordinary visible Host child is not in the Module-owned Set or
      // process group, so even a failed Module dispose cannot terminate it.
      expect(pidIsAlive(ordinaryPid!)).toBe(true);
    } finally {
      await stopOwnedProcessGroup(modulePid);
      await stopOrdinaryChild(ordinaryHostChild);
    }
  });
});
