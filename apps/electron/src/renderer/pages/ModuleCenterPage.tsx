import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Blocks, Download, ExternalLink, Play, Square, TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { navigate, routes } from '@/lib/navigate'
import { useAppShellContext } from '@/context/AppShellContext'
import { toOpenDesignViewBounds } from '@/lib/open-design-view-bounds'
import type {
  OpenDesignModuleAction,
  OpenDesignModuleCheckpoint,
  OpenDesignModuleFacade,
  OpenDesignModuleState,
  OpenDesignModuleViewBounds,
} from '../../shared/open-design-module-ipc'

const CONTROLLER_UNAVAILABLE: OpenDesignModuleState = Object.freeze({
  status: 'error',
  errorCode: 'CONTROLLER_UNAVAILABLE',
  errorMessage: 'OpenDesign controller unavailable',
})

function checkpointKey(checkpoint: OpenDesignModuleCheckpoint): string {
  if (checkpoint.startsWith('compensation-') || checkpoint === 'compensation-started' || checkpoint === 'compensated') {
    return 'menu.openDesignCheckpointRecovering'
  }
  switch (checkpoint) {
    case 'catalog-verified': return 'menu.openDesignCheckpointDownloading'
    case 'artifact-downloaded': return 'menu.openDesignCheckpointInstalling'
    case 'installed': return 'menu.openDesignCheckpointRegistering'
    case 'registered':
    case 'completed': return 'menu.openDesignCheckpointFinishing'
    default: return 'menu.openDesignCheckpointPreparing'
  }
}

function statusKey(state: OpenDesignModuleState | undefined): string {
  if (!state) return 'menu.openDesignStatusLoading'
  switch (state.status) {
    case 'disabled': return 'menu.openDesignStatusDisabled'
    case 'not-ready': return 'menu.openDesignStatusNotReady'
    case 'not-installed': return 'menu.openDesignStatusNotInstalled'
    case 'available': return 'menu.openDesignStatusAvailable'
    case 'running': return 'menu.openDesignStatusRunning'
    case 'installing': return 'menu.openDesignStatusInstalling'
    case 'error': return state.errorCode === 'CONTROLLER_UNAVAILABLE'
      ? 'menu.openDesignStatusUnavailable'
      : 'menu.openDesignStatusError'
  }
}

function useOpenDesignModule() {
  const api = window.electronAPI.openDesignModule
  const [state, setState] = useState<OpenDesignModuleState>()
  const [command, setCommand] = useState<OpenDesignModuleAction>()
  const commandInFlight = useRef(false)

  useEffect(() => {
    if (!api) {
      setState(CONTROLLER_UNAVAILABLE)
      return
    }
    let active = true
    let retry: ReturnType<typeof setTimeout> | undefined
    const update = (next: OpenDesignModuleState) => {
      if (active) setState(next)
    }
    const load = async () => {
      try {
        update(await api.getState())
      } catch {
        if (active) retry = setTimeout(() => { void load() }, 250)
      }
    }
    let unsubscribe = () => {}
    try {
      unsubscribe = api.onStateChanged(update)
    } catch {
      update(CONTROLLER_UNAVAILABLE)
    }
    void load()
    return () => {
      active = false
      if (retry) clearTimeout(retry)
      unsubscribe()
    }
  }, [api])

  const run = useCallback(async (action: OpenDesignModuleAction) => {
    if (!api || commandInFlight.current) return state
    commandInFlight.current = true
    setCommand(action)
    try {
      const next = await api[action]()
      setState(next)
      return next
    } catch {
      setState(CONTROLLER_UNAVAILABLE)
      return CONTROLLER_UNAVAILABLE
    } finally {
      commandInFlight.current = false
      setCommand(undefined)
    }
  }, [api, state])

  return { api, state, command, run }
}

function sameBounds(left: OpenDesignModuleViewBounds | null, right: OpenDesignModuleViewBounds): boolean {
  return !!left && left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
}

function OpenDesignStage({
  api,
  running,
}: {
  api: OpenDesignModuleFacade | undefined
  running: boolean
}) {
  const slotRef = useRef<HTMLDivElement>(null)
  const lastBounds = useRef<OpenDesignModuleViewBounds | null>(null)
  const { isFocusedPanel = true } = useAppShellContext()

  useEffect(() => {
    if (!api || !running || !isFocusedPanel) {
      if (api) void api.setViewPresentation({ visible: false }).catch(() => undefined)
      return
    }

    let frame = 0
    let disposed = false
    const publish = () => {
      frame = 0
      if (disposed || !slotRef.current) return
      const bounds = toOpenDesignViewBounds(slotRef.current.getBoundingClientRect())
      if (!bounds || sameBounds(lastBounds.current, bounds)) return
      lastBounds.current = bounds
      void api.setViewPresentation({ visible: true, bounds }).catch((error) => {
        console.warn('[OpenDesign] Host rejected a transient view layout', error)
      })
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(publish)
    }
    const observer = new ResizeObserver(schedule)
    if (slotRef.current) observer.observe(slotRef.current)
    window.addEventListener('resize', schedule)
    schedule()

    return () => {
      disposed = true
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      lastBounds.current = null
      void api.setViewPresentation({ visible: false }).catch(() => undefined)
    }
  }, [api, running, isFocusedPanel])

  return <div ref={slotRef} className="h-full w-full bg-background" data-testid="open-design-module-stage" />
}

export default function ModuleCenterPage({ showOpenDesign }: { showOpenDesign: boolean }) {
  const { t } = useTranslation()
  const { api, state, command, run } = useOpenDesignModule()
  const running = state?.status === 'running'
  const progress = state?.status === 'installing' && state.progress && state.progress.total > 0
    ? Math.max(0, Math.min(100, Math.round((state.progress.received / state.progress.total) * 100)))
    : undefined
  const status = t(statusKey(state))
  const action = useMemo<OpenDesignModuleAction | 'open' | undefined>(() => {
    if (!state) return undefined
    if (state.status === 'not-installed') return 'install'
    if (state.status === 'available') return 'start'
    if (state.status === 'running') return 'open'
    if (state.status === 'error' && state.errorCode !== 'CONTROLLER_UNAVAILABLE') return state.version ? 'start' : 'install'
    return undefined
  }, [state])

  const runPrimaryAction = async () => {
    if (!action) return
    if (action === 'open') {
      navigate(routes.view.modules('open-design'))
      return
    }
    const next = await run(action)
    if (action === 'start' && next?.status === 'running') navigate(routes.view.modules('open-design'))
  }

  if (showOpenDesign && running) return <OpenDesignStage api={api} running />

  return (
    <div className="h-full overflow-y-auto bg-background" data-testid="module-center-page">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-8 @md/panel:px-10 @md/panel:py-10">
        <header className="flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Blocks className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">{t('modules.title')}</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{t('modules.subtitle')}</p>
          </div>
        </header>

        <section className="overflow-hidden rounded-xl border border-border/70 bg-foreground-2 shadow-minimal">
          <div className="flex flex-col gap-5 p-5 @md/panel:p-6">
            <div className="flex flex-col gap-4 @md/panel:flex-row @md/panel:items-start @md/panel:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-500">
                  <ExternalLink className="h-4.5 w-4.5" />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-medium">OpenDesign</h2>
                    <span className={cn(
                      'rounded-full px-2 py-0.5 text-[11px] font-medium',
                      running ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-foreground/5 text-muted-foreground',
                    )}>
                      {status}
                    </span>
                  </div>
                  <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{t('modules.openDesign.description')}</p>
                  {state?.version && (
                    <p className="mt-2 text-xs text-muted-foreground">{t('modules.openDesign.version', { version: state.version })}</p>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {running && (
                  <Button variant="outline" size="sm" disabled={!!command} onClick={() => { void run('stop') }}>
                    <Square className="h-3.5 w-3.5" />
                    {t('menu.openDesignActionStop')}
                  </Button>
                )}
                {action && (
                  <Button size="sm" disabled={!!command} onClick={() => { void runPrimaryAction() }}>
                    {action === 'install' ? <Download className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                    {action === 'install'
                      ? t(command ? 'modules.openDesign.installingAction' : 'menu.openDesignActionInstall')
                      : action === 'open'
                        ? t('menu.openDesignActionOpen')
                        : t(command ? 'modules.openDesign.startingAction' : 'menu.openDesignActionOpen')}
                  </Button>
                )}
              </div>
            </div>

            {state?.status === 'installing' && (
              <div className="rounded-lg bg-foreground/4 px-4 py-3">
                <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>{state.checkpoint ? t(checkpointKey(state.checkpoint)) : t('menu.openDesignStatusInstalling')}</span>
                  {progress !== undefined && <span className="tabular-nums">{progress}%</span>}
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
                  <div
                    className={cn('h-full rounded-full bg-accent transition-[width] duration-300', progress === undefined && 'w-1/3 animate-pulse')}
                    style={progress === undefined ? undefined : { width: `${progress}%` }}
                  />
                </div>
              </div>
            )}

            {(state?.status === 'disabled' || state?.status === 'not-ready' || state?.status === 'error') && (
              <div className="flex gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                <span>{state.errorCode ? `${status} (${state.errorCode})` : status}</span>
              </div>
            )}
          </div>

          <div className="border-t border-border/60 bg-foreground/[0.025] px-5 py-3 text-xs leading-5 text-muted-foreground @md/panel:px-6">
            {t('modules.openDesign.hostNote')}
          </div>
        </section>

        {showOpenDesign && !running && (
          <Button variant="outline" className="self-start" onClick={() => navigate(routes.view.modules())}>
            {t('modules.backToCenter')}
          </Button>
        )}
      </div>
    </div>
  )
}
