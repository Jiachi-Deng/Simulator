export interface BeforeQuitEvent {
  preventDefault(): void
}

export type BeforeQuitCleanupState = 'idle' | 'cleanup-in-progress' | 'completed'

export interface BeforeQuitCleanupControllerOptions {
  readonly cleanup: () => Promise<void>
  readonly continueQuit: () => void
  readonly onCleanupError?: (error: unknown) => void
}

/** Coordinates Electron's synchronous before-quit cancellation with asynchronous cleanup. */
export class BeforeQuitCleanupController {
  #state: BeforeQuitCleanupState = 'idle'
  #completion: Promise<void> | undefined

  constructor(private readonly options: BeforeQuitCleanupControllerOptions) {}

  get state(): BeforeQuitCleanupState {
    return this.#state
  }

  get completion(): Promise<void> | undefined {
    return this.#completion
  }

  readonly handleBeforeQuit = (event: BeforeQuitEvent): void => {
    if (this.#state === 'completed') return

    // Electron requires this call during the event dispatch. It cannot follow an await.
    event.preventDefault()
    if (this.#state === 'cleanup-in-progress') return

    this.#state = 'cleanup-in-progress'
    this.#completion = this.options.cleanup()
      .catch((error) => this.options.onCleanupError?.(error))
      .then(() => {
        this.#state = 'completed'
        this.options.continueQuit()
      })
  }
}
