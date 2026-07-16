import {
  HOST_AGENT_RUN_HANDLE_PATTERN,
  HOST_AGENT_RUN_STATES,
  type HostAgentRunState,
} from '@simulator/host-agent-contract'

/**
 * Host-internal ownership marker for one-turn Module Agent sessions.
 *
 * This object is persisted only in the Session JSONL header. It must never be
 * returned through renderer/remote Session DTOs or portable SessionBundles.
 */
export interface ModuleAgentRunMetadata {
  transient: true
  contractVersion: 1 | 2
  moduleId: string
  runHandle: string
  idempotencyKeyDigest: string
  requestDigest: string
  workerEpoch: string
  state: HostAgentRunState
}

const MODULE_AGENT_RUN_KEYS = [
  'transient',
  'contractVersion',
  'moduleId',
  'runHandle',
  'idempotencyKeyDigest',
  'requestDigest',
  'workerEpoch',
  'state',
] as const

const MODULE_AGENT_RUN_KEY_SET = new Set<string>(MODULE_AGENT_RUN_KEYS)
const HOST_AGENT_RUN_STATE_SET = new Set<string>(HOST_AGENT_RUN_STATES)
const SAFE_OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/

function fail(path: string, reason: string): never {
  throw new TypeError(`${path}: ${reason}`)
}

/**
 * Parse a closed ownership object without invoking accessors.
 *
 * Unknown/missing fields, custom prototypes, accessors, symbols, noncanonical
 * identifiers, and non-lowercase SHA-256 digests are rejected. A fresh plain
 * object is returned so callers never retain a hostile input prototype.
 */
export function parseModuleAgentRunMetadata(input: unknown): ModuleAgentRunMetadata {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('moduleAgentRun', 'value must be an object')
  }

  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) {
    fail('moduleAgentRun', 'value must be a plain object')
  }

  const descriptors = Object.getOwnPropertyDescriptors(input)
  const ownKeys = Reflect.ownKeys(descriptors)
  if (ownKeys.some((key) => typeof key !== 'string')) {
    fail('moduleAgentRun', 'symbol fields are not allowed')
  }
  for (const key of ownKeys as string[]) {
    if (!MODULE_AGENT_RUN_KEY_SET.has(key)) fail(`moduleAgentRun.${key}`, 'unknown field')
    const descriptor = descriptors[key]
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set || !descriptor.enumerable) {
      fail(`moduleAgentRun.${key}`, 'field must be an enumerable data property')
    }
  }
  for (const key of MODULE_AGENT_RUN_KEYS) {
    if (!Object.hasOwn(descriptors, key)) fail(`moduleAgentRun.${key}`, 'required field is missing')
  }

  const value = Object.fromEntries(
    MODULE_AGENT_RUN_KEYS.map((key) => [key, descriptors[key]!.value]),
  ) as Record<(typeof MODULE_AGENT_RUN_KEYS)[number], unknown>

  if (value.transient !== true) fail('moduleAgentRun.transient', 'value must be true')
  if (value.contractVersion !== 1 && value.contractVersion !== 2) {
    fail('moduleAgentRun.contractVersion', 'value must be 1 or 2')
  }
  if (typeof value.moduleId !== 'string' || !SAFE_OPAQUE_ID_PATTERN.test(value.moduleId)) {
    fail('moduleAgentRun.moduleId', 'value must be a canonical route-safe ID')
  }
  if (typeof value.runHandle !== 'string' || !HOST_AGENT_RUN_HANDLE_PATTERN.test(value.runHandle)) {
    fail('moduleAgentRun.runHandle', 'value must be a canonical Host Agent run handle')
  }
  if (typeof value.idempotencyKeyDigest !== 'string' || !SHA256_HEX_PATTERN.test(value.idempotencyKeyDigest)) {
    fail('moduleAgentRun.idempotencyKeyDigest', 'value must be a lowercase SHA-256 digest')
  }
  if (typeof value.requestDigest !== 'string' || !SHA256_HEX_PATTERN.test(value.requestDigest)) {
    fail('moduleAgentRun.requestDigest', 'value must be a lowercase SHA-256 digest')
  }
  if (typeof value.workerEpoch !== 'string' || !SAFE_OPAQUE_ID_PATTERN.test(value.workerEpoch)) {
    fail('moduleAgentRun.workerEpoch', 'value must be a canonical route-safe ID')
  }
  if (typeof value.state !== 'string' || !HOST_AGENT_RUN_STATE_SET.has(value.state)) {
    fail('moduleAgentRun.state', 'value must be a Host Agent run state')
  }

  return {
    transient: true,
    contractVersion: value.contractVersion,
    moduleId: value.moduleId,
    runHandle: value.runHandle,
    idempotencyKeyDigest: value.idempotencyKeyDigest,
    requestDigest: value.requestDigest,
    workerEpoch: value.workerEpoch,
    state: value.state as HostAgentRunState,
  }
}

export function isModuleAgentRunMetadata(input: unknown): input is ModuleAgentRunMetadata {
  try {
    parseModuleAgentRunMetadata(input)
    return true
  } catch {
    return false
  }
}
