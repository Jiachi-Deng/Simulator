export const MODULE_VIEW_TRANSPORT_VERSION = 1 as const

export const MODULE_VIEW_CHANNELS = Object.freeze({
  TO_HOST: 'module-view:to-host',
  TO_MODULE: 'module-view:to-module',
})

export const MODULE_VIEW_LIMITS = Object.freeze({
  maxEnvelopeBytes: 64 * 1024,
  maxDepth: 8,
  maxNodes: 1024,
  maxArrayLength: 256,
  maxObjectKeys: 128,
  maxKeyBytes: 256,
  maxStringBytes: 16 * 1024,
})

const MODULE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{1,126}[a-z0-9])?$/
const VIEW_INSTANCE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/

export type ModuleViewDirection = 'module-to-host' | 'host-to-module'
export type ModuleViewJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ModuleViewJsonValue[]
  | { readonly [key: string]: ModuleViewJsonValue }

interface ModuleViewEnvelopeBase {
  readonly version: typeof MODULE_VIEW_TRANSPORT_VERSION
  readonly direction: ModuleViewDirection
  readonly moduleId: string
  readonly viewInstanceId: string
}

export interface ModuleViewReadyEnvelope extends ModuleViewEnvelopeBase {
  readonly type: 'ready'
}

export interface ModuleViewMessageEnvelope extends ModuleViewEnvelopeBase {
  readonly type: 'message'
  readonly payload: ModuleViewJsonValue
}

export interface ModuleViewFailureEnvelope extends ModuleViewEnvelopeBase {
  readonly type: 'failure'
  readonly error: {
    readonly code: string
    readonly message: string
  }
}

export type ModuleViewEnvelope =
  | ModuleViewReadyEnvelope
  | ModuleViewMessageEnvelope
  | ModuleViewFailureEnvelope

export type ModuleViewEnvelopeParseResult =
  | { readonly ok: true; readonly value: ModuleViewEnvelope }
  | { readonly ok: false; readonly code: 'INVALID_ENVELOPE' | 'PAYLOAD_LIMIT_EXCEEDED'; readonly message: string }

interface ShapeBudget {
  nodes: number
  bytes: number
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function fail(
  code: 'INVALID_ENVELOPE' | 'PAYLOAD_LIMIT_EXCEEDED',
  message: string,
): ModuleViewEnvelopeParseResult {
  return { ok: false, code, message }
}

function readDataObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null

  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    if (Object.getOwnPropertySymbols(value).length > 0) return null

    const descriptors = Object.getOwnPropertyDescriptors(value)
    for (const descriptor of Object.values(descriptors)) {
      if (!('value' in descriptor) || descriptor.get || descriptor.set) return null
    }
    return Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
    )
  } catch {
    return null
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index])
}

function validateJsonValue(
  value: unknown,
  depth: number,
  budget: ShapeBudget,
  ancestors: Set<object>,
): ModuleViewEnvelopeParseResult | null {
  budget.nodes += 1
  if (budget.nodes > MODULE_VIEW_LIMITS.maxNodes) {
    return fail('PAYLOAD_LIMIT_EXCEEDED', 'Module view payload contains too many values')
  }
  if (depth > MODULE_VIEW_LIMITS.maxDepth) {
    return fail('PAYLOAD_LIMIT_EXCEEDED', 'Module view payload exceeds the maximum nesting depth')
  }

  if (value === null || typeof value === 'boolean') {
    budget.bytes += value === null ? 4 : value ? 4 : 5
    return null
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fail('INVALID_ENVELOPE', 'Module view payload numbers must be finite')
    budget.bytes += String(value).length
    return null
  }
  if (typeof value === 'string') {
    const bytes = byteLength(value)
    if (bytes > MODULE_VIEW_LIMITS.maxStringBytes) {
      return fail('PAYLOAD_LIMIT_EXCEEDED', 'Module view payload string exceeds the maximum length')
    }
    budget.bytes += bytes
    return budget.bytes > MODULE_VIEW_LIMITS.maxEnvelopeBytes
      ? fail('PAYLOAD_LIMIT_EXCEEDED', 'Module view envelope exceeds the maximum byte size')
      : null
  }
  if (typeof value !== 'object' || value === null) {
    return fail('INVALID_ENVELOPE', 'Module view payload must contain only JSON-like data')
  }

  if (ancestors.has(value)) return fail('INVALID_ENVELOPE', 'Module view payload must not contain cycles')
  ancestors.add(value)

  if (Array.isArray(value)) {
    if (value.length > MODULE_VIEW_LIMITS.maxArrayLength) {
      ancestors.delete(value)
      return fail('PAYLOAD_LIMIT_EXCEEDED', 'Module view payload array exceeds the maximum length')
    }
    let descriptors: PropertyDescriptorMap
    try {
      descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>
    } catch {
      ancestors.delete(value)
      return fail('INVALID_ENVELOPE', 'Module view payload arrays must be plain data arrays')
    }
    const indexKeys = Object.keys(descriptors).filter((key) => key !== 'length')
    if (indexKeys.length !== value.length || indexKeys.some((key, index) => key !== String(index))) {
      ancestors.delete(value)
      return fail('INVALID_ENVELOPE', 'Module view payload arrays must be dense and contain no custom fields')
    }
    if (indexKeys.some((key) => {
      const descriptor = descriptors[key]
      return !descriptor || !('value' in descriptor) || !!descriptor.get || !!descriptor.set
    })) {
      ancestors.delete(value)
      return fail('INVALID_ENVELOPE', 'Module view payload arrays must not contain accessors')
    }
    budget.bytes += 2
    for (const key of indexKeys) {
      const error = validateJsonValue(descriptors[key].value, depth + 1, budget, ancestors)
      if (error) {
        ancestors.delete(value)
        return error
      }
    }
    ancestors.delete(value)
    return null
  }

  const object = readDataObject(value)
  if (!object) {
    ancestors.delete(value)
    return fail('INVALID_ENVELOPE', 'Module view payload objects must be plain data objects')
  }
  const keys = Object.keys(object)
  if (keys.length > MODULE_VIEW_LIMITS.maxObjectKeys) {
    ancestors.delete(value)
    return fail('PAYLOAD_LIMIT_EXCEEDED', 'Module view payload object contains too many keys')
  }

  budget.bytes += 2
  for (const key of keys) {
    const keyBytes = byteLength(key)
    if (keyBytes > MODULE_VIEW_LIMITS.maxKeyBytes) {
      ancestors.delete(value)
      return fail('PAYLOAD_LIMIT_EXCEEDED', 'Module view payload key exceeds the maximum length')
    }
    budget.bytes += keyBytes
    const error = validateJsonValue(object[key], depth + 1, budget, ancestors)
    if (error) {
      ancestors.delete(value)
      return error
    }
  }
  ancestors.delete(value)

  return budget.bytes > MODULE_VIEW_LIMITS.maxEnvelopeBytes
    ? fail('PAYLOAD_LIMIT_EXCEEDED', 'Module view envelope exceeds the maximum byte size')
    : null
}

export function isValidModuleId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 3
    && value.length <= 128
    && MODULE_ID_PATTERN.test(value)
    && value.includes('.')
}

export function isValidViewInstanceId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 128
    && VIEW_INSTANCE_ID_PATTERN.test(value)
}

export function parseModuleViewEnvelope(
  input: unknown,
  expectedDirection?: ModuleViewDirection,
): ModuleViewEnvelopeParseResult {
  const root = readDataObject(input)
  if (!root) return fail('INVALID_ENVELOPE', 'Module view envelope must be a plain data object')
  if (root.version !== MODULE_VIEW_TRANSPORT_VERSION) {
    return fail('INVALID_ENVELOPE', 'Unsupported module view envelope version')
  }
  if (root.direction !== 'module-to-host' && root.direction !== 'host-to-module') {
    return fail('INVALID_ENVELOPE', 'Invalid module view envelope direction')
  }
  if (expectedDirection && root.direction !== expectedDirection) {
    return fail('INVALID_ENVELOPE', 'Module view envelope direction does not match the transport channel')
  }
  if (!isValidModuleId(root.moduleId)) return fail('INVALID_ENVELOPE', 'Invalid moduleId')
  if (!isValidViewInstanceId(root.viewInstanceId)) return fail('INVALID_ENVELOPE', 'Invalid viewInstanceId')

  const budget: ShapeBudget = {
    nodes: 0,
    bytes: byteLength(root.moduleId) + byteLength(root.viewInstanceId) + 64,
  }

  if (root.type === 'ready') {
    if (!hasExactKeys(root, ['version', 'direction', 'moduleId', 'viewInstanceId', 'type'])) {
      return fail('INVALID_ENVELOPE', 'Ready envelope contains unknown or missing fields')
    }
    return {
      ok: true,
      value: {
        version: MODULE_VIEW_TRANSPORT_VERSION,
        direction: root.direction,
        moduleId: root.moduleId,
        viewInstanceId: root.viewInstanceId,
        type: 'ready',
      },
    }
  }

  if (root.type === 'message') {
    if (!hasExactKeys(root, ['version', 'direction', 'moduleId', 'viewInstanceId', 'type', 'payload'])) {
      return fail('INVALID_ENVELOPE', 'Message envelope contains unknown or missing fields')
    }
    const shapeError = validateJsonValue(root.payload, 0, budget, new Set())
    if (shapeError) return shapeError
    return {
      ok: true,
      value: {
        version: MODULE_VIEW_TRANSPORT_VERSION,
        direction: root.direction,
        moduleId: root.moduleId,
        viewInstanceId: root.viewInstanceId,
        type: 'message',
        payload: root.payload as ModuleViewJsonValue,
      },
    }
  }

  if (root.type === 'failure') {
    if (!hasExactKeys(root, ['version', 'direction', 'moduleId', 'viewInstanceId', 'type', 'error'])) {
      return fail('INVALID_ENVELOPE', 'Failure envelope contains unknown or missing fields')
    }
    const error = readDataObject(root.error)
    if (!error || !hasExactKeys(error, ['code', 'message'])) {
      return fail('INVALID_ENVELOPE', 'Failure envelope error must contain only code and message')
    }
    if (typeof error.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)) {
      return fail('INVALID_ENVELOPE', 'Failure envelope contains an invalid error code')
    }
    if (typeof error.message !== 'string' || error.message.length === 0) {
      return fail('INVALID_ENVELOPE', 'Failure envelope contains an invalid error message')
    }
    const shapeError = validateJsonValue(error, 0, budget, new Set())
    if (shapeError) return shapeError
    return {
      ok: true,
      value: {
        version: MODULE_VIEW_TRANSPORT_VERSION,
        direction: root.direction,
        moduleId: root.moduleId,
        viewInstanceId: root.viewInstanceId,
        type: 'failure',
        error: { code: error.code, message: error.message },
      },
    }
  }

  return fail('INVALID_ENVELOPE', 'Unknown module view envelope type')
}

export function createModuleViewMessageEnvelope(
  direction: ModuleViewDirection,
  moduleId: string,
  viewInstanceId: string,
  payload: unknown,
): ModuleViewEnvelopeParseResult {
  return parseModuleViewEnvelope({
    version: MODULE_VIEW_TRANSPORT_VERSION,
    direction,
    moduleId,
    viewInstanceId,
    type: 'message',
    payload,
  }, direction)
}
