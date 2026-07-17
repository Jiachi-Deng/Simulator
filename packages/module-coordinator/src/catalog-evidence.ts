import type { ModuleCoordinatorCatalogEvidence } from './types.ts'

const EVIDENCE_FIELDS = ['schemaVersion', 'sequence', 'issuedAt', 'expiresAt', 'artifactSize'] as const

function fail(label: string, field?: string): never {
  throw new Error(`${label}${field ? `.${field}` : ''} is invalid`)
}

function positiveSafeInteger(input: unknown, label: string, field: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1) fail(label, field)
  return input
}

function canonicalTimestamp(input: unknown, label: string, field: string): string {
  if (typeof input !== 'string') fail(label, field)
  const timestamp = Date.parse(input)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== input) fail(label, field)
  return input
}

/** Strictly validates the durable Catalog facts without accepting unknown fields. */
export function parseModuleCoordinatorCatalogEvidence(
  input: unknown,
  label = 'catalogEvidence',
): ModuleCoordinatorCatalogEvidence {
  if (input === null
    || typeof input !== 'object'
    || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype) {
    fail(label)
  }
  const value = input as Record<string, unknown>
  if (Object.keys(value).length !== EVIDENCE_FIELDS.length
    || EVIDENCE_FIELDS.some((field) => !Object.hasOwn(value, field))) {
    fail(label)
  }
  if (value.schemaVersion !== 1) fail(label, 'schemaVersion')
  const sequence = positiveSafeInteger(value.sequence, label, 'sequence')
  const issuedAt = canonicalTimestamp(value.issuedAt, label, 'issuedAt')
  const expiresAt = canonicalTimestamp(value.expiresAt, label, 'expiresAt')
  const artifactSize = positiveSafeInteger(value.artifactSize, label, 'artifactSize')
  if (Date.parse(issuedAt) >= Date.parse(expiresAt)) fail(label, 'expiresAt')
  return { schemaVersion: 1, sequence, issuedAt, expiresAt, artifactSize }
}
