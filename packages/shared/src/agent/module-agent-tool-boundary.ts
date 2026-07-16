import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

interface ModuleAgentToolBoundary {
  authorizedRoot: string;
  workingDirectory: string;
}

export interface ModuleAgentToolBoundaryResult {
  allowed: boolean;
  reason?: string;
  /** Canonical Host path for validated file/search tools. */
  canonicalPath?: string;
  /** Tool input rewritten to the Host-canonical path before provider execution. */
  canonicalInput?: Record<string, unknown>;
}

const boundaries = new Map<string, ModuleAgentToolBoundary>();
const moduleSessions = new Set<string>();
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'multiedit']);
// Pi calls its Glob-equivalent built-in `find`; Claude calls it `Glob`.
const SEARCH_TOOLS = new Set(['glob', 'find', 'grep']);
const PATH_ALIASES = ['file_path', 'path'] as const;
type PathAlias = typeof PATH_ALIASES[number];

function isRecord(input: unknown): input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  try {
    const prototype = Object.getPrototypeOf(input);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownPathAliases(input: Record<string, unknown>): PathAlias[] {
  return PATH_ALIASES.filter((alias) => Object.hasOwn(input, alias));
}

function rewriteCanonicalPath(
  input: Record<string, unknown>,
  canonicalField: PathAlias,
  canonicalPath: string,
): Record<string, unknown> {
  // Remove every accepted spelling before adding the one field consumed by
  // the active provider. A checked alias must never survive beside it.
  const canonicalInput = { ...input };
  for (const alias of PATH_ALIASES) delete canonicalInput[alias];
  canonicalInput[canonicalField] = canonicalPath;
  return canonicalInput;
}

function resolveSinglePathAlias(
  input: Record<string, unknown>,
  required: boolean,
): { alias?: PathAlias; rawPath?: unknown } | ModuleAgentToolBoundaryResult {
  const aliases = ownPathAliases(input);
  if (aliases.length > 1) {
    return {
      allowed: false,
      reason: 'Module Agent tools reject conflicting file_path and path aliases.',
    };
  }
  if (aliases.length === 0) {
    return required
      ? { allowed: false, reason: 'Module Agent file tools require exactly one path field.' }
      : {};
  }
  const alias = aliases[0]!;
  return { alias, rawPath: input[alias] };
}

function isWithin(candidate: string, root: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function canonicalizeCandidate(rawPath: string, base: string): string {
  const lexicalPath = resolve(base, rawPath);
  let existingAncestor = lexicalPath;
  const missingSegments: string[] = [];

  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) throw new Error('No existing path ancestor');
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }

  const canonicalAncestor = realpathSync(existingAncestor);
  return resolve(canonicalAncestor, ...missingSegments);
}

function validatePath(rawPath: unknown, boundary: ModuleAgentToolBoundary): ModuleAgentToolBoundaryResult {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.includes('\0') || rawPath.startsWith('~')) {
    return { allowed: false, reason: 'Module Agent file tools require a valid path.' };
  }

  let candidate: string;
  try {
    candidate = canonicalizeCandidate(rawPath, boundary.workingDirectory);
  } catch {
    return { allowed: false, reason: 'Module Agent path could not be safely resolved.' };
  }
  if (!isWithin(candidate, boundary.authorizedRoot)) {
    return { allowed: false, reason: 'Module Agent tools are limited to the authorized project root.' };
  }

  if (existsSync(candidate)) {
    try {
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        return { allowed: false, reason: 'Module Agent tools cannot operate on unresolved symbolic links.' };
      }
      if (stat.isFile() && stat.nlink !== 1) {
        return { allowed: false, reason: 'Module Agent tools cannot operate on hard-linked files.' };
      }
    } catch {
      return { allowed: false, reason: 'Module Agent path metadata could not be verified.' };
    }
  }

  return { allowed: true, canonicalPath: candidate };
}

/**
 * Registers a Host-owned, session-scoped tool boundary. The root and working
 * directory must already exist so the boundary is anchored to their real paths.
 */
export function registerModuleAgentToolBoundary(
  sessionId: string,
  authorizedRoot: string,
  workingDirectory: string,
): void {
  if (!sessionId) throw new Error('Module Agent session id is required');
  moduleSessions.add(sessionId);
  const canonicalRoot = realpathSync(authorizedRoot);
  const canonicalWorkingDirectory = realpathSync(workingDirectory);
  if (!isWithin(canonicalWorkingDirectory, canonicalRoot)) {
    throw new Error('Module Agent working directory is outside the authorized root');
  }
  boundaries.set(sessionId, {
    authorizedRoot: canonicalRoot,
    workingDirectory: canonicalWorkingDirectory,
  });
}

/**
 * Marks a trusted Host-created Module session before its filesystem boundary is
 * installed. The centralized tool pipeline then fails closed if registration
 * is missing or delayed instead of treating the session like a normal Craft
 * conversation.
 */
export function markModuleAgentSession(sessionId: string): void {
  if (!sessionId) throw new Error('Module Agent session id is required');
  moduleSessions.add(sessionId);
}

export function unregisterModuleAgentToolBoundary(sessionId: string): void {
  boundaries.delete(sessionId);
  moduleSessions.delete(sessionId);
}

/**
 * Enforces the boundary before the normal permission-mode pipeline. Unknown,
 * shell, network, MCP, browser, and sub-agent tools fail closed.
 */
export function checkModuleAgentToolBoundary(
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
): ModuleAgentToolBoundaryResult {
  const boundary = boundaries.get(sessionId);
  if (!boundary) {
    return moduleSessions.has(sessionId)
      ? { allowed: false, reason: 'Module Agent session has no active Host tool boundary.' }
      : { allowed: true };
  }

  if (typeof toolName !== 'string' || toolName.length === 0 || !isRecord(input)) {
    return { allowed: false, reason: 'Module Agent tool input is malformed.' };
  }

  const normalizedTool = toolName.toLowerCase().replaceAll('_', '');
  if (FILE_TOOLS.has(normalizedTool)) {
    const aliasResult = resolveSinglePathAlias(input, true);
    if ('allowed' in aliasResult) return aliasResult;
    const pathResult = validatePath(aliasResult.rawPath, boundary);
    if (!pathResult.allowed || !pathResult.canonicalPath) return pathResult;
    return {
      ...pathResult,
      canonicalInput: rewriteCanonicalPath(input, aliasResult.alias!, pathResult.canonicalPath),
    };
  }
  if (SEARCH_TOOLS.has(normalizedTool)) {
    const aliasResult = resolveSinglePathAlias(input, false);
    if ('allowed' in aliasResult) return aliasResult;
    const pathResult = validatePath(aliasResult.rawPath ?? boundary.workingDirectory, boundary);
    if (!pathResult.allowed) return pathResult;
    const pattern = input.pattern;
    if (typeof pattern !== 'string' || pattern.length === 0 || pattern.includes('\0')) {
      return { allowed: false, reason: 'Module Agent search tools require a valid pattern.' };
    }
    if (normalizedTool === 'glob' || normalizedTool === 'find') {
      if (isAbsolute(pattern) || pattern.startsWith('~') || pattern.includes('..')
        || pattern.includes('{') || pattern.includes('}')) {
        return { allowed: false, reason: 'Module Agent glob patterns must remain relative to the authorized project root.' };
      }
    }
    return {
      allowed: true,
      canonicalPath: pathResult.canonicalPath,
      canonicalInput: rewriteCanonicalPath(input, 'path', pathResult.canonicalPath!),
    };
  }

  return {
    allowed: false,
    reason: `Module Agent sessions cannot use the ${toolName} tool.`,
  };
}
