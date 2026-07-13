import { readdirSync } from "node:fs"
import { basename, join } from "node:path"

export function updaterLeaks(directory: string): string[] {
  const leaks: string[] = []
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (/^latest.*\.ya?ml$/i.test(entry.name) || /\.blockmap$/i.test(entry.name)) leaks.push(child)
    }
  }
  visit(directory)
  return leaks.sort()
}

if (import.meta.main) {
  const directory = process.argv[2]
  if (!directory) throw new Error(`Usage: ${basename(process.argv[1])} BUNDLE_DIR`)
  const leaks = updaterLeaks(directory)
  console.log(JSON.stringify({ ok: leaks.length === 0, updaterLeaks: leaks }, null, 2))
  process.exit(leaks.length ? 1 : 0)
}
