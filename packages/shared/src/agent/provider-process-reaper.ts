import type { ChildProcess } from 'node:child_process'

export interface ProviderProcessTreeOptions {
  /** True only when the child was spawned with detached:true on POSIX. */
  readonly processGroup: boolean
}

export interface ProviderDisposeOptions {
  /** Maximum time to wait for the provider SDK iterator's graceful return. */
  readonly iteratorReturnTimeoutMs?: number
  /** Grace period passed to each provider process tree before SIGKILL. */
  readonly reapGraceMs?: number
  /** Maximum time to wait for OS acknowledgement after SIGKILL. */
  readonly reapKillAckMs?: number
}

export interface ProviderProcessReaper {
  reap(graceMs?: number, killAckMs?: number): Promise<void>
}

const DEFAULT_ITERATOR_RETURN_TIMEOUT_MS = 1_000
const DEFAULT_REAP_GRACE_MS = 2_000
const DEFAULT_REAP_KILL_ACK_MS = 1_000

export class ProviderIteratorReturnTimeoutError extends Error {
  readonly code = 'PROVIDER_ITERATOR_RETURN_TIMEOUT'

  constructor(timeoutMs: number) {
    super(`Provider SDK iterator did not return within ${timeoutMs}ms`)
    this.name = 'ProviderIteratorReturnTimeoutError'
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function requirePositiveTimeout(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`)
  }
}

async function awaitIteratorReturn(
  iteratorReturn: (() => unknown | PromiseLike<unknown>) | undefined,
  timeoutMs: number,
): Promise<void> {
  if (!iteratorReturn) return

  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(iteratorReturn).then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new ProviderIteratorReturnTimeoutError(timeoutMs)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

/**
 * Give the SDK iterator a bounded opportunity to close, then always reap every
 * tracked OS process tree. Iterator and reap failures are both cleanup debt:
 * neither is allowed to hide the other or be reported as a successful dispose.
 */
export async function returnProviderIteratorAndReap(
  iteratorReturn: (() => unknown | PromiseLike<unknown>) | undefined,
  processTrees: readonly ProviderProcessReaper[],
  options: ProviderDisposeOptions = {},
): Promise<void> {
  const iteratorReturnTimeoutMs = options.iteratorReturnTimeoutMs
    ?? DEFAULT_ITERATOR_RETURN_TIMEOUT_MS
  const reapGraceMs = options.reapGraceMs ?? DEFAULT_REAP_GRACE_MS
  const reapKillAckMs = options.reapKillAckMs ?? DEFAULT_REAP_KILL_ACK_MS
  requirePositiveTimeout(iteratorReturnTimeoutMs, 'Provider iterator return timeout')
  requirePositiveTimeout(reapGraceMs, 'Provider process reap grace timeout')
  requirePositiveTimeout(reapKillAckMs, 'Provider process reap acknowledgement timeout')

  let iteratorFailure: unknown
  let iteratorFailed = false
  const reapFailures: unknown[] = []
  try {
    await awaitIteratorReturn(iteratorReturn, iteratorReturnTimeoutMs)
  } catch (error) {
    iteratorFailed = true
    iteratorFailure = error
  } finally {
    const results = await Promise.allSettled(processTrees.map((tree) => (
      Promise.resolve().then(() => tree.reap(reapGraceMs, reapKillAckMs))
    )))
    for (const result of results) {
      if (result.status === 'rejected') reapFailures.push(result.reason)
    }
  }

  const failures = iteratorFailed
    ? [iteratorFailure, ...reapFailures]
    : reapFailures
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'Provider disposal failed while returning the SDK iterator and reaping its process tree',
    )
  }
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function childAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

/**
 * Awaitable OS acknowledgement for a provider subprocess and, on POSIX, every
 * descendant that inherited its dedicated process group. This is used only by
 * transient Module Sessions; ordinary Craft sessions retain their established
 * process lifecycle.
 */
export class ProviderProcessTree {
  readonly #child: ChildProcess
  readonly #processGroup: boolean
  readonly #pid?: number

  constructor(child: ChildProcess, options: ProviderProcessTreeOptions) {
    this.#child = child
    this.#processGroup = options.processGroup && process.platform !== 'win32'
    this.#pid = child.pid
  }

  signal(signal: NodeJS.Signals): void {
    if (this.#processGroup && this.#pid) {
      try {
        process.kill(-this.#pid, signal)
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      }
    }
    try { this.#child.kill(signal) } catch { /* Strict reap performs the final verification. */ }
  }

  isAlive(): boolean {
    if (this.#processGroup && this.#pid) return processGroupAlive(this.#pid)
    return childAlive(this.#child)
  }

  async reap(graceMs = 2_000, killAckMs = 1_000): Promise<void> {
    if (!Number.isSafeInteger(graceMs) || graceMs < 1
      || !Number.isSafeInteger(killAckMs) || killAckMs < 1) {
      throw new TypeError('Provider process reap timeouts must be positive')
    }
    if (!this.isAlive()) return
    this.signal('SIGTERM')
    if (await this.#waitUntilGone(graceMs)) return
    this.signal('SIGKILL')
    if (await this.#waitUntilGone(killAckMs)) return
    throw new Error('Provider OS process tree did not acknowledge termination')
  }

  async #waitUntilGone(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!this.isAlive()) return true
      await wait(20)
    }
    return !this.isAlive()
  }
}
