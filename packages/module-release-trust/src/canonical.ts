export const MAX_CANONICAL_CATALOG_BYTES = 4 * 1024 * 1024
export const MAX_CANONICAL_DEPTH = 64
export const MAX_CANONICAL_VALUES = 100_000

const encoder = new TextEncoder()

interface CanonicalContext {
  readonly active: WeakSet<object>
  values: number
  characters: number
}

function consume(context: CanonicalContext, characters: number): void {
  context.characters += characters
  if (context.characters > MAX_CANONICAL_CATALOG_BYTES) {
    throw new RangeError(`Canonical catalog exceeds ${MAX_CANONICAL_CATALOG_BYTES} characters`)
  }
}

function visit(context: CanonicalContext, depth: number): void {
  if (depth > MAX_CANONICAL_DEPTH) throw new RangeError(`Canonical catalog exceeds depth ${MAX_CANONICAL_DEPTH}`)
  context.values += 1
  if (context.values > MAX_CANONICAL_VALUES) {
    throw new RangeError(`Canonical catalog exceeds ${MAX_CANONICAL_VALUES} values`)
  }
}

function withObject<T>(context: CanonicalContext, value: object, callback: () => T): T {
  if (context.active.has(value)) throw new TypeError('Canonical catalogs cannot contain circular references')
  context.active.add(value)
  try {
    return callback()
  } finally {
    context.active.delete(value)
  }
}

function canonicalArray(value: unknown[], context: CanonicalContext, depth: number): string {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError('Canonical catalogs contain plain arrays only')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.some((key) => typeof key !== 'string')) {
    throw new TypeError('Canonical arrays cannot contain symbol properties')
  }
  if (keys.length !== value.length + 1 || !Object.hasOwn(descriptors, 'length')) {
    throw new TypeError('Canonical arrays must be dense and cannot contain extra properties')
  }

  return withObject(context, value, () => {
    const items: string[] = []
    consume(context, 2 + Math.max(0, value.length - 1))
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[index]
      if (!descriptor || descriptor.get || descriptor.set || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('Canonical arrays must contain dense data properties only')
      }
      items.push(canonicalJson(descriptor.value, context, depth + 1))
    }
    return `[${items.join(',')}]`
  })
}

function canonicalObject(value: object, context: CanonicalContext, depth: number): string {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Canonical catalogs contain plain objects only')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string')) {
    throw new TypeError('Canonical objects cannot contain symbol properties')
  }

  return withObject(context, value, () => {
    const fields: string[] = []
    const keys = Object.keys(descriptors).sort()
    consume(context, 2 + Math.max(0, keys.length - 1))
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor || descriptor.get || descriptor.set || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('Canonical objects must contain data properties only')
      }
      const encodedKey = JSON.stringify(key)
      consume(context, encodedKey.length + 1)
      fields.push(`${encodedKey}:${canonicalJson(descriptor.value, context, depth + 1)}`)
    }
    return `{${fields.join(',')}}`
  })
}

function canonicalJson(value: unknown, context: CanonicalContext, depth: number): string {
  visit(context, depth)
  if (value === null) {
    consume(context, 4)
    return 'null'
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string' && value.length > MAX_CANONICAL_CATALOG_BYTES) {
      throw new RangeError(`Canonical string exceeds ${MAX_CANONICAL_CATALOG_BYTES} characters`)
    }
    const encoded = JSON.stringify(value)
    consume(context, encoded.length)
    return encoded
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('Canonical catalog numbers must be safe integers')
    const encoded = JSON.stringify(value)
    consume(context, encoded.length)
    return encoded
  }
  if (Array.isArray(value)) return canonicalArray(value, context, depth)
  if (typeof value !== 'object') throw new TypeError('Canonical catalogs contain JSON data only')
  return canonicalObject(value, context, depth)
}

export function encodeCanonicalCatalog(value: unknown): Uint8Array {
  const json = canonicalJson(value, { active: new WeakSet(), values: 0, characters: 0 }, 0)
  const bytes = encoder.encode(json)
  if (bytes.byteLength > MAX_CANONICAL_CATALOG_BYTES) {
    throw new RangeError(`Canonical catalog exceeds ${MAX_CANONICAL_CATALOG_BYTES} bytes`)
  }
  return bytes
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!
  return difference === 0
}
