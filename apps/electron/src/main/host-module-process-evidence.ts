export interface SanitizedMacosProcessRecord {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
  readonly executable: string
}

export interface SanitizedMacosProcessTree {
  readonly records: readonly SanitizedMacosProcessRecord[]
  readonly directChildGroupLeaders: readonly number[]
}

function executableBasename(raw: string): string {
  const basename = raw.split('/').at(-1) ?? 'unknown'
  // macOS wraps a just-exited process name in parentheses while the parent is
  // collecting its status; normalize that harmless lifecycle notation.
  return /^\(([^()]+)\)$/.exec(basename)?.[1] ?? basename
}

/**
 * Parse an already-sanitized `ps` table. Runtime names are evidence labels,
 * never an ownership condition: a provider candidate is identified as a
 * direct Host child that leads its own POSIX group. Both supported transient
 * providers are spawned in the Electron main process with `detached: true`.
 * Requiring that exact numeric shape prevents a lazily-created nested Module
 * or Chromium process from satisfying the provider-process acceptance gate.
 */
export function parseSanitizedMacosProcessTree(
  output: string,
  rootPid: number,
  knownOwnedProcessGroups: ReadonlySet<number> = new Set(),
): SanitizedMacosProcessTree {
  const rows = output.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) return []
    const pid = Number(match[1])
    const ppid = Number(match[2])
    const pgid = Number(match[3])
    if (![pid, ppid, pgid].every((value) => Number.isSafeInteger(value) && value > 0)) return []
    return [{ pid, ppid, pgid, executable: executableBasename(match[4]!) }]
  })
  const byParent = new Map<number, typeof rows>()
  for (const row of rows) {
    const children = byParent.get(row.ppid) ?? []
    children.push(row)
    byParent.set(row.ppid, children)
  }
  const descendants = new Map<number, (typeof rows)[number]>()
  const queue = [rootPid]
  while (queue.length > 0) {
    const parent = queue.shift()!
    for (const child of byParent.get(parent) ?? []) {
      if (child.executable === 'ps' || descendants.has(child.pid)) continue
      descendants.set(child.pid, child)
      queue.push(child.pid)
    }
  }
  // Keep observing descendants re-parented during teardown when their exact
  // numeric process group was already claimed by this acceptance journey.
  for (const row of rows) {
    if (knownOwnedProcessGroups.has(row.pgid) && row.executable !== 'ps') {
      descendants.set(row.pid, row)
    }
  }
  return {
    records: [...descendants.values()],
    directChildGroupLeaders: [...descendants.values()]
      .filter((row) => row.ppid === rootPid && row.pid === row.pgid)
      .map((row) => row.pgid),
  }
}

export function processGroupsAddedSince(
  baseline: ReadonlySet<number>,
  observed: readonly number[],
): number[] {
  return [...new Set(observed)].filter((pgid) => !baseline.has(pgid))
}
