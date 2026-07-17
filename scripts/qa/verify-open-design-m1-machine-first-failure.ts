#!/usr/bin/env bun

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  validateOpenDesignM1FirstFailure,
  type OpenDesignM1FirstFailureAuthority,
} from './open-design-m1-machine-first-failure'

const COMMIT_SHA = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/

function requiredEnv(name: string, pattern?: RegExp): string {
  const value = process.env[name]
  if (!value || (pattern && !pattern.test(value))) throw new TypeError(`${name} is invalid`)
  return value
}

function positiveInteger(name: string): number {
  const value = Number(requiredEnv(name, /^[1-9][0-9]*$/))
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} is invalid`)
  return value
}

async function main(): Promise<void> {
  if (process.argv.length !== 3) throw new TypeError('First-failure verifier requires one artifact root')
  const runAttempt = positiveInteger('GITHUB_RUN_ATTEMPT')
  if (runAttempt !== 1) throw new TypeError('GITHUB_RUN_ATTEMPT is invalid')
  const authority: OpenDesignM1FirstFailureAuthority = {
    hostHeadSha: requiredEnv('GITHUB_SHA', COMMIT_SHA),
    producerRunId: positiveInteger('GITHUB_RUN_ID'),
    producerRunAttempt: 1,
    hostBuildRunId: positiveInteger('HOST_BUILD_RUN_ID'),
    hostArtifactSha256: requiredEnv('HOST_ARTIFACT_SHA256', SHA256),
  }
  const result = await validateOpenDesignM1FirstFailure(resolve(process.argv[2]!), authority)
  process.stdout.write(`${JSON.stringify({ status: 'failed', ...result })}\n`)
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  void main().catch(() => {
    process.stderr.write('OpenDesign M1 first-failure evidence verifier failed closed.\n')
    process.exitCode = 1
  })
}
