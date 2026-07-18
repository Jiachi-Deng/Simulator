import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { getProjectPath, validateProjectSlug } from '@craft-agent/shared/projects'
import type { LoadedProject } from '@craft-agent/shared/projects'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { join } from 'node:path'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.projects.GET,
  RPC_CHANNELS.projects.GET_ONE,
  RPC_CHANNELS.projects.CREATE,
  RPC_CHANNELS.projects.UPDATE,
  RPC_CHANNELS.projects.DELETE,
  RPC_CHANNELS.projects.LIST_ASSETS,
  RPC_CHANNELS.projects.UPLOAD_ASSET,
  RPC_CHANNELS.projects.DELETE_ASSET,
] as const

export function registerProjectsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

  async function isRendererVisibleProject(project: LoadedProject): Promise<boolean> {
    try {
      await deps.sessionManager.assertRendererPathAccess(project.folderPath)
      await deps.sessionManager.assertRendererPathAccess(join(project.folderPath, 'config.json'))
      await deps.sessionManager.assertRendererPathAccess(project.assetsPath)
      if (project.config.workingDirectory) {
        await deps.sessionManager.assertRendererPathAccess(project.config.workingDirectory)
      }
      return true
    } catch {
      return false
    }
  }

  async function loadRendererVisibleProjects(workspaceRootPath: string): Promise<LoadedProject[]> {
    const { loadWorkspaceProjects } = await import('@craft-agent/shared/projects')
    const projects = loadWorkspaceProjects(workspaceRootPath)
    const visibility = await Promise.all(projects.map(isRendererVisibleProject))
    return projects.filter((_project, index) => visibility[index])
  }

  async function broadcastChanged(workspaceId: string, workspaceRootPath: string): Promise<void> {
    const projects = await loadRendererVisibleProjects(workspaceRootPath)
    pushTyped(server, RPC_CHANNELS.projects.CHANGED, { to: 'workspace', workspaceId }, workspaceId, projects)
  }

  // List all projects for a workspace
  server.handle(RPC_CHANNELS.projects.GET, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      log.error(`PROJECTS_GET: Workspace not found: ${workspaceId}`)
      return []
    }
    return loadRendererVisibleProjects(workspace.rootPath)
  })

  // Get one project (by id or slug)
  server.handle(RPC_CHANNELS.projects.GET_ONE, async (_ctx, workspaceId: string, projectIdOrSlug: string) => {
    validateProjectSlug(projectIdOrSlug)
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return null
    const { loadProject, loadProjectById } = await import('@craft-agent/shared/projects')
    const project = loadProject(workspace.rootPath, projectIdOrSlug)
      ?? loadProjectById(workspace.rootPath, projectIdOrSlug)
    if (!project || !await isRendererVisibleProject(project)) return null
    return project
  })

  // Create a new project
  server.handle(RPC_CHANNELS.projects.CREATE, async (_ctx, workspaceId: string, input: import('@craft-agent/shared/projects').CreateProjectInput) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    if (input.workingDirectory) {
      await deps.sessionManager.assertRendererPathAccess(input.workingDirectory)
    }
    const { createProject } = await import('@craft-agent/shared/projects')
    const project = createProject(workspace.rootPath, {
      name: input.name?.trim() || 'New Project',
      description: input.description,
      workingDirectory: input.workingDirectory,
      details: input.details,
      colorTheme: input.colorTheme,
    })
    await broadcastChanged(workspaceId, workspace.rootPath)
    log.info(`Created project: ${project.slug}`)
    return project
  })

  // Update project (partial patch). Slug stays stable.
  server.handle(RPC_CHANNELS.projects.UPDATE, async (
    _ctx,
    workspaceId: string,
    projectSlug: string,
    patch: Partial<Omit<import('@craft-agent/shared/projects').ProjectConfig, 'id' | 'slug' | 'createdAt'>>,
  ) => {
    validateProjectSlug(projectSlug)
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const projectPath = getProjectPath(workspace.rootPath, projectSlug)
    await deps.sessionManager.assertRendererPathAccess(projectPath)
    await deps.sessionManager.assertRendererPathAccess(join(projectPath, 'config.json'))
    if (patch.workingDirectory) {
      await deps.sessionManager.assertRendererPathAccess(patch.workingDirectory)
    }
    const { updateProject } = await import('@craft-agent/shared/projects')
    const updated = updateProject(workspace.rootPath, projectSlug, patch)
    await broadcastChanged(workspaceId, workspace.rootPath)
    return updated
  })

  // Delete a project; unbinds projectId from any sessions that referenced it.
  server.handle(RPC_CHANNELS.projects.DELETE, async (_ctx, workspaceId: string, projectSlug: string) => {
    validateProjectSlug(projectSlug)
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)

    const { loadProject, deleteProject } = await import('@craft-agent/shared/projects')
    const projectPath = getProjectPath(workspace.rootPath, projectSlug)
    await deps.sessionManager.assertRendererPathAccess(projectPath)
    await deps.sessionManager.assertRendererPathAccess(join(projectPath, 'config.json'))
    const project = loadProject(workspace.rootPath, projectSlug)
    if (!project) {
      log.warn(`PROJECTS_DELETE: project ${projectSlug} not found`)
      return
    }

    const { unbindProjectFromSessions } = await import('@craft-agent/shared/sessions')
    const touched = await unbindProjectFromSessions(workspace.rootPath, project.config.id)
    deleteProject(workspace.rootPath, projectSlug)
    await broadcastChanged(workspaceId, workspace.rootPath)
    log.info(`Deleted project ${projectSlug} (unbound ${touched} sessions)`)
  })

  // List assets in a project
  server.handle(RPC_CHANNELS.projects.LIST_ASSETS, async (_ctx, workspaceId: string, projectSlug: string) => {
    validateProjectSlug(projectSlug)
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return []
    await deps.sessionManager.assertRendererPathAccess(
      join(getProjectPath(workspace.rootPath, projectSlug), 'assets'),
    )
    const { listProjectAssets } = await import('@craft-agent/shared/projects')
    return listProjectAssets(workspace.rootPath, projectSlug)
  })

  // Upload an asset (base64 / text / sourcePath)
  server.handle(RPC_CHANNELS.projects.UPLOAD_ASSET, async (
    _ctx,
    workspaceId: string,
    projectSlug: string,
    input: import('@craft-agent/shared/projects').UploadProjectAssetInput,
  ) => {
    validateProjectSlug(projectSlug)
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const projectPath = getProjectPath(workspace.rootPath, projectSlug)
    await deps.sessionManager.assertRendererPathAccess(projectPath)
    await deps.sessionManager.assertRendererPathAccess(join(projectPath, 'assets'))
    if (input.sourcePath) await deps.sessionManager.assertRendererPathAccess(input.sourcePath)
    const { uploadProjectAsset } = await import('@craft-agent/shared/projects')
    const asset = uploadProjectAsset(workspace.rootPath, projectSlug, input)
    await broadcastChanged(workspaceId, workspace.rootPath)
    log.info(`Uploaded asset ${asset.filename} to project ${projectSlug}`)
    return asset
  })

  // Delete an asset by filename
  server.handle(RPC_CHANNELS.projects.DELETE_ASSET, async (
    _ctx,
    workspaceId: string,
    projectSlug: string,
    filename: string,
  ) => {
    validateProjectSlug(projectSlug)
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { deleteProjectAsset, sanitizeAssetFilename } = await import('@craft-agent/shared/projects')
    const assetsPath = join(getProjectPath(workspace.rootPath, projectSlug), 'assets')
    await deps.sessionManager.assertRendererPathAccess(assetsPath)
    await deps.sessionManager.assertRendererPathAccess(
      join(assetsPath, sanitizeAssetFilename(filename)),
    )
    deleteProjectAsset(workspace.rootPath, projectSlug, filename)
    await broadcastChanged(workspaceId, workspace.rootPath)
  })
}
