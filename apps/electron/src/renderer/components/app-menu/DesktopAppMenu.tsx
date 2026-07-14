import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import * as Icons from "lucide-react"
import { isMac } from "@/lib/platform"
import { useActionLabel } from "@/actions"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuShortcut,
  DropdownMenuSub,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
} from "@/components/ui/styled-dropdown"
import { CraftAgentsSymbol } from "../icons/CraftAgentsSymbol"
import { SquarePenRounded } from "../icons/SquarePenRounded"
import { SETTINGS_ICONS } from "../icons/SettingsIcons"
import { TopBarButton } from "../ui/TopBarButton"
import {
  EDIT_MENU,
  VIEW_MENU,
  WINDOW_MENU,
  SETTINGS_ITEMS,
  ROOT_MENU,
  HELP_LINKS,
  DEBUG_MENU,
  getShortcutDisplay,
} from "../../../shared/menu-schema"
import type { MenuItem, MenuSection } from "../../../shared/menu-schema"
import type {
  OpenDesignModuleAction,
  OpenDesignModuleCheckpoint,
  OpenDesignModuleState,
} from "../../../shared/open-design-module-ipc"
import type { AppMenuProps } from "./types"

type MenuActionHandlers = {
  toggleFocusMode?: () => void
  toggleSidebar?: () => void
}

type MenuTranslate = (key: string, options?: Record<string, string | number>) => string
export type OpenDesignMenuCommand = OpenDesignModuleAction | 'retry'

export interface OpenDesignMenuPresentation {
  readonly statusKey: string
  readonly statusValues?: Readonly<Record<string, string | number>>
  readonly checkpointKey?: string
  readonly action?: OpenDesignMenuCommand
  readonly actionKey?: string
  readonly actionDisabled: boolean
}

function getCheckpointKey(checkpoint: OpenDesignModuleCheckpoint): string {
  if (checkpoint.startsWith('compensation-') || checkpoint === 'compensation-started' || checkpoint === 'compensated') {
    return 'menu.openDesignCheckpointRecovering'
  }
  switch (checkpoint) {
    case 'catalog-verified':
      return 'menu.openDesignCheckpointDownloading'
    case 'artifact-downloaded':
      return 'menu.openDesignCheckpointInstalling'
    case 'installed':
      return 'menu.openDesignCheckpointRegistering'
    case 'registered':
    case 'completed':
      return 'menu.openDesignCheckpointFinishing'
    default:
      return 'menu.openDesignCheckpointPreparing'
  }
}

export function getOpenDesignMenuPresentation(
  state: OpenDesignModuleState | undefined,
  commandInFlight = false,
): OpenDesignMenuPresentation {
  if (!state) {
    return { statusKey: 'menu.openDesignStatusLoading', actionDisabled: true }
  }
  switch (state.status) {
    case 'not-installed':
      return {
        statusKey: 'menu.openDesignStatusNotInstalled',
        action: 'install',
        actionKey: 'menu.openDesignActionInstall',
        actionDisabled: commandInFlight,
      }
    case 'available':
      return {
        statusKey: 'menu.openDesignStatusAvailable',
        action: 'start',
        actionKey: 'menu.openDesignActionOpen',
        actionDisabled: commandInFlight,
      }
    case 'running':
      return {
        statusKey: 'menu.openDesignStatusRunning',
        action: 'stop',
        actionKey: 'menu.openDesignActionStop',
        actionDisabled: commandInFlight,
      }
    case 'installing': {
      const progress = state.progress
      if (progress && progress.total > 0) {
        const percent = Math.max(0, Math.min(100, Math.round((progress.received / progress.total) * 100)))
        return {
          statusKey: 'menu.openDesignStatusInstallingProgress',
          statusValues: { percent },
          actionDisabled: true,
        }
      }
      return {
        statusKey: state.checkpoint
          ? 'menu.openDesignStatusInstallingCheckpoint'
          : 'menu.openDesignStatusInstalling',
        ...(state.checkpoint ? { checkpointKey: getCheckpointKey(state.checkpoint) } : {}),
        actionDisabled: true,
      }
    }
    case 'disabled':
      return { statusKey: 'menu.openDesignStatusDisabled', actionDisabled: true }
    case 'not-ready':
      return {
        statusKey: 'menu.openDesignStatusNotReady',
        action: 'retry',
        actionKey: 'menu.openDesignActionRetry',
        actionDisabled: commandInFlight,
      }
    case 'error':
      return {
        statusKey: state.errorCode === 'CONTROLLER_UNAVAILABLE'
          ? 'menu.openDesignStatusUnavailable'
          : 'menu.openDesignStatusError',
        action: 'retry',
        actionKey: 'menu.openDesignActionRetry',
        actionDisabled: commandInFlight,
      }
  }
}

function unavailableOpenDesignState(): OpenDesignModuleState {
  return {
    status: 'error',
    errorCode: 'CONTROLLER_UNAVAILABLE',
    errorMessage: 'OpenDesign controller unavailable',
  }
}

const roleHandlers: Record<string, () => void> = {
  undo: () => window.electronAPI.menuUndo(),
  redo: () => window.electronAPI.menuRedo(),
  cut: () => window.electronAPI.menuCut(),
  copy: () => window.electronAPI.menuCopy(),
  paste: () => window.electronAPI.menuPaste(),
  selectAll: () => window.electronAPI.menuSelectAll(),
  zoomIn: () => window.electronAPI.menuZoomIn(),
  zoomOut: () => window.electronAPI.menuZoomOut(),
  resetZoom: () => window.electronAPI.menuZoomReset(),
  minimize: () => window.electronAPI.menuMinimize(),
  zoom: () => window.electronAPI.menuMaximize(),
}

function getIcon(name: string): React.ComponentType<{ className?: string }> | null {
  const IconComponent = Icons[name as keyof typeof Icons] as React.ComponentType<{ className?: string }> | undefined
  return IconComponent ?? null
}

function renderSubmenuItem(
  item: MenuItem,
  index: number,
  actionHandlers: MenuActionHandlers,
  t: MenuTranslate,
): React.ReactNode {
  if (item.type === 'separator') {
    return <StyledDropdownMenuSeparator key={`sep-${index}`} />
  }

  if (item.type === 'url') {
    const Icon = getIcon(item.icon)
    return (
      <StyledDropdownMenuItem key={item.id} onClick={() => window.electronAPI.openUrl(item.url)}>
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {t(item.labelKey)}
        <Icons.ExternalLink className="h-3 w-3 ml-auto text-muted-foreground" />
      </StyledDropdownMenuItem>
    )
  }

  const Icon = getIcon(item.icon)
  const shortcut = getShortcutDisplay(item, isMac)

  if (item.type === 'role') {
    const handler = roleHandlers[item.role]
    const safeHandler = handler ?? (() => {
      console.warn(`[DesktopAppMenu] No handler registered for role: ${item.role}`)
    })
    return (
      <StyledDropdownMenuItem key={item.role} onClick={safeHandler}>
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {t(item.labelKey)}
        {shortcut && <DropdownMenuShortcut className="pl-6">{shortcut}</DropdownMenuShortcut>}
      </StyledDropdownMenuItem>
    )
  }

  if (item.type === 'action') {
    const handler = item.id === 'toggleFocusMode'
      ? actionHandlers.toggleFocusMode
      : item.id === 'toggleSidebar'
        ? actionHandlers.toggleSidebar
        : undefined
    return (
      <StyledDropdownMenuItem key={item.id} onClick={handler}>
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {t(item.labelKey)}
        {shortcut && <DropdownMenuShortcut className="pl-6">{shortcut}</DropdownMenuShortcut>}
      </StyledDropdownMenuItem>
    )
  }

  return null
}

function renderMenuSection(
  section: MenuSection,
  actionHandlers: MenuActionHandlers,
  t: MenuTranslate,
): React.ReactNode {
  const Icon = getIcon(section.icon)
  return (
    <DropdownMenuSub key={section.id}>
      <StyledDropdownMenuSubTrigger>
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {t(section.labelKey)}
      </StyledDropdownMenuSubTrigger>
      <StyledDropdownMenuSubContent>
        {section.items.map((item, index) => renderSubmenuItem(item, index, actionHandlers, t))}
      </StyledDropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/**
 * Desktop AppMenu — Craft logo dropdown with Edit/View/Window/Settings/Help/Debug submenus.
 *
 * Behavior matches the pre-refactor version that lived inline in `TopBar.tsx`.
 * Labels, hotkey strings, and update-actions are pulled from `menu-schema.ts`
 * so the mobile sheet and this dropdown share a single source of truth.
 */
export function DesktopAppMenu({
  onNewChat,
  onNewWindow,
  onOpenSettings,
  onOpenSettingsSubpage,
  onOpenKeyboardShortcuts,
  onToggleSidebar,
  onToggleFocusMode,
}: AppMenuProps) {
  const { t } = useTranslation()
  const [isDebugMode, setIsDebugMode] = useState(false)
  const [openDesignState, setOpenDesignState] = useState<OpenDesignModuleState>()
  const [openDesignCommand, setOpenDesignCommand] = useState<OpenDesignMenuCommand>()
  const openDesignCommandInFlight = useRef(false)
  const openDesignModule = isMac ? window.electronAPI.openDesignModule : undefined

  const newChatHotkey = useActionLabel('app.newChat').hotkey
  const newWindowHotkey = useActionLabel('app.newWindow').hotkey
  const settingsHotkey = useActionLabel('app.settings').hotkey
  const keyboardShortcutsHotkey = useActionLabel('app.keyboardShortcuts').hotkey
  const quitHotkey = useActionLabel('app.quit').hotkey

  useEffect(() => {
    window.electronAPI.isDebugMode().then(setIsDebugMode).catch(() => setIsDebugMode(false))
  }, [])

  useEffect(() => {
    if (!isDebugMode || !openDesignModule) {
      setOpenDesignState(undefined)
      return
    }

    let active = true
    const updateState = (state: OpenDesignModuleState) => {
      if (active) setOpenDesignState(state)
    }
    let unsubscribe = () => {}
    try {
      unsubscribe = openDesignModule.onStateChanged(updateState)
    } catch {
      updateState(unavailableOpenDesignState())
    }
    void openDesignModule.getState().then(updateState).catch(() => updateState(unavailableOpenDesignState()))
    return () => {
      active = false
      unsubscribe()
    }
  }, [isDebugMode, openDesignModule])

  const runOpenDesignCommand = async (command: OpenDesignMenuCommand) => {
    if (!openDesignModule || openDesignCommandInFlight.current) return
    openDesignCommandInFlight.current = true
    setOpenDesignCommand(command)
    try {
      const state = command === 'retry'
        ? await openDesignModule.getState()
        : await openDesignModule[command]()
      setOpenDesignState(state)
    } catch {
      setOpenDesignState(unavailableOpenDesignState())
    } finally {
      openDesignCommandInFlight.current = false
      setOpenDesignCommand(undefined)
    }
  }

  const actionHandlers: MenuActionHandlers = {
    toggleFocusMode: onToggleFocusMode,
    toggleSidebar: onToggleSidebar,
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <TopBarButton aria-label={t("menu.craftMenu")}>
          <CraftAgentsSymbol className="h-4 text-accent" />
        </TopBarButton>
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent align="start" minWidth="min-w-48">
        <StyledDropdownMenuItem onClick={onNewChat}>
          <SquarePenRounded className="h-3.5 w-3.5" />
          {t(ROOT_MENU.newChat.labelKey)}
          {newChatHotkey && <DropdownMenuShortcut className="pl-6">{newChatHotkey}</DropdownMenuShortcut>}
        </StyledDropdownMenuItem>
        {onNewWindow && (
          <StyledDropdownMenuItem onClick={onNewWindow}>
            <Icons.AppWindow className="h-3.5 w-3.5" />
            {t(ROOT_MENU.newWindow.labelKey)}
            {newWindowHotkey && <DropdownMenuShortcut className="pl-6">{newWindowHotkey}</DropdownMenuShortcut>}
          </StyledDropdownMenuItem>
        )}

        <StyledDropdownMenuSeparator />

        {renderMenuSection(EDIT_MENU, actionHandlers, t)}
        {renderMenuSection(VIEW_MENU, actionHandlers, t)}
        {renderMenuSection(WINDOW_MENU, actionHandlers, t)}

        <StyledDropdownMenuSeparator />

        <DropdownMenuSub>
          <StyledDropdownMenuSubTrigger>
            <Icons.Settings className="h-3.5 w-3.5" />
            {t("sidebar.settings")}
          </StyledDropdownMenuSubTrigger>
          <StyledDropdownMenuSubContent>
            <StyledDropdownMenuItem onClick={onOpenSettings}>
              <Icons.Settings className="h-3.5 w-3.5" />
              {t("menu.settings")}
              {settingsHotkey && <DropdownMenuShortcut className="pl-6">{settingsHotkey}</DropdownMenuShortcut>}
            </StyledDropdownMenuItem>
            <StyledDropdownMenuSeparator />
            {SETTINGS_ITEMS.map((item) => {
              const Icon = SETTINGS_ICONS[item.id]
              return (
                <StyledDropdownMenuItem
                  key={item.id}
                  onClick={() => onOpenSettingsSubpage(item.id)}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t(item.labelKey)}
                </StyledDropdownMenuItem>
              )
            })}
          </StyledDropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <StyledDropdownMenuSubTrigger>
            <Icons.HelpCircle className="h-3.5 w-3.5" />
            {t("menu.help")}
          </StyledDropdownMenuSubTrigger>
          <StyledDropdownMenuSubContent>
            {HELP_LINKS.map((link) => {
              const Icon = getIcon(link.icon)
              return (
                <StyledDropdownMenuItem
                  key={link.id}
                  onClick={() => window.electronAPI.openUrl(link.url)}
                >
                  {Icon && <Icon className="h-3.5 w-3.5" />}
                  {t(link.labelKey)}
                  <Icons.ExternalLink className="h-3 w-3 ml-auto text-muted-foreground" />
                </StyledDropdownMenuItem>
              )
            })}
            <StyledDropdownMenuItem onClick={onOpenKeyboardShortcuts}>
              <Icons.Keyboard className="h-3.5 w-3.5" />
              {t(ROOT_MENU.keyboardShortcuts.labelKey)}
              {keyboardShortcutsHotkey && <DropdownMenuShortcut className="pl-6">{keyboardShortcutsHotkey}</DropdownMenuShortcut>}
            </StyledDropdownMenuItem>
          </StyledDropdownMenuSubContent>
        </DropdownMenuSub>

        {isDebugMode && renderDebugSubmenu(t, openDesignModule ? {
          state: openDesignState,
          commandInFlight: openDesignCommand !== undefined,
          onCommand: runOpenDesignCommand,
        } : undefined)}

        <StyledDropdownMenuSeparator />

        <StyledDropdownMenuItem onClick={() => window.electronAPI.menuQuit()}>
          <Icons.LogOut className="h-3.5 w-3.5" />
          {t(ROOT_MENU.quit.labelKey)}
          {quitHotkey && <DropdownMenuShortcut className="pl-6">{quitHotkey}</DropdownMenuShortcut>}
        </StyledDropdownMenuItem>
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Renders the Debug submenu by mapping over `DEBUG_MENU.items`. The three actions
 * that drive it (`checkForUpdates`, `installUpdate`, `toggleDevTools`) all live on
 * `window.electronAPI` directly and never traverse the menu IPC channels.
 */
interface OpenDesignDebugMenuProps {
  readonly state: OpenDesignModuleState | undefined
  readonly commandInFlight: boolean
  readonly onCommand: (command: OpenDesignMenuCommand) => void
}

function renderOpenDesignMenuItems(
  t: MenuTranslate,
  props: OpenDesignDebugMenuProps,
): React.ReactNode {
  const presentation = getOpenDesignMenuPresentation(props.state, props.commandInFlight)
  const statusValues = presentation.checkpointKey
    ? { checkpoint: t(presentation.checkpointKey) }
    : presentation.statusValues
  const ActionIcon = presentation.action === 'install'
    ? Icons.Download
    : presentation.action === 'start'
      ? Icons.Play
      : presentation.action === 'stop'
        ? Icons.Square
        : Icons.RotateCw

  return (
    <>
      <StyledDropdownMenuSeparator />
      <StyledDropdownMenuItem disabled>
        {props.state?.status === 'installing'
          ? <Icons.LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          : <Icons.Palette className="h-3.5 w-3.5" />}
        {t(presentation.statusKey, statusValues)}
      </StyledDropdownMenuItem>
      {presentation.action && presentation.actionKey && (
        <StyledDropdownMenuItem
          disabled={presentation.actionDisabled}
          onClick={() => props.onCommand(presentation.action!)}
        >
          <ActionIcon className="h-3.5 w-3.5" />
          {t(presentation.actionKey)}
        </StyledDropdownMenuItem>
      )}
    </>
  )
}

function renderDebugSubmenu(
  t: MenuTranslate,
  openDesign?: OpenDesignDebugMenuProps,
): React.ReactNode {
  const SectionIcon = getIcon(DEBUG_MENU.icon)
  return (
    <DropdownMenuSub>
      <StyledDropdownMenuSubTrigger>
        {SectionIcon && <SectionIcon className="h-3.5 w-3.5" />}
        {t(DEBUG_MENU.labelKey)}
      </StyledDropdownMenuSubTrigger>
      <StyledDropdownMenuSubContent>
        {DEBUG_MENU.items.map((item, index) => {
          if (item.type === 'separator') {
            return <StyledDropdownMenuSeparator key={`sep-${index}`} />
          }
          if (item.type !== 'action') return null
          const Icon = getIcon(item.icon)
          const shortcut = isMac ? item.shortcutDisplayMac : item.shortcutDisplayOther
          const handler = debugHandlers[item.id]
          if (!handler) {
            console.warn(`[DesktopAppMenu] No debug handler for id: ${item.id}`)
            return null
          }
          return (
            <StyledDropdownMenuItem key={item.id} onClick={handler}>
              {Icon && <Icon className="h-3.5 w-3.5" />}
              {t(item.labelKey)}
              {shortcut && <DropdownMenuShortcut className="pl-6">{shortcut}</DropdownMenuShortcut>}
            </StyledDropdownMenuItem>
          )
        })}
        {openDesign && renderOpenDesignMenuItems(t, openDesign)}
      </StyledDropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

const debugHandlers: Record<string, () => void> = {
  checkForUpdates: () => window.electronAPI.checkForUpdates(),
  installUpdate: () => window.electronAPI.installUpdate(),
  toggleDevTools: () => window.electronAPI.menuToggleDevTools(),
}
