import { describe, expect, mock, test } from 'bun:test'

process.env.SIMULATOR_DISABLE_UPDATES = '1'

const checkForUpdates = mock(async () => ({ updateInfo: null }))
const quitAndInstall = mock(() => undefined)
const listeners = new Map<string, (...args: unknown[]) => void>()
const autoUpdater = {
  autoDownload: true,
  autoInstallOnAppQuit: true,
  logger: null as unknown,
  on: (event: string, listener: (...args: unknown[]) => void) => {
    listeners.set(event, listener)
    return autoUpdater
  },
  checkForUpdates,
  quitAndInstall,
}

mock.module('electron-updater', () => ({ autoUpdater }))
mock.module('electron', () => ({
  app: { getName: () => 'Simulator', getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
}))
mock.module('../logger', () => ({
  mainLog: { info: () => undefined, warn: () => undefined, error: () => undefined },
  autoUpdateLog: { info: () => undefined, warn: () => undefined, error: () => undefined },
}))
mock.module('@craft-agent/shared/version', () => ({ getAppVersion: () => '0.11.1' }))
mock.module('@craft-agent/shared/config', () => ({
  getDismissedUpdateVersion: () => null,
  clearDismissedUpdateVersion: () => undefined,
}))
mock.module('@craft-agent/shared/utils/files', () => ({ readJsonFileSync: () => null }))
mock.module('../../shared/types', () => ({
  RPC_CHANNELS: { update: { AVAILABLE: 'update:available', DOWNLOAD_PROGRESS: 'update:progress' } },
}))

const updates = await import('../auto-update')

describe('disabled auto-update boundary', () => {
  test('prevents automatic and manual updater calls', async () => {
    expect(autoUpdater.autoDownload).toBe(false)
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false)
    expect((await updates.checkForUpdatesOnLaunch()).reason).toBe('build-policy')
    await updates.checkForUpdates({ autoDownload: true })
    expect(checkForUpdates).not.toHaveBeenCalled()
  })

  test('prevents installing a cached update', async () => {
    await expect(updates.installUpdate()).rejects.toThrow('disabled')
    expect(quitAndInstall).not.toHaveBeenCalled()
  })
})
