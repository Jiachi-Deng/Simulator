import {
  DefaultResourceLoader,
  SettingsManager,
  type CreateAgentSessionOptions,
} from '@earendil-works/pi-coding-agent'

/**
 * Build the Pi SDK resource services used only by transient Module Sessions.
 * The Module model may write inside its granted working directory, so project
 * and global Pi resources must never be discovered or executed from that tree.
 */
export async function createModuleResourceIsolation(
  cwd: string,
  agentDir: string,
): Promise<Pick<CreateAgentSessionOptions, 'settingsManager' | 'resourceLoader'>> {
  const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false })
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  })
  await resourceLoader.reload()
  return { settingsManager, resourceLoader }
}
