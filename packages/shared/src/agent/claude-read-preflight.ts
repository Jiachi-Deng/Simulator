import { stat } from 'node:fs/promises';
import { IMAGE_LIMITS } from '../utils/files.ts';
import { checkModuleAgentToolBoundary } from './module-agent-tool-boundary.ts';

const IMAGE_READ_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff']);

export type ClaudeToolPreflightResult =
  | { type: 'continue'; input: Record<string, unknown>; modified: boolean }
  | { type: 'block'; reason: string };

export interface ClaudeToolPreflightInput {
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  onImageResize?: (filePath: string, maxSizeBytes: number) => Promise<string | null>;
  onDebug?: (message: string) => void;
}

/**
 * Performs the Module Agent boundary check before Claude's image metadata or
 * resize path can touch the Host filesystem. Resized paths are checked again
 * because the SDK will execute Read against the rewritten input.
 */
export async function preflightClaudeToolBeforeHostFileIo(
  options: ClaudeToolPreflightInput,
): Promise<ClaudeToolPreflightResult> {
  const boundary = checkModuleAgentToolBoundary(options.sessionId, options.toolName, options.input);
  if (!boundary.allowed) {
    return {
      type: 'block',
      reason: boundary.reason ?? 'Module Agent tool boundary denied the operation.',
    };
  }

  if (options.toolName !== 'Read') {
    return { type: 'continue', input: options.input, modified: false };
  }
  const rawFilePath = typeof options.input.file_path === 'string' ? options.input.file_path : undefined;
  if (!rawFilePath) return { type: 'continue', input: options.input, modified: false };
  // A Module boundary resolves relative SDK paths against the authorized
  // project cwd. Host metadata/resize I/O must use that exact canonical path,
  // never reinterpret the original relative string against process.cwd().
  const filePath = boundary.canonicalPath ?? rawFilePath;
  const canonicalized = filePath !== rawFilePath;
  const canonicalInput = canonicalized ? { ...options.input, file_path: filePath } : options.input;
  const extension = filePath.toLowerCase().split('.').pop() ?? '';
  if (!IMAGE_READ_EXTENSIONS.has(extension)) {
    return { type: 'continue', input: canonicalInput, modified: canonicalized };
  }

  try {
    const metadata = await stat(filePath);
    if (metadata.size <= IMAGE_LIMITS.MAX_RAW_SIZE) {
      return { type: 'continue', input: canonicalInput, modified: canonicalized };
    }
    const sizeMB = (metadata.size / (1024 * 1024)).toFixed(1);
    options.onDebug?.(`Image ${filePath} is ${sizeMB}MB, attempting resize...`);
    if (options.onImageResize) {
      const resizedPath = await options.onImageResize(filePath, IMAGE_LIMITS.MAX_RAW_SIZE);
      if (resizedPath) {
        const updatedInput = { ...options.input, file_path: resizedPath };
        const resizedBoundary = checkModuleAgentToolBoundary(options.sessionId, options.toolName, updatedInput);
        if (!resizedBoundary.allowed) {
          return {
            type: 'block',
            reason: resizedBoundary.reason ?? 'Module Agent resized image path is outside the authorized project root.',
          };
        }
        const canonicalResizedPath = resizedBoundary.canonicalPath ?? resizedPath;
        options.onDebug?.(`Image resized, redirecting Read to: ${canonicalResizedPath}`);
        return { type: 'continue', input: { ...updatedInput, file_path: canonicalResizedPath }, modified: true };
      }
    }
    return {
      type: 'block',
      reason: `Image too large (${sizeMB}MB). The API limit is 5MB base64 (~3.5MB raw). Use a smaller or compressed version.`,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      options.onDebug?.(`Image size check failed for ${filePath}: ${error}`);
    }
    return { type: 'continue', input: canonicalInput, modified: canonicalized };
  }
}
