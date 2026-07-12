import { describe, expect, it } from 'bun:test'
import {
  encodeCanonicalCatalog,
  MAX_CANONICAL_CATALOG_BYTES,
  MAX_CANONICAL_DEPTH,
  MAX_CANONICAL_VALUES,
} from './canonical.ts'

describe('encodeCanonicalCatalog', () => {
  it('produces deterministic valid JSON with one representation per plain value', () => {
    const bytes = encodeCanonicalCatalog({ zebra: [true, null], alpha: { value: 1 } })
    const json = new TextDecoder().decode(bytes)
    expect(json).toBe('{"alpha":{"value":1},"zebra":[true,null]}')
    expect(JSON.parse(json)).toEqual({ alpha: { value: 1 }, zebra: [true, null] })
  })

  it('rejects sparse arrays', () => {
    expect(() => encodeCanonicalCatalog(new Array(1))).toThrow('dense')
  })

  it('rejects array accessors without executing them', () => {
    let getterCalls = 0
    const value = [0]
    Object.defineProperty(value, '0', {
      enumerable: true,
      get() {
        getterCalls += 1
        return 1
      },
    })
    expect(() => encodeCanonicalCatalog(value)).toThrow('data properties')
    expect(getterCalls).toBe(0)
  })

  it('rejects object accessors without executing them', () => {
    let getterCalls = 0
    const value = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        getterCalls += 1
        return 1
      },
    })
    expect(() => encodeCanonicalCatalog(value)).toThrow('data properties')
    expect(getterCalls).toBe(0)
  })

  it('rejects symbol and extra non-index array properties', () => {
    const withSymbol = [1]
    Object.defineProperty(withSymbol, Symbol('hidden'), { value: true })
    expect(() => encodeCanonicalCatalog(withSymbol)).toThrow('symbol')

    const withExtraProperty = [1] as number[] & { note?: string }
    withExtraProperty.note = 'ambiguous'
    expect(() => encodeCanonicalCatalog(withExtraProperty)).toThrow('extra properties')

    expect(() => encodeCanonicalCatalog({ [Symbol('hidden')]: true })).toThrow('symbol')
  })

  it('rejects circular references and excessive depth, value count, and bytes', () => {
    const circular: { self?: unknown } = {}
    circular.self = circular
    expect(() => encodeCanonicalCatalog(circular)).toThrow('circular')

    let deep: unknown = null
    for (let index = 0; index <= MAX_CANONICAL_DEPTH; index += 1) deep = [deep]
    expect(() => encodeCanonicalCatalog(deep)).toThrow('depth')

    expect(() => encodeCanonicalCatalog(new Array(MAX_CANONICAL_VALUES).fill(null))).toThrow('values')
    expect(() => encodeCanonicalCatalog('x'.repeat(MAX_CANONICAL_CATALOG_BYTES + 1))).toThrow('string exceeds')
  })
})
