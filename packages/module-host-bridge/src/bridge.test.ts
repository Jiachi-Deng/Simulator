import { describe, expect, test } from 'bun:test'
import { ModuleHostBridge } from './bridge.ts'
import { FakeApprovalResolver, FakeAuditSink, FakeClock, FakeEntropy, FakePathAuthority, FakeTokenHasher } from './testing/fakes.ts'
import type { CapabilityKind } from './types.ts'

function harness(maxUses = 1, kind: CapabilityKind = 'notification.send') {
  const clock = new FakeClock()
  const entropy = new FakeEntropy()
  const hasher = new FakeTokenHasher()
  const paths = new FakePathAuthority()
  const audit = new FakeAuditSink()
  const approvals = new FakeApprovalResolver()
  const bridge = new ModuleHostBridge({
    clock, entropy, hasher, paths, audit, approvals,
    forbiddenRoots: { filesystemRoot: '/', hostDataRoot: '/host', moduleDataRoot: '/module-data' },
  })
  const grant = () => bridge.grant({
    descriptor: { kind },
    moduleId: 'module-a',
    processId: 'process-a',
    workspaceRoot: '/work/a',
    allowedMethods: [kind],
    expiresAt: clock.now() + 1_000,
    maxUses,
    nonce: 'nonce-a',
  })
  return { bridge, clock, entropy, hasher, paths, audit, approvals, grant }
}

function request(token: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    type: 'request',
    requestId: 'request-a',
    moduleId: 'module-a',
    processId: 'process-a',
    sessionId: 'session-a',
    turnId: 'turn-a',
    method: 'notification.send',
    capabilityToken: token,
    payload: { title: 'Ready', body: 'Done' },
    ...overrides,
  }
}

describe('capability policy', () => {
  test('stores only a hash and returns an idempotent response', async () => {
    const { bridge, grant } = harness()
    const { token } = await grant()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    const first = await bridge.handle(request(token))
    const replay = await bridge.handle(request(token))
    expect(first).toEqual(replay)
    expect(first.ok).toBe(true)
    expect(JSON.stringify(bridge.snapshot())).not.toContain(token)
  })

  test('permits only one concurrent consumption of a single-use token', async () => {
    const { bridge, grant } = harness()
    const { token } = await grant()
    const [first, second] = await Promise.all([
      bridge.handle(request(token, { requestId: 'request-1' })),
      bridge.handle(request(token, { requestId: 'request-2' })),
    ])
    expect([first.ok, second.ok].sort()).toEqual([false, true])
    expect([first, second].find(item => !item.ok)?.error?.code).toBe('CAPABILITY_EXHAUSTED')
  })

  test('rejects replay identity changes', async () => {
    const { bridge, grant } = harness(2)
    const { token } = await grant()
    expect((await bridge.handle(request(token))).ok).toBe(true)
    const mismatch = await bridge.handle(request(token, { processId: 'process-b' }))
    expect(mismatch.error?.code).toBe('REPLAY_MISMATCH')
  })

  test('rejects expired and cross-module or cross-process use', async () => {
    const expired = harness()
    const expiredGrant = await expired.grant()
    expired.clock.advance(1_000)
    expect((await expired.bridge.handle(request(expiredGrant.token))).error?.code).toBe('CAPABILITY_EXPIRED')

    const scoped = harness(3)
    const scopedGrant = await scoped.grant()
    expect((await scoped.bridge.handle(request(scopedGrant.token, { requestId: 'cross-module', moduleId: 'module-b' }))).error?.code)
      .toBe('CAPABILITY_SCOPE_MISMATCH')
    expect((await scoped.bridge.handle(request(scopedGrant.token, { requestId: 'cross-process', processId: 'process-b' }))).error?.code)
      .toBe('CAPABILITY_SCOPE_MISMATCH')
  })

  test('authorizes paths only from PathAuthority real paths inside the workspace', async () => {
    const direct = harness(3, 'path.authorize')
    const directGrant = await direct.grant()
    const valid = await direct.bridge.handle(methodRequest(directGrant.token, 'path.authorize', {
      path: '/work/a/file.txt', operations: ['read'],
    }, 'valid-path'))
    expect(valid.result?.canonicalPath).toBe('/work/a/file.txt')

    const outside = await direct.bridge.handle(methodRequest(directGrant.token, 'path.authorize', {
      path: '/outside/file.txt', operations: ['read'],
    }, 'outside-path'))
    expect(outside.error?.code).toBe('PATH_DENIED')

    direct.paths.map('/work/a/link', '/work/a/link', '/outside/secret')
    const symlink = await direct.bridge.handle(methodRequest(directGrant.token, 'path.authorize', {
      path: '/work/a/link', operations: ['read'],
    }, 'symlink-path'))
    expect(symlink.error?.code).toBe('PATH_DENIED')
  })

  test.each(['/host', '/host/secret', '/module-data', '/module-data/cache'])('denies protected root %s', async protectedPath => {
    const target = harness(1, 'path.authorize')
    target.paths.map('/work/a/alias', '/work/a/alias', protectedPath)
    const { token } = await target.grant()
    const response = await target.bridge.handle(methodRequest(token, 'path.authorize', {
      path: '/work/a/alias', operations: ['read'],
    }))
    expect(response.error?.code).toBe('PATH_DENIED')
  })

  test('rejects filesystem, host-data, and module-data workspace roots', async () => {
    for (const root of ['/', '/host', '/module-data']) {
      const target = harness()
      await expect(target.bridge.grant({
        descriptor: { kind: 'notification.send' }, moduleId: 'm', processId: 'p', workspaceRoot: root,
        allowedMethods: ['notification.send'], expiresAt: target.clock.now() + 1_000, maxUses: 1, nonce: 'n',
      })).rejects.toMatchObject({ code: 'PATH_DENIED' })
    }
  })

  test('supports each declared capability method and leaves host-agent opaque unsupported', async () => {
    const payloads: Record<CapabilityKind, Record<string, unknown>> = {
      'folder.pick': { suggestedRoot: '/work/a' },
      'path.authorize': { path: '/work/a/file', operations: ['read'] },
      'file.export': { sourcePath: '/work/a/file', suggestedName: 'file.txt' },
      'external.open': { url: 'https://example.test' },
      'oauth.launch': { provider: 'example', authorizationUrl: 'https://example.test/oauth', callbackNonce: 'callback' },
      'credential.use': { credentialHandle: 'credential-handle', operation: 'sign' },
      'approval.request': { prompt: 'Continue?', expiresAt: 1_500 },
      'notification.send': { title: 'Ready', body: 'Done' },
      'artifact.publish': { artifactPath: '/work/a/file', mediaType: 'text/plain', displayName: 'File' },
    }
    for (const method of Object.keys(payloads) as CapabilityKind[]) {
      const target = harness(1, method)
      const { token } = await target.grant()
      expect((await target.bridge.handle(methodRequest(token, method, payloads[method]))).ok).toBe(true)
    }
    const target = harness()
    await expect(target.bridge.grant({
      descriptor: { kind: 'host-agent.opaque', version: 1, opaque: { future: true } },
      moduleId: 'm', processId: 'p', workspaceRoot: '/work/a', allowedMethods: ['notification.send'],
      expiresAt: 2_000, maxUses: 1, nonce: 'n',
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
  })

  test('revokes module, process, all, and crashed process capabilities', async () => {
    for (const mode of ['module', 'process', 'all', 'crash'] as const) {
      const target = harness()
      const { token } = await target.grant()
      if (mode === 'module') expect(await target.bridge.revokeModule('module-a')).toBe(1)
      if (mode === 'process') expect(await target.bridge.revokeProcess('module-a', 'process-a')).toBe(1)
      if (mode === 'all') expect(await target.bridge.revokeAll()).toBe(1)
      if (mode === 'crash') await target.bridge.restartProcess('module-a', 'process-a')
      expect((await target.bridge.handle(request(token, { requestId: `after-${mode}` }))).error?.code).toBe('CAPABILITY_REVOKED')
    }
  })

  test('credential contract exposes only opaque handle and operation and redacts audit state', async () => {
    const target = harness(1, 'credential.use')
    const { token } = await target.grant()
    const response = await target.bridge.handle(methodRequest(token, 'credential.use', {
      credentialHandle: 'opaque-credential-123', operation: 'sign', arguments: { secretProbe: 'must-not-persist' },
    }))
    expect(response.result).toEqual({
      authorized: true, method: 'credential.use', credentialHandle: 'opaque-credential-123', operation: 'sign',
    })
    const persisted = JSON.stringify({ snapshot: target.bridge.snapshot(), events: target.audit.events })
    expect(persisted).not.toContain(token)
    expect(persisted).not.toContain('opaque-credential-123')
    expect(persisted).not.toContain('must-not-persist')
    expect(persisted).not.toContain('/work/a')
    expect(persisted).not.toContain('nonce-a')
  })

  test('bounds audit history', async () => {
    const clock = new FakeClock()
    const audit = new FakeAuditSink()
    const bridge = new ModuleHostBridge({
      clock, entropy: new FakeEntropy(), hasher: new FakeTokenHasher(), paths: new FakePathAuthority(), audit,
      approvals: new FakeApprovalResolver(),
      forbiddenRoots: { filesystemRoot: '/', hostDataRoot: '/host', moduleDataRoot: '/module-data' },
      limits: { maxAuditEvents: 2 },
    })
    const { token } = await bridge.grant({
      descriptor: { kind: 'notification.send' }, moduleId: 'module-a', processId: 'process-a', workspaceRoot: '/work/a',
      allowedMethods: ['notification.send'], expiresAt: 2_000, maxUses: 1, nonce: 'nonce',
    })
    await bridge.handle(request(token))
    await bridge.handle(request('f'.repeat(64), { requestId: 'denied' }))
    expect(bridge.snapshot().auditEvents).toHaveLength(2)
    expect(audit.events.length).toBeGreaterThan(2)
  })
})

describe('approval state machine', () => {
  test('binds resolver input to module, process, session, turn, and request', async () => {
    const target = harness(1, 'approval.request')
    const { token } = await target.grant()
    const response = await target.bridge.handle(methodRequest(token, 'approval.request', {
      prompt: 'Approve operation?', expiresAt: 1_500,
    }))
    expect(response.result?.status).toBe('pending')
    expect(target.approvals.pending[0]?.input).toMatchObject({
      moduleId: 'module-a', processId: 'process-a', sessionId: 'session-a', turnId: 'turn-a', requestId: 'request-a',
    })
    target.approvals.approve()
    await flush()
    expect(target.bridge.getApproval(response.result?.approvalId as string)?.status).toBe('approved')
  })

  test.each(['cancel', 'timeout', 'restart'] as const)('%s ignores later resolver completion with zero authorized side effects', async mode => {
    const target = harness(1, 'approval.request')
    const { token } = await target.grant()
    const response = await target.bridge.handle(methodRequest(token, 'approval.request', {
      prompt: 'Approve operation?', expiresAt: 1_200,
    }))
    const approvalId = response.result?.approvalId as string
    if (mode === 'cancel') await target.bridge.cancelApproval(approvalId)
    if (mode === 'timeout') {
      target.clock.advance(200)
      await target.bridge.sweepExpired()
    }
    if (mode === 'restart') await target.bridge.restartProcess('module-a', 'process-a')
    target.approvals.approve()
    await flush()
    const expected = mode === 'timeout' ? 'timed_out' : 'cancelled'
    expect(target.bridge.getApproval(approvalId)?.status).toBe(expected)
    expect(target.bridge.snapshot().pendingApprovals).toBe(0)
  })

  test('rejects already-expired approval before resolver invocation or token consumption', async () => {
    const target = harness(1, 'approval.request')
    const { token } = await target.grant()
    const expired = await target.bridge.handle(methodRequest(token, 'approval.request', {
      prompt: 'Too late', expiresAt: target.clock.now(),
    }, 'expired-approval'))
    expect(expired.error?.code).toBe('INVALID_REQUEST')
    expect(target.approvals.pending).toHaveLength(0)
    const valid = await target.bridge.handle(methodRequest(token, 'approval.request', {
      prompt: 'Still available', expiresAt: target.clock.now() + 100,
    }, 'valid-approval'))
    expect(valid.ok).toBe(true)
  })
})

function methodRequest(token: string, method: CapabilityKind, payload: Record<string, unknown>, requestId = 'request-a') {
  return request(token, { requestId, method, payload })
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}
