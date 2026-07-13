import { describe, expect, test } from 'bun:test'
import { ModuleHostBridge } from './bridge.ts'
import {
  FakeApprovalResolver,
  FakeAuditSink,
  FakeClock,
  FakeCredentialAuthority,
  FakeEntropy,
  FakePathAuthority,
  FakeTokenHasher,
  FakeURLAuthority,
} from './testing/fakes.ts'
import type { CapabilityGrantRequest, CapabilityKind, ContractLimits, TrustedTransportContext } from './types.ts'

const trustedContext: TrustedTransportContext = {
  ownerId: 'owner-a',
  moduleId: 'module-a',
  processId: 'process-a',
}

function harness(
  maxUses = 1,
  kind: CapabilityKind = 'notification.send',
  options: {
    paths?: FakePathAuthority
    audit?: FakeAuditSink | { record(): Promise<void> }
    limits?: Partial<ContractLimits>
  } = {},
) {
  const clock = new FakeClock()
  const entropy = new FakeEntropy()
  const hasher = new FakeTokenHasher()
  const paths = options.paths ?? new FakePathAuthority()
  const audit = options.audit ?? new FakeAuditSink()
  const approvals = new FakeApprovalResolver()
  const credentials = new FakeCredentialAuthority()
  const urls = new FakeURLAuthority()
  const bridge = new ModuleHostBridge({
    clock, entropy, hasher, paths, audit, approvals, credentials, urls,
    forbiddenRoots: { filesystemRoot: '/', hostDataRoot: '/host', moduleDataRoot: '/module-data' },
    limits: options.limits,
  })
  const grant = () => bridge.grant({
    descriptor: { kind },
    ownerId: 'owner-a',
    moduleId: 'module-a',
    processId: 'process-a',
    workspaceRoot: '/work/a',
    allowedMethods: [kind],
    expiresAt: clock.now() + 1_000,
    maxUses,
    nonce: 'nonce-a',
  })
  return { bridge, clock, entropy, hasher, paths, audit, approvals, credentials, urls, grant }
}

function request(token: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    type: 'request',
    requestId: 'request-a',
    moduleId: 'self-reported-module',
    processId: 'self-reported-process',
    sessionId: 'session-a',
    turnId: 'turn-a',
    method: 'notification.send',
    capabilityToken: token,
    nonce: 'nonce-a',
    payload: { title: 'Ready', body: 'Done' },
    ...overrides,
  }
}

describe('capability, replay, and execution policy', () => {
  test('returns explicit replay state and a host execution receipt that cannot be claimed twice', async () => {
    const target = harness()
    const { token } = await target.grant()
    const first = await target.bridge.handle(request(token), trustedContext)
    expect(first.replayed).toBe(false)
    expect(first.ok).toBe(true)
    const receiptId = (first.result?.executionReceipt as { receiptId: string }).receiptId

    const replay = await target.bridge.handle(request(token), trustedContext)
    expect(replay.replayed).toBe(true)
    expect(replay.result?.executionReceipt).toEqual({ receiptId, status: 'authorized' })

    const claim = await target.bridge.claimExecution(receiptId, trustedContext)
    expect(claim).toMatchObject({ acquired: true, receipt: { status: 'executing' } })
    expect(await target.bridge.claimExecution(receiptId, trustedContext)).toMatchObject({ acquired: false, receipt: { status: 'executing' } })
    expect((await target.bridge.handle(request(token), trustedContext)).result?.executionReceipt)
      .toEqual({ receiptId, status: 'executing' })

    await target.bridge.completeExecution(receiptId, 'committed', trustedContext)
    expect((await target.bridge.handle(request(token), trustedContext)).result?.executionReceipt)
      .toEqual({ receiptId, status: 'committed' })
    expect(JSON.stringify(target.bridge.snapshot())).not.toContain(token)
  })

  test('rechecks expiry and revoke generation before returning replay', async () => {
    const expired = harness()
    const expiredGrant = await expired.grant()
    const expiredFirst = await expired.bridge.handle(request(expiredGrant.token), trustedContext)
    const expiredReceipt = (expiredFirst.result?.executionReceipt as Record<string, unknown>).receiptId as string
    expect(expiredFirst.ok).toBe(true)
    expired.clock.advance(1_000)
    expect((await expired.bridge.handle(request(expiredGrant.token), trustedContext)).error?.code).toBe('CAPABILITY_EXPIRED')
    await expect(expired.bridge.claimExecution(expiredReceipt, trustedContext)).rejects.toMatchObject({ code: 'CAPABILITY_EXPIRED' })

    const revoked = harness()
    const revokedGrant = await revoked.grant()
    const revokedFirst = await revoked.bridge.handle(request(revokedGrant.token), trustedContext)
    const revokedReceipt = (revokedFirst.result?.executionReceipt as Record<string, unknown>).receiptId as string
    expect(revokedFirst.ok).toBe(true)
    await revoked.bridge.revokeProcess('module-a', 'process-a')
    expect((await revoked.bridge.handle(request(revokedGrant.token), trustedContext)).error?.code).toBe('CAPABILITY_REVOKED')
    await expect(revoked.bridge.claimExecution(revokedReceipt, trustedContext)).rejects.toMatchObject({ code: 'CAPABILITY_REVOKED' })
  })

  test('serializes single-use consumption and rejects replay identity changes', async () => {
    const target = harness()
    const { token } = await target.grant()
    const [first, second] = await Promise.all([
      target.bridge.handle(request(token, { requestId: 'request-1' }), trustedContext),
      target.bridge.handle(request(token, { requestId: 'request-2' }), trustedContext),
    ])
    expect([first.ok, second.ok].sort()).toEqual([false, true])
    expect([first, second].find(item => !item.ok)?.error?.code).toBe('CAPABILITY_EXHAUSTED')

    const replayTarget = harness(2)
    const replayGrant = await replayTarget.grant()
    await replayTarget.bridge.handle(request(replayGrant.token), trustedContext)
    const mismatch = await replayTarget.bridge.handle(request(replayGrant.token, { turnId: 'turn-b' }), trustedContext)
    expect(mismatch.error?.code).toBe('REPLAY_MISMATCH')
  })

  test('fails closed at replay capacity without evicting an authorized identity', async () => {
    const target = harness(3, 'notification.send', { limits: { maxReplayEntries: 1 } })
    const { token } = await target.grant()
    expect((await target.bridge.handle(request(token), trustedContext)).ok).toBe(true)
    const atCapacity = await target.bridge.handle(request(token, { requestId: 'request-b' }), trustedContext)
    expect(atCapacity.error?.code).toBe('REPLAY_CAPACITY')
    const replay = await target.bridge.handle(request(token), trustedContext)
    expect(replay).toMatchObject({ ok: true, replayed: true })
  })

  test('binds grants, receipts, and replay capacity to the complete trusted principal', async () => {
    const target = harness(3, 'notification.send', { limits: { maxReplayEntries: 1 } })
    const ownerB = { ...trustedContext, ownerId: 'owner-b' }
    const ownerAGrant = await target.grant()
    const first = await target.bridge.handle(request(ownerAGrant.token, { requestId: 'shared-request' }), trustedContext)
    const receiptId = (first.result?.executionReceipt as { receiptId: string }).receiptId

    await expect(target.bridge.claimExecution(receiptId, ownerB)).rejects.toMatchObject({ code: 'EXECUTION_RECEIPT_NOT_FOUND' })
    const wrongOwner = await target.bridge.handle(request(ownerAGrant.token, { requestId: 'wrong-owner' }), ownerB)
    expect(wrongOwner.error?.code).toBe('CAPABILITY_SCOPE_MISMATCH')

    const ownerBGrant = await target.bridge.grant({
      descriptor: { kind: 'notification.send' }, ownerId: 'owner-b', moduleId: 'module-a', processId: 'process-a',
      workspaceRoot: '/work/a', allowedMethods: ['notification.send'], expiresAt: 2_000, maxUses: 3, nonce: 'nonce-a',
    })
    const second = await target.bridge.handle(request(ownerBGrant.token, { requestId: 'shared-request' }), ownerB)
    expect(second).toMatchObject({ ok: true, replayed: false })
    expect(target.bridge.snapshot().replayEntries).toBe(2)
  })

  test('keeps a live receipt replay entry and reclaims only a terminal entry after capability revocation', async () => {
    const target = harness(3, 'notification.send', { limits: { maxReplayEntries: 1 } })
    const firstGrant = await target.grant()
    const first = await target.bridge.handle(request(firstGrant.token), trustedContext)
    const receiptId = (first.result?.executionReceipt as { receiptId: string }).receiptId
    await target.bridge.claimExecution(receiptId, trustedContext)
    await target.bridge.revokeProcess('module-a', 'process-a')

    const renewedGrant = await target.grant()
    const blocked = await target.bridge.handle(request(renewedGrant.token, { requestId: 'request-b' }), trustedContext)
    expect(blocked.error?.code).toBe('REPLAY_CAPACITY')

    await target.bridge.completeExecution(receiptId, 'committed', trustedContext)
    const reclaimed = await target.bridge.handle(request(renewedGrant.token, { requestId: 'request-b' }), trustedContext)
    expect(reclaimed).toMatchObject({ ok: true, replayed: false })
  })

  test('uses trusted transport identity instead of envelope claims and binds nonce', async () => {
    const target = harness(2)
    const { token } = await target.grant()
    expect((await target.bridge.handle(request(token), trustedContext)).ok).toBe(true)

    const wrongTransport = await target.bridge.handle(request(token, { requestId: 'wrong-transport' }), {
      ...trustedContext,
      moduleId: 'module-b',
    })
    expect(wrongTransport.error?.code).toBe('CAPABILITY_SCOPE_MISMATCH')

    const wrongNonce = await target.bridge.handle(request(token, { requestId: 'wrong-nonce', nonce: 'nonce-b' }), trustedContext)
    expect(wrongNonce.error?.code).toBe('CAPABILITY_SCOPE_MISMATCH')
  })

  test('requires descriptor kind and allowed methods to match exactly', async () => {
    const target = harness()
    await expect(target.bridge.grant({
      descriptor: { kind: 'notification.send' }, ownerId: 'owner-a',
      moduleId: 'module-a', processId: 'process-a', workspaceRoot: '/work/a',
      allowedMethods: ['notification.send', 'external.open'], expiresAt: 2_000, maxUses: 1, nonce: 'nonce',
    })).rejects.toThrow('exactly match')
    await expect(target.bridge.grant({
      descriptor: { kind: 'notification.send' }, ownerId: 'owner-a',
      moduleId: 'module-a', processId: 'process-a', workspaceRoot: '/work/a',
      allowedMethods: ['external.open'], expiresAt: 2_000, maxUses: 1, nonce: 'nonce',
    })).rejects.toThrow('exactly match')
    const nonCanonical = {
      descriptor: { kind: 'notification.send ' }, ownerId: 'owner-a', moduleId: 'module-a', processId: 'process-a',
      workspaceRoot: '/work/a', allowedMethods: ['notification.send '], expiresAt: 2_000, maxUses: 1, nonce: 'nonce',
    } as unknown as CapabilityGrantRequest
    await expect(target.bridge.grant(nonCanonical)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
  })
})

describe('injected authorities', () => {
  test('validates opaque credential handle owner, module, process, and operation', async () => {
    const target = harness(2, 'credential.use')
    target.credentials.allow({
      opaqueHandle: 'opaque-credential-123',
      ownerId: 'owner-a',
      moduleId: 'module-a',
      processId: 'process-a',
      operation: 'sign',
    })
    const { token } = await target.grant()
    const allowed = await target.bridge.handle(methodRequest(token, 'credential.use', {
      credentialHandle: 'opaque-credential-123', operation: 'sign', arguments: { secretProbe: 'do-not-persist' },
    }), trustedContext)
    expect(allowed.ok).toBe(true)
    expect(JSON.stringify({ snapshot: target.bridge.snapshot(), audit: (target.audit as FakeAuditSink).events }))
      .not.toContain('opaque-credential-123')

    const denied = await target.bridge.handle(methodRequest(token, 'credential.use', {
      credentialHandle: 'opaque-credential-123', operation: 'delete',
    }, 'credential-denied'), trustedContext)
    expect(denied.error?.code).toBe('CREDENTIAL_DENIED')
  })

  test.each(['external.open', 'oauth.launch'] as const)('%s uses injected scheme and origin policy', async method => {
    const target = harness(2, method)
    target.urls.allowOrigin('https://allowed.example')
    const { token } = await target.grant()
    const allowedPayload = method === 'external.open'
      ? { url: 'https://allowed.example/path' }
      : { provider: 'example', authorizationUrl: 'https://allowed.example/oauth', callbackNonce: 'callback' }
    const allowed = await target.bridge.handle(methodRequest(token, method, allowedPayload), trustedContext)
    expect(allowed.result?.normalizedUrl).toStartWith('https://allowed.example/')

    const deniedPayload = method === 'external.open'
      ? { url: 'file:///etc/passwd' }
      : { provider: 'example', authorizationUrl: 'https://denied.example/oauth', callbackNonce: 'callback' }
    const denied = await target.bridge.handle(methodRequest(token, method, deniedPayload, `${method}-denied`), trustedContext)
    expect(denied.error?.code).toBe('URL_DENIED')
  })
})

describe('path authority contract', () => {
  test('returns canonicalPath and realPath consistently and denies symlink escape', async () => {
    const target = harness(2, 'path.authorize')
    target.paths.map('/work/a/alias', '/work/a/canonical.txt', '/work/a/real.txt')
    target.paths.map('/work/a/link/missing.txt', '/work/a/link/missing.txt', '/outside/target/missing.txt')
    const { token } = await target.grant()
    const allowed = await target.bridge.handle(methodRequest(token, 'path.authorize', {
      path: '/work/a/alias', operations: ['read'],
    }), trustedContext)
    expect(allowed.result).toMatchObject({ canonicalPath: '/work/a/canonical.txt', realPath: '/work/a/real.txt' })
    const escaped = await target.bridge.handle(methodRequest(token, 'path.authorize', {
      path: '/work/a/link/missing.txt', operations: ['create'],
    }, 'symlink-ancestor'), trustedContext)
    expect(escaped.error?.code).toBe('PATH_DENIED')
  })

  test('fake models Windows drives, UNC roots, case policy, and nonexistent mappings', async () => {
    const insensitive = new FakePathAuthority({ caseSensitive: false })
    expect(insensitive.isEqualOrWithin('c:\\Work\\A\\File.txt', 'C:\\work\\a')).toBe(true)
    expect(insensitive.isEqualOrWithin('\\\\Server\\Share\\Folder\\File', '\\\\server\\share\\folder')).toBe(true)
    expect(insensitive.isEqualOrWithin('C:\\work\\ab', 'C:\\work\\a')).toBe(false)
    insensitive.map('missing-child', 'C:\\work\\a\\missing', 'C:\\work\\a\\missing')
    expect(await insensitive.resolve('missing-child')).toEqual({
      canonicalPath: 'C:/work/a/missing',
      realPath: 'C:/work/a/missing',
    })
  })

  test.each(['/host', '/host/secret', '/module-data', '/module-data/cache'])('denies protected root %s', async protectedPath => {
    const target = harness(1, 'path.authorize')
    target.paths.map('/work/a/alias', '/work/a/alias', protectedPath)
    const { token } = await target.grant()
    const response = await target.bridge.handle(methodRequest(token, 'path.authorize', {
      path: '/work/a/alias', operations: ['read'],
    }), trustedContext)
    expect(response.error?.code).toBe('PATH_DENIED')
  })
})

describe('approval lifecycle', () => {
  test.each(['module', 'process', 'all'] as const)('%s revoke cancels pending approval and ignores late resolver', async mode => {
    const target = harness(1, 'approval.request')
    const { token } = await target.grant()
    const response = await target.bridge.handle(methodRequest(token, 'approval.request', {
      prompt: 'Approve operation?', expiresAt: 1_500,
    }), trustedContext)
    const approvalId = response.result?.approvalId as string
    if (mode === 'module') await target.bridge.revokeModule('module-a')
    if (mode === 'process') await target.bridge.revokeProcess('module-a', 'process-a')
    if (mode === 'all') await target.bridge.revokeAll()
    target.approvals.approve()
    await flush()
    expect(target.bridge.getApproval(approvalId)?.status).toBe('cancelled')
    expect(target.bridge.snapshot().pendingApprovals).toBe(0)
  })

  test.each(['cancel', 'timeout', 'restart'] as const)('%s ignores later approval completion', async mode => {
    const target = harness(1, 'approval.request')
    const { token } = await target.grant()
    const response = await target.bridge.handle(methodRequest(token, 'approval.request', {
      prompt: 'Approve operation?', expiresAt: 1_200,
    }), trustedContext)
    const approvalId = response.result?.approvalId as string
    if (mode === 'cancel') await target.bridge.cancelApproval(approvalId)
    if (mode === 'timeout') {
      target.clock.advance(200)
      await target.bridge.sweepExpired()
    }
    if (mode === 'restart') await target.bridge.restartProcess('module-a', 'process-a')
    target.approvals.approve()
    await flush()
    expect(target.bridge.getApproval(approvalId)?.status).toBe(mode === 'timeout' ? 'timed_out' : 'cancelled')
  })

  test('capability expiry cancels its bound approval before a late resolver can approve it', async () => {
    const target = harness(1, 'approval.request')
    const { token } = await target.bridge.grant({
      descriptor: { kind: 'approval.request' }, ownerId: 'owner-a', moduleId: 'module-a', processId: 'process-a',
      workspaceRoot: '/work/a', allowedMethods: ['approval.request'], expiresAt: 1_050, maxUses: 1, nonce: 'nonce-a',
    })
    const response = await target.bridge.handle(methodRequest(token, 'approval.request', {
      prompt: 'Approve operation?', expiresAt: 2_000,
    }), trustedContext)
    const approvalId = response.result?.approvalId as string

    target.clock.advance(50)
    expect(await target.bridge.sweepExpired()).toEqual({ capabilities: 1, approvals: 1 })
    expect(target.bridge.getApproval(approvalId)).toMatchObject({ status: 'cancelled' })
    target.approvals.approve()
    await flush()
    expect(target.bridge.getApproval(approvalId)).toMatchObject({ status: 'cancelled' })
  })
})

describe('audit isolation and malformed input', () => {
  test('a hanging audit sink cannot block the global policy tail and its queue stays bounded', async () => {
    const received: string[] = []
    const clock = new FakeClock()
    const bridge = new ModuleHostBridge({
      clock,
      entropy: new FakeEntropy(),
      hasher: new FakeTokenHasher(),
      paths: new FakePathAuthority(),
      credentials: new FakeCredentialAuthority(),
      urls: new FakeURLAuthority(),
      approvals: new FakeApprovalResolver(),
      audit: { record: event => { received.push(event.eventId); return new Promise<void>(() => {}) } },
      forbiddenRoots: { filesystemRoot: '/', hostDataRoot: '/host', moduleDataRoot: '/module-data' },
      limits: { maxAuditQueue: 2, auditSinkTimeoutMs: 5 },
    })
    const grant = await bridge.grant({
      descriptor: { kind: 'notification.send' }, ownerId: 'owner-a', moduleId: 'module-a', processId: 'process-a', workspaceRoot: '/work/a',
      allowedMethods: ['notification.send'], expiresAt: 2_000, maxUses: 4, nonce: 'nonce-a',
    })
    const response = await Promise.race([
      bridge.handle(request(grant.token), trustedContext),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('policy tail blocked')), 50)),
    ])
    expect(response.ok).toBe(true)
    await bridge.revokeAll()
    await bridge.flushAudit()
    expect(received.length).toBeLessThanOrEqual(3)
  })

  test('audits malformed requests as untrusted without accepting envelope identity', async () => {
    const target = harness()
    const response = await target.bridge.handle({ requestId: 'bad', moduleId: 'forged' }, trustedContext)
    expect(response.error?.code).toBe('INVALID_REQUEST')
    await target.bridge.flushAudit()
    const event = target.bridge.snapshot().auditEvents.at(-1)
    expect(event).toMatchObject({
      event: 'request.malformed',
      payload: { trust: 'untrusted', source: 'object', moduleId: 'module-a', processId: 'process-a' },
    })
    expect(JSON.stringify(event)).not.toContain('forged')
  })
})

function methodRequest(
  token: string,
  method: CapabilityKind,
  payload: Record<string, unknown>,
  requestId = 'request-a',
) {
  return request(token, { requestId, method, payload })
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}
