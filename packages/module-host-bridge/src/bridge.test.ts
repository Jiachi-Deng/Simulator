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
})
