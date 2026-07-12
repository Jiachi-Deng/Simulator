import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { areBuildUpdatesDisabled } from './build-environment'

export interface SimulatorBuildPolicy {
  readonly schemaVersion: 1
  readonly updatesDisabled: boolean
}

export function resolveBuildPolicy(env: NodeJS.ProcessEnv = process.env): SimulatorBuildPolicy {
  return Object.freeze({ schemaVersion: 1, updatesDisabled: areBuildUpdatesDisabled(env) })
}

export function writeBuildPolicy(directory: string, policy = resolveBuildPolicy()): string {
  const targetDirectory = resolve(directory)
  mkdirSync(targetDirectory, { recursive: true })
  const target = join(targetDirectory, 'build-policy.json')
  writeFileSync(target, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o644 })
  return target
}

if (import.meta.main) {
  const directory = process.argv[2]
  if (!directory) throw new Error('Usage: bun run scripts/build-policy.ts <resource-directory>')
  console.log(writeBuildPolicy(directory))
}
