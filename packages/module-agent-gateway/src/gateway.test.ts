import { describe, expect, it } from 'bun:test'
import { ModuleAgentGateway } from './gateway.ts'
import { ModuleAgentGatewayError, type ModuleAgentAuthorization, type ModuleAgentGrantSpec } from './types.ts'
import {
  DeterministicModuleAgentTokenSource,
  FakeModuleAgentSessionPort,
  MemoryModuleAgentPathAuthority,
} from './testing.ts'

function setup(overrides: {
  now?: number
  maxReplayEvents?: number
  maxEventTextLength?: number
  maxSessionsPerGrant?: number
} = {}) {
  let now = overrides.now ?? 1_000
  const port = new FakeModuleAgentSessionPort()
  const paths = new MemoryModuleAgentPathAuthority()
  const gateway = new ModuleAgentGateway({
    port,
    pathAuthority: paths,
    tokenSource: new DeterministicModuleAgentTokenSource(),
    clock: { now: () => now },
    limits: {
      ...(overrides.maxReplayEvents ? { maxReplayEvents: overrides.maxReplayEvents } : {}),
      ...(overrides.maxEventTextLength ? { maxEventTextLength: overrides.maxEventTextLength } : {}),
      ...(overrides.maxSessionsPerGrant ? { maxSessionsPerGrant: overrides.maxSessionsPerGrant } : {}),
    },
  })
  const spec: ModuleAgentGrantSpec = {
    ownerId: 'owner-1',
    moduleId: 'open-design',
    launchId: 'launch-1',
    lifecycleId: 'lifecycle-1',
    workspaceId: 'workspace-1',
    workspaceRoot: '/craft/workspace',
    authorizedWorkingRoot: '/module/projects/design-1',
    defaultWorkingDirectory: '/module/projects/design-1',
    expiresAt: now + 60_000,
  }
  return { gateway, port, spec, advance: (milliseconds: number) => { now += milliseconds } }
}

async function grantAndSession(setupResult: ReturnType<typeof setup>) {
  const grant = await setupResult.gateway.issueGrant(setupResult.spec)
  const auth: ModuleAgentAuthorization = { grantToken: grant.grantToken, ...setupResult.spec }
  const session = await setupResult.gateway.createSession(auth, { contractVersion: 1 })
  return { grant, auth, session }
}

describe('ModuleAgentGateway', () => {
  it('renews a live launch grant before its original expiry', async () => {
    const state = setup()
    const grant = await state.gateway.issueGrant(state.spec)
    const auth: ModuleAgentAuthorization = { grantToken: grant.grantToken, ...state.spec }
    state.advance(59_000)
    const renewed = state.gateway.renewGrant(grant.grantToken, state.spec.expiresAt + 60_000)
    expect(renewed.expiresAt).toBe(state.spec.expiresAt + 60_000)
    state.advance(2_000)
    expect(state.gateway.getCapabilities(auth).capability).toBe('host-agent.use')
  })

  it('cannot renew or resurrect an already expired launch grant', async () => {
    const state = setup()
    const grant = await state.gateway.issueGrant(state.spec)
    const auth: ModuleAgentAuthorization = { grantToken: grant.grantToken, ...state.spec }
    state.advance(60_001)
    expect(() => state.gateway.renewGrant(grant.grantToken, state.spec.expiresAt + 60_000))
      .toThrow(expect.objectContaining({ code: 'GRANT_EXPIRED' }))
    expect(() => state.gateway.getCapabilities(auth))
      .toThrow(expect.objectContaining({ code: 'GRANT_EXPIRED' }))
  })

  it('creates a hidden Host session with no raw session or connection identifier in the response', async () => {
    const state = setup()
    const { auth, session } = await grantAndSession(state)

    expect(session.sessionHandle).toMatch(/^session_[0-9a-f]{32}$/)
    expect(JSON.stringify(session)).not.toContain('raw-1')
    expect(JSON.stringify(session)).not.toContain('llmConnection')
    expect(state.port.created).toEqual([{
      workspaceId: 'workspace-1',
      workspaceRoot: '/craft/workspace',
      authorizedWorkingRoot: '/module/projects/design-1',
      workingDirectory: '/module/projects/design-1',
    }])
    expect(state.gateway.getCapabilities(auth).capability).toBe('host-agent.use')
  })

  it('rejects forged launch identity and workspace escape', async () => {
    const state = setup()
    const grant = await state.gateway.issueGrant(state.spec)
    const auth: ModuleAgentAuthorization = { grantToken: grant.grantToken, ...state.spec }

    expect(() => state.gateway.getCapabilities({ ...auth, launchId: 'forged' })).toThrow(ModuleAgentGatewayError)
    await expect(state.gateway.createSession(auth, {
      contractVersion: 1,
      workingDirectory: '/module/projects/other',
    })).rejects.toMatchObject({ code: 'WORKSPACE_DENIED' })
    expect(state.port.created).toHaveLength(0)
  })

  it('enforces a single active turn and accepts another only after terminal completion', async () => {
    const state = setup()
    const { auth, session } = await grantAndSession(state)
    const first = await state.gateway.startTurn(auth, session.sessionHandle, { contractVersion: 1, prompt: 'Create a page' })
    await expect(state.gateway.startTurn(auth, session.sessionHandle, { contractVersion: 1, prompt: 'Second' }))
      .rejects.toMatchObject({ code: 'TURN_ACTIVE' })

    state.port.emit({ type: 'turn.completed', sessionId: 'raw-1', finalText: 'done' })
    const second = await state.gateway.startTurn(auth, session.sessionHandle, { contractVersion: 1, prompt: 'Revise it' })
    expect(second.turnId).not.toBe(first.turnId)
    expect(state.port.sent).toHaveLength(2)
  })

  it('publishes only bounded provider-neutral events and bounded replay', async () => {
    const state = setup({ maxReplayEvents: 3, maxEventTextLength: 5 })
    const { auth, session } = await grantAndSession(state)
    await state.gateway.startTurn(auth, session.sessionHandle, { contractVersion: 1, prompt: 'Create' })
    state.port.emit({ type: 'message.delta', sessionId: 'raw-1', delta: '123456789' })
    state.port.emit({ type: 'activity', sessionId: 'raw-1', phase: 'started', kind: 'tool', label: 'write_file_secret' })
    state.port.emit({ type: 'message.completed', sessionId: 'raw-1', text: 'abcdefghij' })
    state.port.emit({ type: 'turn.completed', sessionId: 'raw-1', finalText: 'abcdefghij' })

    expect(() => state.gateway.subscribe(auth, session.sessionHandle, 0, () => undefined))
      .toThrow(expect.objectContaining({ code: 'REPLAY_TRUNCATED' }))

    const events: unknown[] = []
    const subscription = state.gateway.subscribe(auth, session.sessionHandle, 3, (event) => events.push(event))
    expect(subscription.earliestSequence).toBe(4)
    expect(subscription.replayTruncated).toBe(false)
    expect(events).toHaveLength(3)
    expect(JSON.stringify(events)).not.toContain('raw-1')
    expect(JSON.stringify(events)).not.toContain('123456')
    expect(JSON.stringify(events)).toContain('abcde')
  })

  it('cancels active work and revokes all sessions without leaks', async () => {
    const state = setup()
    const { grant, auth, session } = await grantAndSession(state)
    await state.gateway.startTurn(auth, session.sessionHandle, { contractVersion: 1, prompt: 'Create' })
    expect(state.gateway.debugSnapshot()).toMatchObject({ activeGrants: 1, activeSessions: 1, activeTurns: 1 })

    await state.gateway.cancelTurn(auth, session.sessionHandle)
    expect(state.port.cancelled).toEqual(['raw-1'])
    expect(state.gateway.debugSnapshot().activeTurns).toBe(0)
    await state.gateway.revokeGrant(grant.grantToken)
    expect(state.port.deleted).toEqual(['raw-1'])
    expect(state.gateway.debugSnapshot()).toEqual({ activeGrants: 0, activeSessions: 0, activeTurns: 0, activeSubscribers: 0 })
    expect(() => state.gateway.getCapabilities(auth)).toThrow()
  })

  it('waits for an active provider turn before strict session reaping', async () => {
    const state = setup()
    const { auth, session } = await grantAndSession(state)
    await state.gateway.startTurn(auth, session.sessionHandle, { contractVersion: 1, prompt: 'Create' })

    await state.gateway.closeSession(auth, session.sessionHandle)

    expect(state.port.cancelled).toEqual(['raw-1'])
    expect(state.port.awaitedStopped).toEqual(['raw-1'])
    expect(state.port.deleted).toEqual(['raw-1'])
    expect(state.gateway.debugSnapshot()).toMatchObject({ activeSessions: 0, activeTurns: 0 })
  })

  it('never forwards a raw provider failure message', async () => {
    const state = setup()
    state.port.failSend = true
    const { auth, session } = await grantAndSession(state)
    await expect(state.gateway.startTurn(auth, session.sessionHandle, { contractVersion: 1, prompt: 'Create' }))
      .rejects.toMatchObject({ code: 'HOST_RUNTIME_ERROR' })
    const events: unknown[] = []
    state.gateway.subscribe(auth, session.sessionHandle, 0, (event) => events.push(event))
    expect(JSON.stringify(events)).toContain('HOST_RUNTIME_ERROR')
    expect(JSON.stringify(events)).not.toContain('sensitive provider failure')
  })

  it('retains ownership when raw hidden-session deletion fails so cleanup can retry', async () => {
    const state = setup()
    const { grant } = await grantAndSession(state)
    state.port.failDelete = true
    await expect(state.gateway.revokeGrant(grant.grantToken)).rejects.toThrow('delete failed')
    expect(state.gateway.debugSnapshot()).toMatchObject({ activeGrants: 1, activeSessions: 1 })

    state.port.failDelete = false
    await state.gateway.revokeGrant(grant.grantToken)
    expect(state.gateway.debugSnapshot()).toEqual({ activeGrants: 0, activeSessions: 0, activeTurns: 0, activeSubscribers: 0 })
    expect(state.port.deleted).toEqual(['raw-1'])
  })

  it('joins concurrent close and revoke cleanup without leaving a revoked grant behind', async () => {
    const state = setup()
    const { grant, auth, session } = await grantAndSession(state)
    let releaseDelete!: () => void
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve })
    state.port.disposeAndReap = async (sessionId: string) => {
      await deleteGate
      state.port.deleted.push(sessionId)
    }

    const close = state.gateway.closeSession(auth, session.sessionHandle)
    const revoke = state.gateway.revokeGrant(grant.grantToken)
    releaseDelete()
    await Promise.all([close, revoke])
    expect(state.port.deleted).toEqual(['raw-1'])
    expect(state.gateway.debugSnapshot()).toEqual({ activeGrants: 0, activeSessions: 0, activeTurns: 0, activeSubscribers: 0 })
  })

  it('serializes session admission so concurrent creates cannot bypass the grant limit', async () => {
    const state = setup({ maxSessionsPerGrant: 2 })
    const grant = await state.gateway.issueGrant(state.spec)
    const auth: ModuleAgentAuthorization = { grantToken: grant.grantToken, ...state.spec }

    const results = await Promise.allSettled(Array.from({ length: 3 }, () => (
      state.gateway.createSession(auth, { contractVersion: 1 })
    )))
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(state.port.created).toHaveLength(2)
    expect(state.gateway.debugSnapshot()).toMatchObject({ activeGrants: 1, activeSessions: 2 })

    await state.gateway.revokeGrant(grant.grantToken)
  })

  it('cannot orphan a raw session when grant revocation races Host session creation', async () => {
    const state = setup()
    const grant = await state.gateway.issueGrant(state.spec)
    const auth: ModuleAgentAuthorization = { grantToken: grant.grantToken, ...state.spec }
    const originalCreate = state.port.createSession.bind(state.port)
    let releaseCreate!: () => void
    let creationEntered!: () => void
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve })
    const entered = new Promise<void>((resolve) => { creationEntered = resolve })
    state.port.createSession = async (input) => {
      creationEntered()
      await createGate
      return originalCreate(input)
    }

    const creating = state.gateway.createSession(auth, { contractVersion: 1 })
    await entered
    const revoking = state.gateway.revokeGrant(grant.grantToken)
    releaseCreate()

    await expect(creating).rejects.toMatchObject({ code: 'GRANT_REVOKED' })
    await revoking
    expect(state.port.deleted).toEqual(['raw-1'])
    expect(state.gateway.debugSnapshot()).toEqual({ activeGrants: 0, activeSessions: 0, activeTurns: 0, activeSubscribers: 0 })
  })
})
