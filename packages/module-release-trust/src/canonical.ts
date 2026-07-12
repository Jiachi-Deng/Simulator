const encoder = new TextEncoder()

function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('Canonical catalog numbers must be safe integers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value !== 'object') throw new TypeError('Canonical catalogs contain JSON data only')

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Canonical catalogs contain plain objects only')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const fields: string[] = []
  for (const key of Object.keys(descriptors).sort()) {
    const descriptor = descriptors[key]
    if (!descriptor || descriptor.get || descriptor.set || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Canonical catalogs contain data properties only')
    }
    fields.push(`${JSON.stringify(key)}:${canonicalJson(descriptor.value)}`)
  }
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string')) {
    throw new TypeError('Canonical catalogs cannot contain symbol properties')
  }
  return `{${fields.join(',')}}`
}

export function encodeCanonicalCatalog(value: unknown): Uint8Array {
  return encoder.encode(canonicalJson(value))
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!
  }
  return difference === 0
}
