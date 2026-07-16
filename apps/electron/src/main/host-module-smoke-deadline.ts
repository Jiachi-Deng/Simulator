export class SmokeDeadlineExceededError extends Error {
  readonly code = 'SMOKE_DEADLINE_EXCEEDED'

  constructor() {
    super('SMOKE_DEADLINE_EXCEEDED')
    this.name = 'SmokeDeadlineExceededError'
  }
}

export class AuthoritativeSmokeWatchdogState {
  #timedOut = false

  get timedOut(): boolean {
    return this.#timedOut
  }

  markTimedOut(): void {
    this.#timedOut = true
  }

  assertMayCommitSuccess(): void {
    if (this.#timedOut) throw new Error('SMOKE_TIMEOUT')
  }
}

interface WaitForAcceptedValueOptions<T, U> {
  readonly refresh: () => Promise<T>
  readonly accept: (value: T) => U
  readonly timeoutMs: number
  readonly pollMs: number
  readonly now?: () => number
  readonly sleep?: (milliseconds: number) => Promise<void>
}

async function refreshBeforeDeadline<T>(
  refresh: () => Promise<T>,
  deadline: number,
  now: () => number,
): Promise<T> {
  const remainingMs = deadline - now()
  if (remainingMs <= 0) throw new SmokeDeadlineExceededError()

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome = await Promise.race([
      refresh().then((value) => ({ kind: 'value' as const, value })),
      new Promise<{ kind: 'deadline' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'deadline' }), remainingMs)
      }),
    ])
    if (outcome.kind === 'deadline' || now() >= deadline) {
      throw new SmokeDeadlineExceededError()
    }
    return outcome.value
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Polls an asynchronous snapshot without allowing any refresh call to outlive
 * the caller's deadline. A value that becomes acceptable after the deadline is
 * still a timeout, never a late success.
 */
export async function waitForAcceptedValue<T, U>(
  options: WaitForAcceptedValueOptions<T, U>,
): Promise<U> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((milliseconds: number) => (
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
  ))
  const deadline = now() + options.timeoutMs

  while (true) {
    const value = await refreshBeforeDeadline(options.refresh, deadline, now)
    try {
      const accepted = options.accept(value)
      if (now() >= deadline) throw new SmokeDeadlineExceededError()
      return accepted
    } catch (error) {
      if (error instanceof SmokeDeadlineExceededError) throw error
    }

    const remainingMs = deadline - now()
    if (remainingMs <= 0) throw new SmokeDeadlineExceededError()
    await sleep(Math.min(options.pollMs, remainingMs))
    if (now() >= deadline) throw new SmokeDeadlineExceededError()
  }
}
