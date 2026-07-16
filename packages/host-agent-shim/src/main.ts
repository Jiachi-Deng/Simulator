#!/usr/bin/env node
import { runHostAgentShim } from './shim.ts'

const controller = new AbortController()
const abort = (): void => controller.abort()
process.once('SIGTERM', abort)
process.once('SIGINT', abort)

try {
  process.exitCode = await runHostAgentShim({
    argv: process.argv.slice(2),
    entryPath: process.argv[1] ?? '',
    cwd: process.cwd(),
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    signal: controller.signal,
  })
} catch {
  process.stderr.write('[simulator-host-agent] INTERNAL_ERROR\n')
  process.exitCode = controller.signal.aborted ? 143 : 1
} finally {
  process.off('SIGTERM', abort)
  process.off('SIGINT', abort)
}
