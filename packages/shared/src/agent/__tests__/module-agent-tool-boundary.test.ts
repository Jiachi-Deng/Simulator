import { afterEach, describe, expect, it } from 'bun:test';
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkModuleAgentToolBoundary,
  markModuleAgentSession,
  registerModuleAgentToolBoundary,
  unregisterModuleAgentToolBoundary,
} from '../module-agent-tool-boundary.ts';
import { runPreToolUseChecks } from '../core/pre-tool-use.ts';

const roots: string[] = [];

afterEach(async () => {
  unregisterModuleAgentToolBoundary('module-session');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setupBoundary() {
  const container = await mkdtemp(join(tmpdir(), 'module-agent-boundary-'));
  roots.push(container);
  const root = join(container, 'project');
  const nested = join(root, 'src');
  const outside = join(container, 'outside');
  await Promise.all([mkdir(nested, { recursive: true }), mkdir(outside, { recursive: true })]);
  await writeFile(join(nested, 'inside.ts'), 'inside');
  await writeFile(join(outside, 'secret.txt'), 'secret');
  registerModuleAgentToolBoundary('module-session', root, nested);
  return { root, nested, outside };
}

describe('Module Agent tool boundary', () => {
  it('allows project file operations and blocks traversal, shell, network, and unknown tools', async () => {
    const { root, nested, outside } = await setupBoundary();
    const canonicalRoot = await realpath(root);
    const canonicalNested = await realpath(nested);
    expect(checkModuleAgentToolBoundary('module-session', 'Read', { file_path: 'inside.ts' })).toMatchObject({
      allowed: true,
      canonicalPath: join(canonicalNested, 'inside.ts'),
      canonicalInput: { file_path: join(canonicalNested, 'inside.ts') },
    });
    expect(checkModuleAgentToolBoundary('module-session', 'Write', { file_path: join(root, 'new.ts') }).allowed).toBe(true);
    expect(checkModuleAgentToolBoundary('module-session', 'Glob', { path: root, pattern: '**/*.ts' })).toMatchObject({
      allowed: true,
      canonicalInput: { path: canonicalRoot, pattern: '**/*.ts' },
    });
    expect(checkModuleAgentToolBoundary('module-session', 'Grep', { pattern: 'inside' })).toMatchObject({
      allowed: true,
      canonicalInput: { path: canonicalNested, pattern: 'inside' },
    });

    expect(checkModuleAgentToolBoundary('module-session', 'Read', { file_path: join(outside, 'secret.txt') }).allowed).toBe(false);
    expect(checkModuleAgentToolBoundary('module-session', 'Write', { file_path: '../../escape.txt' }).allowed).toBe(false);
    expect(checkModuleAgentToolBoundary('module-session', 'Read', { file_path: '~/.ssh/config' }).allowed).toBe(false);
    expect(checkModuleAgentToolBoundary('module-session', 'Glob', { pattern: '../../**/*' }).allowed).toBe(false);
    expect(checkModuleAgentToolBoundary('module-session', 'Glob', { pattern: '{src,../../outside}/**/*' }).allowed).toBe(false);
    expect(checkModuleAgentToolBoundary('module-session', 'Bash', { command: 'cat /etc/passwd' }).allowed).toBe(false);
    expect(checkModuleAgentToolBoundary('module-session', 'WebFetch', { url: 'https://example.com' }).allowed).toBe(false);
    expect(checkModuleAgentToolBoundary('module-session', 'mcp__source__read', {}).allowed).toBe(false);
  });

  it('fails closed for a trusted Module session whose Host boundary is missing', () => {
    markModuleAgentSession('module-session');
    expect(checkModuleAgentToolBoundary('module-session', 'Read', { file_path: '/tmp/file' }))
      .toEqual({ allowed: false, reason: 'Module Agent session has no active Host tool boundary.' });
    expect(checkModuleAgentToolBoundary('module-session', 'Bash', { command: 'pwd' }).allowed).toBe(false);
    expect(checkModuleAgentToolBoundary('ordinary-session', 'Bash', { command: 'pwd' }).allowed).toBe(true);
  });

  it('blocks symlink escapes and hard-linked file aliases', async () => {
    const { nested, outside } = await setupBoundary();
    await symlink(outside, join(nested, 'escape-link'));
    expect(checkModuleAgentToolBoundary('module-session', 'Read', {
      file_path: join(nested, 'escape-link', 'secret.txt'),
    }).allowed).toBe(false);

    const hardlink = join(nested, 'hardlink-secret.txt');
    await link(join(outside, 'secret.txt'), hardlink);
    expect(checkModuleAgentToolBoundary('module-session', 'Read', { file_path: hardlink }).allowed).toBe(false);
    expect(checkModuleAgentToolBoundary('module-session', 'Write', { file_path: hardlink }).allowed).toBe(false);
  });

  it('removes the special restriction when the hidden session is deleted', async () => {
    await setupBoundary();
    unregisterModuleAgentToolBoundary('module-session');
    expect(checkModuleAgentToolBoundary('module-session', 'Bash', { command: 'true' }).allowed).toBe(true);
  });

  it('blocks through the centralized Claude/Pi PreToolUse pipeline before allow-all mode', async () => {
    const { root, nested } = await setupBoundary();
    const result = runPreToolUseChecks({
      toolName: 'Bash',
      input: { command: 'cat /etc/passwd' },
      sessionId: 'module-session',
      permissionMode: 'allow-all',
      workspaceRootPath: root,
      workspaceId: 'workspace',
      workingDirectory: nested,
      activeSourceSlugs: [],
      allSourceSlugs: [],
      hasSourceActivation: false,
      permissionManager: {
        isCommandWhitelisted: () => true,
        isDangerousCommand: () => false,
        getBaseCommand: (command) => command,
        extractDomainFromNetworkCommand: () => null,
        isDomainWhitelisted: () => true,
      },
    });
    expect(result).toMatchObject({ type: 'block' });
    if (result.type === 'block') expect(result.reason).toContain('cannot use the Bash tool');
  });

  it('rewrites allowed file and search inputs to canonical Host paths before provider execution', async () => {
    const { root, nested } = await setupBoundary();
    const canonicalNested = await realpath(nested);
    const permissionManager = {
      isCommandWhitelisted: () => true,
      isDangerousCommand: () => false,
      getBaseCommand: (command: string) => command,
      extractDomainFromNetworkCommand: () => null,
      isDomainWhitelisted: () => true,
    };
    const common = {
      sessionId: 'module-session',
      permissionMode: 'allow-all' as const,
      workspaceRootPath: root,
      workspaceId: 'workspace',
      workingDirectory: nested,
      activeSourceSlugs: [],
      allSourceSlugs: [],
      hasSourceActivation: false,
      permissionManager,
    };

    expect(runPreToolUseChecks({ ...common, toolName: 'Read', input: { file_path: 'inside.ts' } }))
      .toEqual({ type: 'modify', input: { file_path: join(canonicalNested, 'inside.ts') } });
    expect(runPreToolUseChecks({ ...common, toolName: 'Glob', input: { pattern: '**/*.ts' } }))
      .toEqual({ type: 'modify', input: { path: canonicalNested, pattern: '**/*.ts' } });
  });
});
