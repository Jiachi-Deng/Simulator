import type { HostAgentProtocolPath } from './protocol'

export interface HostAgentWorkerRpcHandler {
  invoke(method: string, payload: unknown): Promise<unknown>
}

/**
 * Deliberately narrower than SessionManager. The adapter implemented by the main
 * process may delegate only these v2 operations to ModuleAgentRunCore.
 */
export interface V2ModuleAgentRunCoreBridge {
  createRun(payload: unknown): Promise<unknown>
  getRun(payload: unknown): Promise<unknown> | unknown
  subscribeRun(payload: unknown): Promise<unknown>
  unsubscribeRun(payload: unknown): Promise<unknown>
  cancelRun(payload: unknown): Promise<unknown>
  closeRun(payload: unknown): Promise<unknown>
  disconnectGrant(payload: unknown): Promise<unknown>
}

export type V2ModuleAgentRunCoreMethod = keyof V2ModuleAgentRunCoreBridge

const V2_METHODS = new Set<V2ModuleAgentRunCoreMethod>([
  'createRun',
  'getRun',
  'subscribeRun',
  'unsubscribeRun',
  'cancelRun',
  'closeRun',
  'disconnectGrant',
])

export function createV2ModuleAgentRunCoreRpcHandler(
  bridge: V2ModuleAgentRunCoreBridge,
): HostAgentWorkerRpcHandler {
  return {
    async invoke(method, payload) {
      if (!V2_METHODS.has(method as V2ModuleAgentRunCoreMethod)) {
        throw new HostAgentRpcMethodUnavailableError('v2', method)
      }
      const operation = bridge[method as V2ModuleAgentRunCoreMethod] as (value: unknown) => unknown
      return await operation.call(bridge, payload)
    },
  }
}

/**
 * The legacy Gateway is intentionally not imported here. Wiring must supply an
 * explicit allow-list, keeping v1 in a separate worker and authority domain.
 */
export function createV1CompatibilityRpcHandler(
  methods: Readonly<Record<string, (payload: unknown) => Promise<unknown> | unknown>>,
): HostAgentWorkerRpcHandler {
  const allowed = new Map(Object.entries(methods))
  return {
    async invoke(method, payload) {
      const operation = allowed.get(method)
      if (!operation) throw new HostAgentRpcMethodUnavailableError('v1', method)
      return await operation(payload)
    },
  }
}

export class HostAgentRpcMethodUnavailableError extends Error {
  constructor(readonly protocol: HostAgentProtocolPath, readonly method: string) {
    super('Host Agent worker RPC method is unavailable')
    this.name = 'HostAgentRpcMethodUnavailableError'
  }
}
