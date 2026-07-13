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

/** Rejects semantic duplicate keys before JSON.parse would silently overwrite them. */
export function assertNoDuplicateJsonKeys(source: string, limits: ContractLimits): void {
  const scanner = new JsonDuplicateKeyScanner(source, limits)
  scanner.scan()
}

class JsonDuplicateKeyScanner {
  #index = 0
  #nodes = 0

  constructor(
    private readonly source: string,
    private readonly limits: ContractLimits,
  ) {}

  scan(): void {
    this.#skipWhitespace()
    this.#value(0)
    this.#skipWhitespace()
    if (this.#index !== this.source.length) this.#invalid()
  }

  #value(depth: number): void {
    this.#nodes += 1
    if (this.#nodes > this.limits.maxNodes) throw new ContractValidationError('JSON node limit exceeded')
    if (depth > this.limits.maxDepth) throw new ContractValidationError('JSON depth limit exceeded')
    this.#skipWhitespace()
    const character = this.source[this.#index]
    if (character === '{') return this.#object(depth)
    if (character === '[') return this.#array(depth)
    if (character === '"') {
      this.#string()
      return
    }
    if (character === 't') return this.#literal('true')
    if (character === 'f') return this.#literal('false')
    if (character === 'n') return this.#literal('null')
    if (character === '-' || (character !== undefined && character >= '0' && character <= '9')) return this.#number()
    this.#invalid()
  }

  #object(depth: number): void {
    this.#index += 1
    this.#skipWhitespace()
    if (this.#consume('}')) return

    const keys = new Set<string>()
    while (true) {
      this.#skipWhitespace()
      if (this.source[this.#index] !== '"') this.#invalid()
      const key = this.#string()
      if (keys.has(key)) throw new ContractValidationError('Raw request cannot contain duplicate JSON object keys')
      keys.add(key)
      this.#skipWhitespace()
      if (!this.#consume(':')) this.#invalid()
      this.#value(depth + 1)
      this.#skipWhitespace()
      if (this.#consume('}')) return
      if (!this.#consume(',')) this.#invalid()
    }
  }

  #array(depth: number): void {
    this.#index += 1
    this.#skipWhitespace()
    if (this.#consume(']')) return
    while (true) {
      this.#value(depth + 1)
      this.#skipWhitespace()
      if (this.#consume(']')) return
      if (!this.#consume(',')) this.#invalid()
    }
  }

  #string(): string {
    this.#index += 1
    let value = ''
    while (this.#index < this.source.length) {
      const character = this.source[this.#index++]!
      if (character === '"') return value
      if (character < ' ') this.#invalid()
      if (character !== '\\') {
        value += character
        continue
      }

      const escaped = this.source[this.#index++]
      if (escaped === undefined) this.#invalid()
      switch (escaped) {
        case '"': value += '"'; break
        case '\\': value += '\\'; break
        case '/': value += '/'; break
        case 'b': value += '\b'; break
        case 'f': value += '\f'; break
        case 'n': value += '\n'; break
        case 'r': value += '\r'; break
        case 't': value += '\t'; break
        case 'u': {
          const hex = this.source.slice(this.#index, this.#index + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.#invalid()
          value += String.fromCharCode(Number.parseInt(hex, 16))
          this.#index += 4
          break
        }
        default: this.#invalid()
      }
    }
    this.#invalid()
  }

  #literal(literal: string): void {
    if (!this.source.startsWith(literal, this.#index)) this.#invalid()
    this.#index += literal.length
  }

  #number(): void {
    const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.source.slice(this.#index))
    if (!match || match.index !== 0) this.#invalid()
    this.#index += match![0].length
  }

  #skipWhitespace(): void {
    while (this.source[this.#index] === ' ' || this.source[this.#index] === '\n'
      || this.source[this.#index] === '\r' || this.source[this.#index] === '\t') this.#index += 1
  }

  #consume(character: string): boolean {
    if (this.source[this.#index] !== character) return false
    this.#index += 1
    return true
  }

  #invalid(): never {
    throw new ContractValidationError('Raw request must be valid JSON')
  }
}
