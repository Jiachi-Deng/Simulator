import {
  HOST_AGENT_ERROR_CODES,
  HostAgentContractValidationError,
  type HostAgentErrorCode,
} from '@simulator/host-agent-contract'

const publicCodes = new Set<string>(HOST_AGENT_ERROR_CODES)

export class HostAgentBrokerCoreClientError extends Error {
  constructor(readonly code: HostAgentErrorCode) {
    super('Host Agent core request failed')
    this.name = 'HostAgentBrokerCoreClientError'
  }
}

export class HostAgentBrokerDisconnectedError extends HostAgentBrokerCoreClientError {
  constructor() {
    super('BROKER_DISCONNECTED')
    this.name = 'HostAgentBrokerDisconnectedError'
  }
}

export function toPublicErrorCode(error: unknown): HostAgentErrorCode {
  if (error instanceof HostAgentBrokerCoreClientError) return error.code
  if (error instanceof HostAgentContractValidationError) {
    return error.path === '$.contractVersion' ? 'INVALID_CONTRACT_VERSION' : 'INVALID_REQUEST'
  }
  if (error instanceof TypeError) return 'INVALID_REQUEST'
  if (error && typeof error === 'object') {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
    if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string' && publicCodes.has(descriptor.value)) {
      return descriptor.value as HostAgentErrorCode
    }
  }
  return 'INTERNAL_ERROR'
}
