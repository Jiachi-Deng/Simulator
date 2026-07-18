import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LlmConnection } from '@craft-agent/shared/config'
import { OpenDesignAcceptanceConnectionAdmission } from '../open-design-acceptance-connection-admission'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function connection(slug: string, overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug,
    name: slug,
    providerType: 'pi',
    authType: 'oauth',
    piAuthProvider: 'openai-codex',
    defaultModel: 'gpt-5.6',
    createdAt: 1,
    ...overrides,
  }
}

function jwt(issuer: string, subject: string, nonce = 'a'): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify({ iss: issuer, sub: subject, nonce })).toString('base64url'),
    'signature',
  ].join('.')
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-connection-admission-'))
  roots.push(root)
  const home = join(root, 'home')
  const configRoot = join(root, 'config')
  const userDataRoot = join(root, 'user-data')
  const workspaceRoot = join(root, 'workspace')
  await Promise.all([home, configRoot, userDataRoot, workspaceRoot].map((path) => mkdir(path)))

  const connections = new Map<string, LlmConnection>([
    ['connection-a', connection('connection-a')],
    ['connection-b', connection('connection-b')],
  ])
  type OAuthCredential = {
    accessToken: string
    refreshToken?: string
    idToken?: string
    expiresAt?: number
  }
  const oauth = new Map<string, OAuthCredential>([
    ['connection-a', { accessToken: jwt('issuer', 'account-a') }],
    ['connection-b', { accessToken: jwt('issuer', 'account-b') }],
  ])
  const apiKeys = new Map<string, string>()
  const iamCredentials = new Map<string, {
    accessKeyId: string; secretAccessKey: string; region?: string; sessionToken?: string
  }>()
  const serviceAccounts = new Map<string, {
    serviceAccountJson: string; projectId?: string; region?: string; email?: string
  }>()
  let globalDefault = 'connection-b'
  let workspaceDefault: string | undefined
  let workspaceModel = 'gpt-5.6'
  let activeWorkspaceId = 'workspace'
  const source = {
    getGlobalDefaultConnection: () => globalDefault,
    getConnection: (slug: string) => connections.get(slug) ?? null,
    loadWorkspaceConfig: () => ({
      id: 'workspace', name: 'Workspace', slug: 'workspace', createdAt: 1, updatedAt: 1,
      defaults: {
        ...(workspaceDefault ? { defaultLlmConnection: workspaceDefault } : {}),
        model: workspaceModel,
      },
    }),
    resolveRuntime: (candidate: LlmConnection, model?: string) => ({
      provider: candidate.providerType === 'anthropic' ? 'anthropic' : 'pi',
      authType: candidate.authType,
      resolvedModel: model ?? candidate.defaultModel ?? null,
    }),
  }
  const credentials = {
    hasLlmCredentials: async (slug: string) => {
      switch (connections.get(slug)?.authType) {
        case 'api_key': case 'api_key_with_endpoint': case 'bearer_token': return apiKeys.has(slug)
        case 'iam_credentials': return iamCredentials.has(slug)
        case 'service_account_file': return serviceAccounts.has(slug)
        case 'none': return true
        default: return oauth.has(slug)
      }
    },
    getLlmApiKey: async (slug: string) => apiKeys.get(slug) ?? null,
    getLlmOAuth: async (slug: string) => oauth.get(slug) ?? null,
    getLlmIamCredentials: async (slug: string) => iamCredentials.get(slug) ?? null,
    getLlmServiceAccount: async (slug: string) => serviceAccounts.get(slug) ?? null,
  }
  const admission = new OpenDesignAcceptanceConnectionAdmission({
    sessions: { getWorkspaces: () => [{ id: 'workspace', rootPath: workspaceRoot }] as never },
    resolveWorkspaceId: () => activeWorkspaceId,
    homeRoot: home,
    configRoot,
    userDataRoot,
    source,
    credentials,
  })
  return {
    admission,
    keyA: Buffer.alloc(32, 0x11).toString('base64'),
    keyB: Buffer.alloc(32, 0x22).toString('base64'),
    paths: {
      home: await realpath(home),
      configRoot: await realpath(configRoot),
      userDataRoot: await realpath(userDataRoot),
      workspaceRoot: await realpath(workspaceRoot),
    },
    setGlobalDefault: (slug: string) => { globalDefault = slug },
    setWorkspaceDefault: (slug: string | undefined) => { workspaceDefault = slug },
    setWorkspaceModel: (model: string) => { workspaceModel = model },
    setActiveWorkspace: (id: string) => { activeWorkspaceId = id },
    setCredential: (slug: string, accessToken: string) => { oauth.set(slug, { accessToken }) },
    setOAuth: (slug: string, value: OAuthCredential) => { oauth.set(slug, value) },
    setConnection: (slug: string, value: LlmConnection) => { connections.set(slug, value) },
    setApiKey: (slug: string, value: string) => { apiKeys.set(slug, value) },
    setIam: (slug: string, value: { accessKeyId: string; secretAccessKey: string }) => {
      iamCredentials.set(slug, value)
    },
    setServiceAccount: (slug: string, value: { serviceAccountJson: string }) => {
      serviceAccounts.set(slug, value)
    },
  }
}

describe('OpenDesignAcceptanceConnectionAdmission', () => {
  const approvedRuntime = Object.freeze({
    workspaceId: 'workspace',
    connectionSlug: 'connection-b',
    provider: 'pi' as const,
    authType: 'oauth' as const,
    resolvedModel: 'gpt-5.6',
  })

  it('pins only the effective authenticated Connection and exposes no raw identity', async () => {
    const fixture = await harness()
    const proof = await fixture.admission.getConnectionAuthority({ keyBase64: fixture.keyA })
    expect(proof.authenticated).toBe(true)
    expect(proof.authorityHmacSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(proof)).not.toContain('connection-b')
    expect(JSON.stringify(proof)).not.toContain('account-b')
    expect(JSON.stringify(proof)).not.toContain(fixture.keyA)

    await fixture.admission.armConnectionAdmission({
      keyBase64: fixture.keyA,
      expectedHmacSha256: proof.authorityHmacSha256,
    })
    await expect(fixture.admission.admit('workspace')).resolves.toEqual({
      llmConnection: 'connection-b',
      provider: 'pi',
      authType: 'oauth',
      resolvedModel: 'gpt-5.6',
    })
  })

  it('rejects wrong keys, wrong HMACs, and every unarmed admission', async () => {
    const fixture = await harness()
    await expect(fixture.admission.admit('workspace')).rejects.toThrow('not armed')
    const proof = await fixture.admission.getConnectionAuthority({ keyBase64: fixture.keyA })
    await expect(fixture.admission.armConnectionAdmission({
      keyBase64: fixture.keyB,
      expectedHmacSha256: proof.authorityHmacSha256,
    })).rejects.toThrow('mismatch')
    await expect(fixture.admission.armConnectionAdmission({
      keyBase64: fixture.keyA,
      expectedHmacSha256: '0'.repeat(64),
    })).rejects.toThrow('mismatch')
    await expect(fixture.admission.armConnectionAdmission({
      keyBase64: Buffer.alloc(31).toString('base64'),
      expectedHmacSha256: proof.authorityHmacSha256,
    })).rejects.toThrow('key is invalid')

    await fixture.admission.armConnectionAdmission({
      keyBase64: fixture.keyA,
      expectedHmacSha256: proof.authorityHmacSha256,
    })
    const alternateProof = await fixture.admission.getConnectionAuthority({ keyBase64: fixture.keyB })
    await expect(fixture.admission.armConnectionAdmission({
      keyBase64: fixture.keyB,
      expectedHmacSha256: alternateProof.authorityHmacSha256,
    })).rejects.toThrow('already armed')
    await expect(fixture.admission.armConnectionAdmission({
      keyBase64: fixture.keyA,
      expectedHmacSha256: proof.authorityHmacSha256,
    })).resolves.toEqual({
      schemaVersion: 1, armed: true, authorityHmacSha256: proof.authorityHmacSha256,
    })
  })

  it('fails closed on default, model, credential, or active-workspace drift', async () => {
    const cases: Array<(fixture: Awaited<ReturnType<typeof harness>>) => void> = [
      (fixture) => fixture.setGlobalDefault('connection-a'),
      (fixture) => fixture.setWorkspaceDefault('connection-a'),
      (fixture) => fixture.setWorkspaceModel('gpt-5.6-mini'),
      (fixture) => fixture.setCredential('connection-b', jwt('issuer', 'different-account')),
      (fixture) => fixture.setActiveWorkspace('different-workspace'),
    ]
    for (const drift of cases) {
      const fixture = await harness()
      const proof = await fixture.admission.getConnectionAuthority({ keyBase64: fixture.keyA })
      await fixture.admission.armConnectionAdmission({
        keyBase64: fixture.keyA,
        expectedHmacSha256: proof.authorityHmacSha256,
      })
      drift(fixture)
      await expect(fixture.admission.assertConnection(approvedRuntime)).rejects.toThrow()
    }
  })

  it('binds the full OAuth generation instead of trusting unverified JWT claims', async () => {
    const fixture = await harness()
    fixture.setOAuth('connection-b', {
      accessToken: jwt('issuer', 'access-account-b'),
      idToken: jwt('issuer', 'display-account-a'),
      refreshToken: 'refresh-a',
      expiresAt: 100,
    })
    const proof = await fixture.admission.getConnectionAuthority({ keyBase64: fixture.keyA })
    expect(JSON.stringify(proof)).not.toContain('access-account-b')
    expect(JSON.stringify(proof)).not.toContain('display-account-a')
    expect(JSON.stringify(proof)).not.toContain('refresh-a')
    await fixture.admission.armConnectionAdmission({
      keyBase64: fixture.keyA,
      expectedHmacSha256: proof.authorityHmacSha256,
    })

    const rotations = [
      { accessToken: jwt('issuer', 'access-account-c'), idToken: jwt('issuer', 'display-account-a'), refreshToken: 'refresh-a', expiresAt: 100 },
      { accessToken: jwt('issuer', 'access-account-b'), idToken: jwt('issuer', 'display-account-a'), refreshToken: 'refresh-b', expiresAt: 100 },
      { accessToken: jwt('issuer', 'access-account-b'), idToken: jwt('issuer', 'display-account-c'), refreshToken: 'refresh-a', expiresAt: 100 },
      { accessToken: jwt('issuer', 'access-account-b'), idToken: jwt('issuer', 'display-account-a'), refreshToken: 'refresh-a', expiresAt: 200 },
    ]
    for (const rotated of rotations) {
      fixture.setOAuth('connection-b', rotated)
      await expect(fixture.admission.assertConnection(approvedRuntime)).rejects.toThrow('drifted')
      fixture.setOAuth('connection-b', {
        accessToken: jwt('issuer', 'access-account-b'),
        idToken: jwt('issuer', 'display-account-a'),
        refreshToken: 'refresh-a',
        expiresAt: 100,
      })
    }

    await expect(fixture.admission.assertCredential({
      workspaceId: 'workspace',
      llmConnection: 'connection-b',
      credential: { kind: 'oauth-access', accessToken: jwt('issuer', 'access-account-b') },
    })).resolves.toBeUndefined()
    await expect(fixture.admission.assertCredential({
      workspaceId: 'workspace',
      llmConnection: 'connection-b',
      credential: { kind: 'oauth-access', accessToken: jwt('issuer', 'access-account-c') },
    })).rejects.toThrow('credential mismatch')
  })

  it('keeps API key and IAM identities inside the HMAC and detects rotation', async () => {
    const cases = [
      {
        authType: 'api_key' as const,
        first: 'api-secret-first',
        second: 'api-secret-second',
        set: (fixture: Awaited<ReturnType<typeof harness>>, value: string) => (
          fixture.setApiKey('connection-b', value)
        ),
      },
      {
        authType: 'iam_credentials' as const,
        first: 'iam-secret-first',
        second: 'iam-secret-second',
        set: (fixture: Awaited<ReturnType<typeof harness>>, value: string) => (
          fixture.setIam('connection-b', { accessKeyId: 'AKIAFIXTURE', secretAccessKey: value })
        ),
      },
    ]
    for (const credentialCase of cases) {
      const fixture = await harness()
      fixture.setConnection('connection-b', connection('connection-b', { authType: credentialCase.authType }))
      credentialCase.set(fixture, credentialCase.first)
      const proof = await fixture.admission.getConnectionAuthority({ keyBase64: fixture.keyA })
      expect(JSON.stringify(proof)).not.toContain(credentialCase.first)
      await fixture.admission.armConnectionAdmission({
        keyBase64: fixture.keyA,
        expectedHmacSha256: proof.authorityHmacSha256,
      })
      credentialCase.set(fixture, credentialCase.second)
      await expect(fixture.admission.assertConnection({
        ...approvedRuntime,
        authType: credentialCase.authType,
      })).rejects.toThrow('drifted')
    }
  })

  it('rejects keyless, environment, and unsupported credential types for paid authority', async () => {
    for (const authType of ['none', 'environment', 'service_account_file'] as const) {
      const fixture = await harness()
      fixture.setConnection('connection-b', connection('connection-b', { authType }))
      await expect(fixture.admission.getConnectionAuthority({
        keyBase64: fixture.keyA,
      })).rejects.toThrow()
    }
  })

  it('serializes concurrent arm attempts and preserves the first authority key', async () => {
    const fixture = await harness()
    const proofA = await fixture.admission.getConnectionAuthority({ keyBase64: fixture.keyA })
    const proofB = await fixture.admission.getConnectionAuthority({ keyBase64: fixture.keyB })
    const [first, second] = await Promise.allSettled([
      fixture.admission.armConnectionAdmission({
        keyBase64: fixture.keyA,
        expectedHmacSha256: proofA.authorityHmacSha256,
      }),
      fixture.admission.armConnectionAdmission({
        keyBase64: fixture.keyB,
        expectedHmacSha256: proofB.authorityHmacSha256,
      }),
    ])
    expect(first.status).toBe('fulfilled')
    expect(second.status).toBe('rejected')
    await expect(fixture.admission.armConnectionAdmission({
      keyBase64: fixture.keyA,
      expectedHmacSha256: proofA.authorityHmacSha256,
    })).resolves.toMatchObject({ armed: true })
  })
})
