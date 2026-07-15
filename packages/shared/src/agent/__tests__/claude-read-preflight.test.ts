import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preflightClaudeToolBeforeHostFileIo } from '../claude-read-preflight.ts';
import {
  registerModuleAgentToolBoundary,
  unregisterModuleAgentToolBoundary,
} from '../module-agent-tool-boundary.ts';

const roots: string[] = [];

afterEach(async () => {
  unregisterModuleAgentToolBoundary('module-image-session');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Claude Read preflight', () => {
  it('blocks an oversized outside-root image before invoking Host resize I/O', async () => {
    const container = await mkdtemp(join(tmpdir(), 'claude-module-image-boundary-'));
    roots.push(container);
    const project = join(container, 'project');
    const outside = join(container, 'outside');
    await Promise.all([mkdir(project), mkdir(outside)]);
    const outsideImage = join(outside, 'secret.png');
    await writeFile(outsideImage, Buffer.alloc(4 * 1024 * 1024));
    registerModuleAgentToolBoundary('module-image-session', project, project);
    const resize = mock(async () => join(project, 'resized.png'));

    const result = await preflightClaudeToolBeforeHostFileIo({
      sessionId: 'module-image-session',
      toolName: 'Read',
      input: { file_path: outsideImage },
      onImageResize: resize,
    });

    expect(result).toMatchObject({ type: 'block' });
    expect(resize).not.toHaveBeenCalled();
  });

  it('revalidates a resized path before returning updated Claude input', async () => {
    const container = await mkdtemp(join(tmpdir(), 'claude-module-resize-boundary-'));
    roots.push(container);
    const project = join(container, 'project');
    const outside = join(container, 'session-tmp');
    await Promise.all([mkdir(project), mkdir(outside)]);
    const image = join(project, 'large.png');
    await writeFile(image, Buffer.alloc(4 * 1024 * 1024));
    registerModuleAgentToolBoundary('module-image-session', project, project);

    const result = await preflightClaudeToolBeforeHostFileIo({
      sessionId: 'module-image-session',
      toolName: 'Read',
      input: { file_path: image },
      onImageResize: async () => join(outside, 'resized.png'),
    });

    expect(result).toMatchObject({ type: 'block' });
  });

  it('uses the project-canonical path for relative image metadata and resize I/O', async () => {
    const container = await mkdtemp(join(tmpdir(), 'claude-module-relative-image-'));
    roots.push(container);
    const project = join(container, 'project');
    const processDirectory = join(container, 'process-cwd');
    await Promise.all([mkdir(project), mkdir(processDirectory)]);
    const projectImage = join(project, 'large.png');
    await writeFile(projectImage, Buffer.alloc(4 * 1024 * 1024));
    await writeFile(join(processDirectory, 'large.png'), Buffer.from('outside'));
    registerModuleAgentToolBoundary('module-image-session', project, project);
    const canonicalProject = await realpath(project);
    const originalCwd = process.cwd();
    let resizeInput: string | undefined;
    try {
      process.chdir(processDirectory);
      const result = await preflightClaudeToolBeforeHostFileIo({
        sessionId: 'module-image-session',
        toolName: 'Read',
        input: { file_path: 'large.png' },
        onImageResize: async (filePath) => {
          resizeInput = filePath;
          return join(project, 'resized.png');
        },
      });

      expect(resizeInput).toBe(join(canonicalProject, 'large.png'));
      expect(result).toMatchObject({
        type: 'continue',
        modified: true,
        input: { file_path: join(canonicalProject, 'resized.png') },
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
});
