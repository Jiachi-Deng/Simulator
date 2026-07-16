import { describe, expect, it } from 'bun:test';
import {
  preparePiFileToolInputForExecutor,
  preparePiFileToolInputForHost,
} from './file-tool-path-input.ts';

const FILE_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit'] as const;

describe('Pi file-tool path boundary', () => {
  it('crosses the Host permission pipeline and executor with one path field', () => {
    for (const toolName of FILE_TOOLS) {
      const hostInput = preparePiFileToolInputForHost(toolName, {
        path: 'src/index.ts',
        marker: toolName,
      });
      expect(hostInput).toEqual({ file_path: 'src/index.ts', marker: toolName });
      expect(Object.hasOwn(hostInput, 'path')).toBe(false);

      const executorInput = preparePiFileToolInputForExecutor(toolName, {
        ...hostInput,
        file_path: '/canonical/project/src/index.ts',
      });
      expect(executorInput).toEqual({ path: '/canonical/project/src/index.ts', marker: toolName });
      expect(Object.hasOwn(executorInput, 'file_path')).toBe(false);
    }
  });

  it('rejects conflicting aliases before the Host and before executor dispatch', () => {
    for (const toolName of FILE_TOOLS) {
      const conflicting = {
        file_path: '/canonical/project/inside.ts',
        path: '/outside/escape.ts',
      };
      expect(() => preparePiFileToolInputForHost(toolName, conflicting)).toThrow('exactly one path field');
      expect(() => preparePiFileToolInputForExecutor(toolName, conflicting)).toThrow('exactly one path field');
    }
  });

  it('fails closed for missing, non-string, empty, and NUL paths', () => {
    for (const input of [
      {},
      { path: 123 },
      { path: '' },
      { path: 'bad\0path' },
    ]) {
      expect(() => preparePiFileToolInputForHost('Write', input)).toThrow();
      expect(() => preparePiFileToolInputForExecutor('Write', input)).toThrow();
    }
  });

  it('does not rewrite search or unrelated tool inputs', () => {
    for (const toolName of ['Glob', 'Find', 'Grep', 'Bash']) {
      const input = { path: '.', pattern: '**/*.ts' };
      expect(preparePiFileToolInputForHost(toolName, input)).toBe(input);
      expect(preparePiFileToolInputForExecutor(toolName, input)).toBe(input);
    }
  });
});
