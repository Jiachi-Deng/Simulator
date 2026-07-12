import type { ModuleReleaseEnvelopeV1 } from '@simulator/module-release-trust'
import { ModuleDownloaderError } from './types.ts'

const WIRE_FIELDS = ['schemaVersion', 'keyId', 'catalogBytes', 'signature'] as const
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export function decodeCatalogEnvelope(bytes: Uint8Array): ModuleReleaseEnvelopeV1 {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (cause) {
    throw new ModuleDownloaderError('INVALID_CATALOG_WIRE', 'Catalog envelope is not strict UTF-8 JSON', { cause })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ModuleDownloaderError('INVALID_CATALOG_WIRE', 'Catalog envelope must be a plain JSON object')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.length !== WIRE_FIELDS.length || WIRE_FIELDS.some((field) => !Object.hasOwn(record, field))) {
    throw new ModuleDownloaderError('INVALID_CATALOG_WIRE', 'Catalog envelope fields are invalid')
  }
  if (keys.some((key) => !WIRE_FIELDS.includes(key as (typeof WIRE_FIELDS)[number]))) {
    throw new ModuleDownloaderError('INVALID_CATALOG_WIRE', 'Catalog envelope contains unknown fields')
  }
  if (record.schemaVersion !== 1 || typeof record.keyId !== 'string') {
    throw new ModuleDownloaderError('INVALID_CATALOG_WIRE', 'Catalog envelope schemaVersion or keyId is invalid')
  }
  return {
    schemaVersion: 1,
    keyId: record.keyId,
    catalogBytes: decodeCanonicalBase64(record.catalogBytes, 'catalogBytes'),
    signature: decodeCanonicalBase64(record.signature, 'signature'),
  }
}

function decodeCanonicalBase64(value: unknown, field: string): Uint8Array {
  if (typeof value !== 'string' || !BASE64_PATTERN.test(value)) {
    throw new ModuleDownloaderError('INVALID_CATALOG_WIRE', `${field} must be canonical padded base64`)
  }
  const bytes = Uint8Array.from(Buffer.from(value, 'base64'))
  if (Buffer.from(bytes).toString('base64') !== value) {
    throw new ModuleDownloaderError('INVALID_CATALOG_WIRE', `${field} must use canonical base64 encoding`)
  }
  return bytes
}
