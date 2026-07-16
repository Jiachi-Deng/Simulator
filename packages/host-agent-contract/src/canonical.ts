import { HOST_AGENT_CONTRACT_VERSION } from './constants.ts'
import type { CreateHostAgentRunRequest } from './types.ts'
import { parseCreateHostAgentRunRequest } from './validators.ts'

const encoder = new TextEncoder()

/**
 * Canonical POST /runs JSON. Field order, omission semantics, escaping, and
 * UTF-8 encoding are stable inputs to request digest calculation.
 */
export function canonicalizeCreateHostAgentRunRequest(input: unknown): string {
  const request = parseCreateHostAgentRunRequest(input)
  const canonical: CreateHostAgentRunRequest = request.workingDirectory === undefined
    ? { contractVersion: HOST_AGENT_CONTRACT_VERSION, prompt: request.prompt }
    : {
        contractVersion: HOST_AGENT_CONTRACT_VERSION,
        prompt: request.prompt,
        workingDirectory: request.workingDirectory,
      }
  return JSON.stringify(canonical)
}

export function encodeCanonicalCreateHostAgentRunRequest(input: unknown): Uint8Array {
  return encoder.encode(canonicalizeCreateHostAgentRunRequest(input))
}
