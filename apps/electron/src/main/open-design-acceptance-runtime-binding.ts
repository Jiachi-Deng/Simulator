import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type {
  OpenDesignAcceptanceRuntimeBinding,
  OpenDesignAcceptanceRuntimeBindingRequest,
} from '../shared/open-design-acceptance-ipc'

interface RuntimeBindingServerIdentity {
  readonly pid: number
  readonly startedAt: number
}

export interface OpenDesignAcceptanceRuntimeBindingReaderOptions {
  /** Resolved once by the packaged App from the same CONFIG_DIR used by bootstrapServer. */
  readonly configRoot: string
  /** Resolved once by the packaged App from app.getPath('userData'). */
  readonly userDataRoot: string
  readonly mainPid?: number
  /** Test seam only. Production uses a random per-process digest. */
  readonly runtimeInstanceDigest?: string
}

export type OpenDesignAcceptanceRuntimeBindingReader = (
  request: OpenDesignAcceptanceRuntimeBindingRequest,
) => OpenDesignAcceptanceRuntimeBinding

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function readCurrentServerIdentity(configRoot: string): RuntimeBindingServerIdentity | undefined {
  try {
    const source = readFileSync(join(configRoot, '.server.lock'), 'utf8')
    if (source.length < 1 || source.length > 512) return undefined
    const value = JSON.parse(source) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    if (Object.keys(record).sort().join('\n') !== 'pid\nstartedAt'
      || !positiveSafeInteger(record.pid) || !positiveSafeInteger(record.startedAt)
      || source !== JSON.stringify({ pid: record.pid, startedAt: record.startedAt })) return undefined
    return Object.freeze({ pid: record.pid, startedAt: record.startedAt })
  } catch {
    return undefined
  }
}

function processInstanceDigest(mainPid: number): string {
  return createHash('sha256')
    .update('open-design-acceptance-runtime-binding-v1\0')
    .update(String(mainPid))
    .update('\0')
    .update(randomBytes(32))
    .digest('hex')
}

/**
 * Creates the acceptance-only, read-only comparison endpoint. The endpoint
 * intentionally returns no environment values, paths, file contents, or
 * credentials. A copied caller-side lock cannot pass because the App reads
 * only the lock beneath its own process-resolved CONFIG_DIR.
 */
export function createOpenDesignAcceptanceRuntimeBindingReader(
  options: OpenDesignAcceptanceRuntimeBindingReaderOptions,
): OpenDesignAcceptanceRuntimeBindingReader {
  const configRoot = realpathSync(options.configRoot)
  const userDataRoot = realpathSync(options.userDataRoot)
  const mainPid = options.mainPid ?? process.pid
  if (!positiveSafeInteger(mainPid)) throw new TypeError('Acceptance runtime main PID is invalid')
  const runtimeInstanceDigest = options.runtimeInstanceDigest ?? processInstanceDigest(mainPid)
  if (!/^[0-9a-f]{64}$/.test(runtimeInstanceDigest)) {
    throw new TypeError('Acceptance runtime instance digest is invalid')
  }

  return Object.freeze((request: OpenDesignAcceptanceRuntimeBindingRequest) => {
    const serverIdentity = readCurrentServerIdentity(configRoot)
    return Object.freeze({
      schemaVersion: 1 as const,
      configRootMatches: request.configRealpath === configRoot,
      userDataRootMatches: request.profileRealpath === userDataRoot,
      mainPidMatches: request.mainPid === mainPid,
      serverIdentityMatches: serverIdentity?.pid === request.serverPid
        && serverIdentity.startedAt === request.serverLockStartedAt,
      runtimeInstanceDigest,
    })
  })
}
