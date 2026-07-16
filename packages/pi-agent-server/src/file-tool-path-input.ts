const PI_FILE_EXECUTOR_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit']);
const PATH_ALIASES = ['file_path', 'path'] as const;
type PathAlias = typeof PATH_ALIASES[number];

function ownPathAliases(input: Record<string, unknown>): PathAlias[] {
  return PATH_ALIASES.filter((alias) => Object.hasOwn(input, alias));
}

function requireSinglePathAlias(
  toolName: string,
  input: Record<string, unknown>,
): { alias: PathAlias; value: string } {
  const aliases = ownPathAliases(input);
  if (aliases.length !== 1) {
    throw new Error(`Pi ${toolName} input must contain exactly one path field`);
  }
  const alias = aliases[0]!;
  const value = input[alias];
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`Pi ${toolName} path must be a non-empty string`);
  }
  return { alias, value };
}

function rewritePathField(
  input: Record<string, unknown>,
  field: PathAlias,
  value: string,
): Record<string, unknown> {
  const rewritten = { ...input };
  for (const alias of PATH_ALIASES) delete rewritten[alias];
  rewritten[field] = value;
  return rewritten;
}

/**
 * Pi's built-in file tools expose `path`, while Craft's shared permission
 * pipeline uses Claude's `file_path` spelling. Cross that boundary with one
 * field only so conflicting aliases can never be hidden by normalization.
 */
export function preparePiFileToolInputForHost(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (!PI_FILE_EXECUTOR_TOOLS.has(toolName)) return input;
  const { value } = requireSinglePathAlias(toolName, input);
  return rewritePathField(input, 'file_path', value);
}

/**
 * Convert the Host-approved canonical input back to the sole field consumed by
 * Pi 0.80.6's read/write/edit executors. This is also a defensive final gate:
 * an allow response that contains two aliases never reaches the executor.
 */
export function preparePiFileToolInputForExecutor(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (!PI_FILE_EXECUTOR_TOOLS.has(toolName)) return input;
  const { value } = requireSinglePathAlias(toolName, input);
  return rewritePathField(input, 'path', value);
}
