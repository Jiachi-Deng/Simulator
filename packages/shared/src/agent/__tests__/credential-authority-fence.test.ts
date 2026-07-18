import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const temporaryRoots: string[] = []

const moduleUrls = Object.freeze({
  claudeAgent: pathToFileURL(join(import.meta.dir, '..', 'claude-agent.ts')).href,
  piAgent: pathToFileURL(join(import.meta.dir, '..', 'pi-agent.ts')).href,
  storage: pathToFileURL(join(import.meta.dir, '..', '..', 'config', 'storage.ts')).href,
  credentials: pathToFileURL(join(import.meta.dir, '..', '..', 'credentials', 'index.ts')).href,
})

function runIsolatedScenario(source: string): ReturnType<typeof Bun.spawnSync> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'credential-authority-fence-')))
  temporaryRoots.push(root)
  const home = join(root, 'home')
  const config = join(root, 'config')
  mkdirSync(home)

  return Bun.spawnSync([process.execPath, '--eval', source], {
    cwd: join(import.meta.dir, '..', '..', '..', '..', '..'),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CRAFT_CONFIG_DIR: config,
      CREDENTIAL_AUTHORITY_TEST_ROOT: root,
      ANTHROPIC_API_KEY: 'preexisting-parent-marker',
      CLAUDE_CODE_OAUTH_TOKEN: 'preexisting-oauth-marker',
      ANTHROPIC_BASE_URL: 'https://preexisting-parent.invalid',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

function expectScenarioPassed(result: ReturnType<typeof Bun.spawnSync>): void {
  expect(result.exitCode, result.stderr?.toString() ?? '').toBe(0)
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('provider credential authority fences', () => {
  it('Claude postInit asserts the fetched credential before applying or forwarding env', () => {
    const result = runIsolatedScenario(`
      import { mkdirSync } from 'node:fs'
      import { join } from 'node:path'
      const { saveConfig } = await import(${JSON.stringify(moduleUrls.storage)})
      const { getCredentialManager } = await import(${JSON.stringify(moduleUrls.credentials)})
      const { ClaudeAgent } = await import(${JSON.stringify(moduleUrls.claudeAgent)})

      const root = process.env.CREDENTIAL_AUTHORITY_TEST_ROOT
      if (!root) throw new Error('missing isolated root')
      const workspaceRoot = join(root, 'workspace')
      mkdirSync(workspaceRoot)
      const workspace = {
        id: 'workspace-claude-authority',
        name: 'Claude authority workspace',
        rootPath: workspaceRoot,
        createdAt: 1,
        lastUsedAt: 1,
      }
      const connectionSlug = 'claude-authority'
      saveConfig({
        workspaces: [workspace],
        activeWorkspaceId: workspace.id,
        activeSessionId: null,
        llmConnections: [{
          slug: connectionSlug,
          name: 'Claude authority',
          providerType: 'anthropic',
          authType: 'api_key',
          defaultModel: 'claude-sonnet-4-6',
          createdAt: 1,
        }],
        defaultLlmConnection: connectionSlug,
      })

      const credential = 'claude-authority-credential'
      await getCredentialManager().setLlmApiKey(connectionSlug, credential)
      let agent
      let assertionObserved = false
      agent = new ClaudeAgent({
        workspace,
        session: {
          id: 'session-claude-authority',
          workspaceRootPath: workspaceRoot,
          createdAt: 1,
          lastUsedAt: 1,
        },
        isHeadless: true,
        skipConfigWatcher: true,
        connectionSlug,
        providerType: 'anthropic',
        authType: 'api_key',
        envOverrides: { PRESERVED_MARKER: 'preserved' },
        assertCredentialAuthority: async (snapshot) => {
          if (snapshot.kind !== 'api-key' || snapshot.value !== credential) {
            throw new Error('assertion did not receive the fetched credential')
          }
          if (agent.config.envOverrides.ANTHROPIC_API_KEY !== undefined) {
            throw new Error('credential reached per-agent env before assertion')
          }
          if (process.env.ANTHROPIC_API_KEY !== 'preexisting-parent-marker') {
            throw new Error('fenced postInit changed process env before assertion')
          }
          assertionObserved = true
          throw new Error('authority-rejected')
        },
      })

      let rejection
      let postInitResult
      try {
        postInitResult = await agent.postInit()
      } catch (error) {
        rejection = error
      }
      if (!assertionObserved) {
        throw new Error('credential assertion was not invoked: ' + JSON.stringify(postInitResult ?? {
          error: rejection instanceof Error ? rejection.message : String(rejection),
        }))
      }
      if (!(rejection instanceof Error) || rejection.message !== 'authority-rejected') {
        throw new Error('postInit did not propagate authority rejection')
      }
      if (agent.config.envOverrides.PRESERVED_MARKER !== 'preserved'
        || agent.config.envOverrides.ANTHROPIC_API_KEY !== undefined) {
        throw new Error('authority rejection polluted per-agent env')
      }
      if (process.env.ANTHROPIC_API_KEY !== 'preexisting-parent-marker') {
        throw new Error('authority rejection changed process env')
      }
      agent.destroy()
    `)

    expectScenarioPassed(result)
  })

  it('Claude successful assertion confines the fetched credential to per-agent env', () => {
    const result = runIsolatedScenario(`
      import { mkdirSync } from 'node:fs'
      import { join } from 'node:path'
      const { saveConfig } = await import(${JSON.stringify(moduleUrls.storage)})
      const { getCredentialManager } = await import(${JSON.stringify(moduleUrls.credentials)})
      const { ClaudeAgent } = await import(${JSON.stringify(moduleUrls.claudeAgent)})

      const root = process.env.CREDENTIAL_AUTHORITY_TEST_ROOT
      if (!root) throw new Error('missing isolated root')
      const workspaceRoot = join(root, 'workspace')
      mkdirSync(workspaceRoot)
      const workspace = {
        id: 'workspace-claude-success-authority',
        name: 'Claude success authority workspace',
        rootPath: workspaceRoot,
        createdAt: 1,
        lastUsedAt: 1,
      }
      const connectionSlug = 'claude-success-authority'
      saveConfig({
        workspaces: [workspace],
        activeWorkspaceId: workspace.id,
        activeSessionId: null,
        llmConnections: [{
          slug: connectionSlug,
          name: 'Claude success authority',
          providerType: 'anthropic',
          authType: 'api_key',
          defaultModel: 'claude-sonnet-4-6',
          createdAt: 1,
        }],
        defaultLlmConnection: connectionSlug,
      })

      const credential = 'claude-success-authority-credential'
      await getCredentialManager().setLlmApiKey(connectionSlug, credential)
      let agent
      let assertionObserved = false
      agent = new ClaudeAgent({
        workspace,
        session: {
          id: 'session-claude-success-authority',
          workspaceRootPath: workspaceRoot,
          createdAt: 1,
          lastUsedAt: 1,
        },
        isHeadless: true,
        skipConfigWatcher: true,
        connectionSlug,
        providerType: 'anthropic',
        authType: 'api_key',
        envOverrides: { PRESERVED_MARKER: 'preserved' },
        assertCredentialAuthority: async (snapshot) => {
          if (snapshot.kind !== 'api-key' || snapshot.value !== credential) {
            throw new Error('assertion did not receive the fetched credential')
          }
          if (agent.config.envOverrides.ANTHROPIC_API_KEY !== undefined
            || agent.config.envOverrides.CLAUDE_CODE_OAUTH_TOKEN !== undefined
            || agent.config.envOverrides.ANTHROPIC_BASE_URL !== undefined) {
            throw new Error('credential env was applied before assertion')
          }
          if (process.env.ANTHROPIC_API_KEY !== 'preexisting-parent-marker'
            || process.env.CLAUDE_CODE_OAUTH_TOKEN !== 'preexisting-oauth-marker'
            || process.env.ANTHROPIC_BASE_URL !== 'https://preexisting-parent.invalid') {
            throw new Error('fenced postInit changed process env before assertion')
          }
          assertionObserved = true
        },
      })

      const postInitResult = await agent.postInit()
      if (!assertionObserved) throw new Error('credential assertion was not invoked')
      if (postInitResult.authInjected !== true) throw new Error('postInit did not inject agent auth')
      if (agent.config.envOverrides.PRESERVED_MARKER !== 'preserved'
        || agent.config.envOverrides.ANTHROPIC_API_KEY !== credential
        || agent.config.envOverrides.CLAUDE_CODE_OAUTH_TOKEN !== ''
        || agent.config.envOverrides.ANTHROPIC_BASE_URL !== '') {
        throw new Error('successful assertion did not isolate mutually-exclusive agent auth env')
      }
      if (process.env.ANTHROPIC_API_KEY !== 'preexisting-parent-marker'
        || process.env.CLAUDE_CODE_OAUTH_TOKEN !== 'preexisting-oauth-marker'
        || process.env.ANTHROPIC_BASE_URL !== 'https://preexisting-parent.invalid') {
        throw new Error('successful assertion changed process env')
      }
      agent.destroy()
    `)

    expectScenarioPassed(result)
  })

  it('Pi asserts the credential fetched from storage before spawning', () => {
    const result = runIsolatedScenario(`
      import { mkdirSync } from 'node:fs'
      import { join } from 'node:path'
      const { saveConfig } = await import(${JSON.stringify(moduleUrls.storage)})
      const { getCredentialManager } = await import(${JSON.stringify(moduleUrls.credentials)})
      const { PiAgent } = await import(${JSON.stringify(moduleUrls.piAgent)})

      const root = process.env.CREDENTIAL_AUTHORITY_TEST_ROOT
      if (!root) throw new Error('missing isolated root')
      const workspaceRoot = join(root, 'workspace')
      mkdirSync(workspaceRoot)
      const workspace = {
        id: 'workspace-pi-authority',
        name: 'Pi authority workspace',
        rootPath: workspaceRoot,
        createdAt: 1,
        lastUsedAt: 1,
      }
      saveConfig({
        workspaces: [workspace],
        activeWorkspaceId: workspace.id,
        activeSessionId: null,
      })

      const connectionSlug = 'pi-authority'
      const credential = 'pi-authority-access-token'
      await getCredentialManager().setLlmOAuth(connectionSlug, {
        accessToken: credential,
        refreshToken: 'pi-authority-refresh-token',
        expiresAt: 4_102_444_800_000,
      })
      let assertionObserved = false
      const agent = new PiAgent({
        provider: 'pi',
        providerType: 'pi',
        authType: 'oauth',
        connectionSlug,
        runtime: {
          piAuthProvider: 'openai-codex',
          paths: {
            node: process.execPath,
            piServer: join(root, 'must-not-spawn.cjs'),
          },
        },
        workspace,
        session: {
          id: 'session-pi-authority',
          workspaceRootPath: workspaceRoot,
          createdAt: 1,
          lastUsedAt: 1,
        },
        isHeadless: true,
        skipConfigWatcher: true,
        assertCredentialAuthority: async (snapshot) => {
          if (snapshot.kind !== 'oauth-access' || snapshot.accessToken !== credential) {
            throw new Error('assertion did not receive the fetched credential')
          }
          if (agent.subprocess !== null) {
            throw new Error('Pi subprocess existed before credential assertion')
          }
          assertionObserved = true
          throw new Error('authority-rejected')
        },
      })

      let rejection
      try {
        await agent.spawnSubprocess()
      } catch (error) {
        rejection = error
      }
      if (!assertionObserved) throw new Error('credential assertion was not invoked')
      if (!(rejection instanceof Error) || rejection.message !== 'authority-rejected') {
        throw new Error('spawn did not propagate authority rejection')
      }
      if (agent.subprocess !== null) throw new Error('authority rejection spawned Pi')
      agent.destroy()
    `)

    expectScenarioPassed(result)
  })

  it('Pi does not send token_update when refreshed credentials fail authority', () => {
    const result = runIsolatedScenario(`
      import { mkdirSync } from 'node:fs'
      import { join } from 'node:path'
      const { saveConfig } = await import(${JSON.stringify(moduleUrls.storage)})
      const { getCredentialManager } = await import(${JSON.stringify(moduleUrls.credentials)})
      const { PiAgent } = await import(${JSON.stringify(moduleUrls.piAgent)})

      const root = process.env.CREDENTIAL_AUTHORITY_TEST_ROOT
      if (!root) throw new Error('missing isolated root')
      const workspaceRoot = join(root, 'workspace')
      mkdirSync(workspaceRoot)
      const workspace = {
        id: 'workspace-pi-refresh-authority',
        name: 'Pi refresh authority workspace',
        rootPath: workspaceRoot,
        createdAt: 1,
        lastUsedAt: 1,
      }
      saveConfig({
        workspaces: [workspace],
        activeWorkspaceId: workspace.id,
        activeSessionId: null,
      })

      const connectionSlug = 'pi-refresh-authority'
      const refreshedCredential = 'pi-refreshed-access-token'
      await getCredentialManager().setLlmOAuth(connectionSlug, {
        accessToken: refreshedCredential,
        refreshToken: 'pi-refreshed-refresh-token',
        expiresAt: 4_102_444_800_000,
      })
      const sent = []
      let assertionObserved = false
      const agent = new PiAgent({
        provider: 'pi',
        providerType: 'pi',
        authType: 'oauth',
        connectionSlug,
        runtime: { piAuthProvider: 'openai-codex' },
        workspace,
        session: {
          id: 'session-pi-refresh-authority',
          workspaceRootPath: workspaceRoot,
          createdAt: 1,
          lastUsedAt: 1,
        },
        isHeadless: true,
        skipConfigWatcher: true,
        assertCredentialAuthority: async (snapshot) => {
          if (snapshot.kind !== 'oauth-access' || snapshot.accessToken !== refreshedCredential) {
            throw new Error('assertion did not receive refreshed credential')
          }
          assertionObserved = true
          throw new Error('authority-rejected')
        },
      })
      agent.subprocess = {}
      agent.send = (command) => sent.push(command)
      PiAgent.globalRefreshMutex.set(connectionSlug, Promise.resolve())

      let rejection
      try {
        await agent.refreshAndPushTokens()
      } catch (error) {
        rejection = error
      } finally {
        PiAgent.globalRefreshMutex.delete(connectionSlug)
        agent.subprocess = null
      }
      if (!assertionObserved) throw new Error('refreshed credential assertion was not invoked')
      if (!(rejection instanceof Error) || rejection.message !== 'authority-rejected') {
        throw new Error('refresh did not propagate authority rejection')
      }
      if (sent.some((command) => command.type === 'token_update')) {
        throw new Error('authority-rejected credential reached token_update')
      }
      agent.destroy()
    `)

    expectScenarioPassed(result)
  })
})
