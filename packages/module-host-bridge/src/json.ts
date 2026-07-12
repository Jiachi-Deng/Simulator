import type { ContractLimits, JsonObject, JsonValue } from './types.ts'

export class ContractValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContractValidationError'
  }
}

export function assertPlainJson(value: unknown, limits: ContractLimits): asserts value is JsonValue {
  const seen = new Set<object>()
  let nodes = 0

  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1
    if (nodes > limits.maxNodes) throw new ContractValidationError('JSON node limit exceeded')
    if (depth > limits.maxDepth) throw new ContractValidationError('JSON depth limit exceeded')

    if (candidate === null || typeof candidate === 'boolean') return
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new ContractValidationError('JSON numbers must be finite')
      return
    }
    if (typeof candidate === 'string') {
      if (candidate.length > limits.maxStringLength) throw new ContractValidationError('JSON string limit exceeded')
      return
    }
    if (typeof candidate !== 'object') throw new ContractValidationError('Value must be plain JSON')
    if (seen.has(candidate)) throw new ContractValidationError('Cyclic values are not JSON')
    seen.add(candidate)

    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1)
    } else {
      const prototype = Object.getPrototypeOf(candidate)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new ContractValidationError('Objects must have a plain prototype')
      }
      const keys = Object.keys(candidate)
      if (keys.length > limits.maxObjectKeys) throw new ContractValidationError('JSON object key limit exceeded')
      for (const key of keys) {
        if (key.length > limits.maxStringLength) throw new ContractValidationError('JSON key limit exceeded')
        visit((candidate as Record<string, unknown>)[key], depth + 1)
      }
    }
    seen.delete(candidate)
  }

  visit(value, 0)
  const serialized = JSON.stringify(value)
  if (new TextEncoder().encode(serialized).byteLength > limits.maxBytes) {
    throw new ContractValidationError('JSON byte limit exceeded')
  }
}

export function assertExactKeys(value: JsonObject, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional])
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new ContractValidationError(`Missing field: ${key}`)
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ContractValidationError(`Unknown field: ${key}`)
  }
}

export function requireString(value: JsonObject, key: string, max = 256): string {
  const result = value[key]
  if (typeof result !== 'string' || result.length === 0 || result.length > max) {
    throw new ContractValidationError(`Field ${key} must be a non-empty string`)
  }
  return result
}

export function requireNumber(value: JsonObject, key: string): number {
  const result = value[key]
  if (typeof result !== 'number' || !Number.isFinite(result)) throw new ContractValidationError(`Field ${key} must be a number`)
  return result
}

export function requireStringArray(value: JsonObject, key: string, maxItems = 32): string[] {
  const result = value[key]
  if (!Array.isArray(result) || result.length > maxItems || result.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new ContractValidationError(`Field ${key} must be a string array`)
  }
  return result as string[]
}

export function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(',')}}`
}
