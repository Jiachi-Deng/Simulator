import { createSession as createStoredSession, type ModuleAgentRunMetadata } from '@craft-agent/shared/sessions'
import type { BackendRuntimeAuthoritySnapshot } from '@craft-agent/shared/agent/backend'
import { SessionManager, createManagedSession } from './SessionManager.ts'

type Scenario =
  | 'v1-before-runtime'
  | 'v2-before-runtime'
  | 'v2-after-runtime'
  | 'v2-before-iterator'
  | 'v2-incomplete-context'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertPinnedSnapshot(snapshot: BackendRuntimeAuthoritySnapshot): void {
  assert(snapshot.connectionSlug === 'pinned-connection', 'authority used an unpinned Connection')
  assert(snapshot.provider === 'anthropic', 'authority used an unexpected provider')
  assert(snapshot.authType === 'api_key', 'authority used an unexpected auth type')
  assert(snapshot.resolvedModel === 'pinned-model', 'authority used an unpinned model')
}

async function main(): Promise<void> {
  const scenario = process.argv[2] as Scenario | undefined
  const rootPath = process.argv[3]
  assert(scenario !== undefined, 'missing authority fixture scenario')
  assert(rootPath !== undefined, 'missing authority fixture workspace')

  const contractVersion = scenario === 'v1-before-runtime' ? 1 : 2
  const ownership: ModuleAgentRunMetadata = {
    transient: true,
    contractVersion,
    moduleId: 'org.simulator.open-design',
    runHandle: `run_${'1'.repeat(32)}`,
    idempotencyKeyDigest: '2'.repeat(64),
    requestDigest: '3'.repeat(64),
    workerEpoch: 'epoch_admission_fence',
    state: contractVersion === 2 ? 'starting' : 'accepted',
  }
  const stored = await createStoredSession(rootPath, {
    name: 'OpenDesign',
    hidden: true,
    workingDirectory: rootPath,
    enabledSourceSlugs: [],
    model: 'pinned-model',
    llmConnection: 'pinned-connection',
    moduleAgentRun: ownership,
  })
  const managed = createManagedSession(stored, {
    id: 'workspace-admission',
    name: 'Admission Workspace',
    rootPath,
    createdAt: Date.now(),
  } as never, { messagesLoaded: true })
  const manager = new SessionManager()
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(managed.id, managed)

  let authorityChecks = 0
  let providerStarts = 0
  let chatCalls = 0
  let nextCalls = 0
  const failAt = scenario === 'v2-after-runtime'
    ? 2
    : scenario === 'v2-before-iterator'
      ? 4
      : 1

  if (scenario === 'v2-before-iterator') {
    ;(manager as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => {
      providerStarts++
      return {
        setAllSources: () => undefined,
        getModel: () => 'fixture-model',
        chat: () => {
          chatCalls++
          return {
            [Symbol.asyncIterator]() { return this },
            next: async () => {
              nextCalls++
              return { done: true, value: undefined }
            },
          }
        },
      }
    }
  } else if (scenario === 'v2-after-runtime') {
    ;(manager as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => {
      providerStarts++
      return {
        chat: () => {
          chatCalls++
          throw new Error('chat must not start')
        },
      }
    }
  } else {
    ;(manager as unknown as { getOrCreateAgent: () => Promise<never> }).getOrCreateAgent = async () => {
      providerStarts++
      throw new Error('provider must not start')
    }
  }

  const assertion = async (snapshot: BackendRuntimeAuthoritySnapshot): Promise<void> => {
    authorityChecks++
    assertPinnedSnapshot(snapshot)
    if (authorityChecks === failAt) throw new Error('authority drifted')
  }

  try {
    const result = await (contractVersion === 1
      ? manager.sendLegacyModuleAgentMessage(managed.id, 'drifted v1 authority', assertion)
      : manager.sendModuleAgentMessage(managed.id, 'drifted v2 authority', assertion)
    ).then(() => 'resolved' as const, (error: unknown) => error)

    assert(result instanceof Error, 'authority rejection unexpectedly resolved')
    assert(!result.message.includes('authority drifted'), 'inner authority error leaked')
    assert(managed.isProcessing === false, 'rejected admission left Session processing')

    if (scenario === 'v2-incomplete-context') {
      assert(authorityChecks === 0, 'incomplete context reached the Host assertion')
      assert(providerStarts === 0, 'incomplete context started a provider')
      return
    }

    assert(authorityChecks === failAt, `expected ${failAt} authority checks, got ${authorityChecks}`)
    if (scenario === 'v2-before-runtime' || scenario === 'v1-before-runtime') {
      assert(providerStarts === 0, 'authority drift started a provider')
    } else {
      assert(providerStarts === 1, `expected one provider creation, got ${providerStarts}`)
    }
    if (scenario === 'v2-after-runtime') {
      assert(chatCalls === 0, 'authority drift reached agent.chat')
    }
    if (scenario === 'v2-before-iterator') {
      assert(chatCalls === 1, `expected one agent.chat call, got ${chatCalls}`)
      assert(nextCalls === 0, 'authority drift entered the provider iterator')
    }
  } finally {
    manager.cleanup()
  }
}

await main()
