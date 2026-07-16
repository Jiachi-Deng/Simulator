import { createHash } from 'node:crypto'
import { parseModuleManifest, type ModuleArtifact, type ModuleId, type ModuleVersion } from '@simulator/module-contract'
import { parseModuleCoordinatorCatalogEvidence } from './catalog-evidence.ts'
import {
  MODULE_COORDINATOR_STATE_SCHEMA_VERSION,
  type ModuleCoordinatorCheckpoint,
  type ModuleCoordinatorEvent,
  type ModuleCoordinatorInstallRequest,
  type ModuleCoordinatorModuleRequest,
  type ModuleCoordinatorOperation,
  type ModuleCoordinatorOperationKind,
  type ModuleCoordinatorOperationResult,
  type ModuleCoordinatorRequest,
  type ModuleCoordinatorState,
  type ModuleCoordinatorTargetState,
} from './types.ts'

const MAX_OPERATIONS = 10_000
const MAX_EVENTS = 256
const MAX_TEXT = 16_384
const OPERATION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/
const SHA256 = /^[a-f0-9]{64}$/
const MODULE_ID = /^(?=.{3,128}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const KINDS = new Set<ModuleCoordinatorOperationKind>(['install', 'update', 'rollback', 'start', 'restart', 'stop', 'uninstall'])
const CHECKPOINTS = new Set<ModuleCoordinatorCheckpoint>([
  'intent-recorded', 'runtime-detached', 'daemon-stopped', 'catalog-verified', 'artifact-downloaded',
  'installed', 'registered', 'activation-restored', 'registry-restored', 'daemon-started', 'view-attached',
  'version-uninstalled', 'registry-removed', 'compensation-started', 'compensation-runtime-detached',
  'compensation-daemon-stopped', 'compensation-activation-restored', 'compensation-registry-restored',
  'compensation-daemon-started', 'compensation-view-attached', 'completed', 'compensated',
])
const FORWARD: Record<ModuleCoordinatorOperationKind, ReadonlySet<ModuleCoordinatorCheckpoint>> = {
  install: new Set(['intent-recorded', 'catalog-verified', 'artifact-downloaded', 'installed', 'registered', 'activation-restored', 'registry-restored', 'completed']),
  update: new Set(['intent-recorded', 'runtime-detached', 'daemon-stopped', 'catalog-verified', 'artifact-downloaded', 'installed', 'registered', 'activation-restored', 'registry-restored', 'daemon-started', 'view-attached', 'completed']),
  rollback: new Set(['intent-recorded', 'runtime-detached', 'daemon-stopped', 'activation-restored', 'registry-restored', 'daemon-started', 'view-attached', 'completed']),
  start: new Set(['intent-recorded', 'daemon-started', 'view-attached', 'completed']),
  restart: new Set(['intent-recorded', 'runtime-detached', 'daemon-stopped', 'daemon-started', 'view-attached', 'completed']),
  stop: new Set(['intent-recorded', 'runtime-detached', 'daemon-stopped', 'completed']),
  uninstall: new Set(['intent-recorded', 'version-uninstalled', 'registry-removed', 'completed']),
}
const COMPENSATING = new Set<ModuleCoordinatorCheckpoint>([
  'compensation-started', 'compensation-runtime-detached', 'compensation-daemon-stopped',
  'compensation-activation-restored', 'compensation-registry-restored', 'compensation-daemon-started',
  'compensation-view-attached', 'compensated',
])
const DAEMON_STATES = new Set(['starting', 'healthy', 'degraded', 'stopping', 'stopped', 'crashed'])
const DIAGNOSTIC_CODES = new Set([
  'ENTRYPOINT_INVALID', 'ENTRYPOINT_OUTSIDE_ACTIVATED_ROOT', 'ENTRYPOINT_NOT_EXECUTABLE', 'ARTIFACT_NOT_FOUND',
  'ENDPOINT_ALLOCATION_FAILED', 'ENDPOINT_NOT_LOOPBACK', 'SPAWN_FAILED', 'STARTUP_TIMEOUT', 'READINESS_MALFORMED',
  'PROCESS_EXITED', 'PROCESS_CLEANUP_FAILED', 'HEALTH_DEGRADED', 'HEALTH_TIMEOUT', 'RESTART_BUDGET_EXHAUSTED',
  'IDLE_TIMEOUT', 'STOP_REQUESTED', 'MANAGER_DRAINING',
])

function fail(message: string): never {
  throw new Error(message)
}

function record(input: unknown, label: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    fail(`${label} must be a plain object`)
  }
  return input as Record<string, unknown>
}

function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  const accepted = new Set([...required, ...optional])
  if (Object.keys(value).some((key) => !accepted.has(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    fail(`${label} fields are invalid`)
  }
}

function array(input: unknown, limit: number, label: string): readonly unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > limit) fail(`${label} must be a bounded plain array`)
  for (let index = 0; index < input.length; index += 1) if (!Object.hasOwn(input, index)) fail(`${label} must be dense`)
  return input
}

function text(input: unknown, label: string, pattern?: RegExp): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_TEXT || (pattern && !pattern.test(input))) fail(`${label} is invalid`)
  return input
}

function integer(input: unknown, label: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) fail(`${label} is invalid`)
  return input
}

function boolean(input: unknown, label: string): boolean {
  if (typeof input !== 'boolean') fail(`${label} must be boolean`)
  return input
}

function nullableVersion(input: unknown, label: string): ModuleVersion | null {
  return input === null ? null : text(input, label, VERSION) as ModuleVersion
}

function target(input: unknown, label: string): ModuleCoordinatorTargetState {
  const value = record(input, label)
  fields(value, ['activeVersion', 'lastKnownGoodVersion', 'running', 'viewAttached', 'registryPresent'], [], label)
  const output = {
    activeVersion: nullableVersion(value.activeVersion, `${label}.activeVersion`),
    lastKnownGoodVersion: nullableVersion(value.lastKnownGoodVersion, `${label}.lastKnownGoodVersion`),
    running: boolean(value.running, `${label}.running`),
    viewAttached: boolean(value.viewAttached, `${label}.viewAttached`),
    registryPresent: boolean(value.registryPresent, `${label}.registryPresent`),
  }
  if (output.viewAttached && !output.running) fail(`${label} cannot attach a view without a running daemon`)
  return output
}

function sameStringArray(left: readonly string[] | undefined, right: unknown): boolean {
  if (left === undefined) return right === undefined
  if (!Array.isArray(right) || right.length !== left.length) return false
  return left.every((value, index) => Object.hasOwn(right, index) && right[index] === value)
}

function artifact(input: unknown, manifestArtifacts: readonly ModuleArtifact[], label: string): ModuleArtifact {
  const value = record(input, label)
  fields(value, ['platform', 'entrypoint', 'url', 'sha256'], ['auxiliaryExecutables'], label)
  const match = manifestArtifacts.find((candidate) => candidate.platform === value.platform
    && candidate.entrypoint === value.entrypoint
    && sameStringArray(candidate.auxiliaryExecutables, value.auxiliaryExecutables)
    && candidate.url === value.url
    && candidate.sha256 === value.sha256)
  if (!match) fail(`${label} must exactly match a manifest artifact`)
  return match
}

function request(kind: ModuleCoordinatorOperationKind, input: unknown, operationId: string): ModuleCoordinatorRequest {
  const value = record(input, 'operation.request')
  if (text(value.operationId, 'operation.request.operationId', OPERATION_ID) !== operationId) fail('request operationId does not match operation id')
  if (kind === 'install' || kind === 'update') {
    fields(value, ['operationId', 'catalogUrl', 'descriptor', 'hostVersionRange'], ['catalogEvidence'], 'operation.request')
    const descriptor = record(value.descriptor, 'operation.request.descriptor')
    fields(descriptor, ['verified', 'manifest', 'artifact', 'extractedManifestSha256', 'format'], [], 'operation.request.descriptor')
    if (descriptor.verified !== true || descriptor.format !== 'tar.gz') fail('operation descriptor trust marker or format is invalid')
    const parsed = parseModuleManifest(descriptor.manifest)
    if (!parsed.ok) fail('operation descriptor manifest is invalid')
    return {
      operationId,
      catalogUrl: text(value.catalogUrl, 'operation.request.catalogUrl'),
      descriptor: {
        verified: true,
        manifest: parsed.value,
        artifact: artifact(descriptor.artifact, parsed.value.artifacts, 'operation.request.descriptor.artifact'),
        extractedManifestSha256: text(descriptor.extractedManifestSha256, 'operation.request.descriptor.extractedManifestSha256', SHA256) as never,
        format: 'tar.gz',
      },
      hostVersionRange: text(value.hostVersionRange, 'operation.request.hostVersionRange'),
      ...(Object.hasOwn(value, 'catalogEvidence')
        ? { catalogEvidence: parseModuleCoordinatorCatalogEvidence(value.catalogEvidence, 'operation.request.catalogEvidence') }
        : {}),
    }
  }
  if (kind === 'rollback') {
    fields(value, ['operationId', 'moduleId'], ['restartAfterRollback'], 'operation.request')
    return {
      operationId,
      moduleId: text(value.moduleId, 'operation.request.moduleId', MODULE_ID) as ModuleId,
      ...(Object.hasOwn(value, 'restartAfterRollback') ? { restartAfterRollback: boolean(value.restartAfterRollback, 'operation.request.restartAfterRollback') } : {}),
    }
  }
  if (kind === 'uninstall') {
    fields(value, ['operationId', 'moduleId', 'version'], [], 'operation.request')
    return {
      operationId,
      moduleId: text(value.moduleId, 'operation.request.moduleId', MODULE_ID) as ModuleId,
      version: text(value.version, 'operation.request.version', VERSION) as ModuleVersion,
    }
  }
  fields(value, ['operationId', 'moduleId'], [], 'operation.request')
  return { operationId, moduleId: text(value.moduleId, 'operation.request.moduleId', MODULE_ID) as ModuleId }
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const item = value as Record<string, unknown>
  return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${stable(item[key])}`).join(',')}}`
}

function fingerprint(kind: ModuleCoordinatorOperationKind, moduleId: ModuleId, value: ModuleCoordinatorRequest): string {
  const normalized = structuredClone(value) as unknown as Record<string, unknown>
  delete normalized.operationId
  return createHash('sha256').update(stable({ kind, moduleId, request: normalized })).digest('hex')
}

function result(input: unknown, operation: Pick<ModuleCoordinatorOperation, 'id' | 'moduleId' | 'kind' | 'source' | 'target'>): ModuleCoordinatorOperationResult {
  const value = record(input, 'operation.result')
  fields(value, ['operationId', 'moduleId', 'kind', 'ok', 'source', 'target', 'completedAt'], ['error'], 'operation.result')
  if (value.operationId !== operation.id || value.moduleId !== operation.moduleId || value.kind !== operation.kind) fail('operation result identity is invalid')
  const parsed = {
    operationId: operation.id,
    moduleId: operation.moduleId,
    kind: operation.kind,
    ok: boolean(value.ok, 'operation.result.ok'),
    source: target(value.source, 'operation.result.source'),
    target: target(value.target, 'operation.result.target'),
    completedAt: integer(value.completedAt, 'operation.result.completedAt'),
    ...(Object.hasOwn(value, 'error') ? { error: text(value.error, 'operation.result.error') } : {}),
  }
  if (stable(parsed.source) !== stable(operation.source) || stable(parsed.target) !== stable(operation.target)) fail('operation result state does not match intent')
  return parsed
}

function operation(input: unknown): ModuleCoordinatorOperation {
  const value = record(input, 'operation')
  fields(value, ['id', 'moduleId', 'kind', 'fingerprint', 'phase', 'checkpoint', 'status', 'createdAt', 'updatedAt', 'request', 'source', 'target'], ['result', 'error'], 'operation')
  const id = text(value.id, 'operation.id', OPERATION_ID)
  const moduleId = text(value.moduleId, 'operation.moduleId', MODULE_ID) as ModuleId
  const kind = text(value.kind, 'operation.kind') as ModuleCoordinatorOperationKind
  if (!KINDS.has(kind)) fail('operation.kind is invalid')
  const phase = value.phase === 'forward' || value.phase === 'compensating' ? value.phase : fail('operation.phase is invalid')
  const checkpoint = text(value.checkpoint, 'operation.checkpoint') as ModuleCoordinatorCheckpoint
  if (!CHECKPOINTS.has(checkpoint) || !(phase === 'forward' ? FORWARD[kind].has(checkpoint) : COMPENSATING.has(checkpoint))) fail('operation checkpoint is invalid for its phase')
  const status = value.status === 'pending' || value.status === 'completed' || value.status === 'failed' ? value.status : fail('operation.status is invalid')
  const parsedRequest = request(kind, value.request, id)
  const requestModuleId = kind === 'install' || kind === 'update'
    ? (parsedRequest as ModuleCoordinatorInstallRequest).descriptor.manifest.id
    : (parsedRequest as ModuleCoordinatorModuleRequest).moduleId
  if (requestModuleId !== moduleId) fail('operation moduleId does not match request')
  const parsed: ModuleCoordinatorOperation = {
    id,
    moduleId,
    kind,
    fingerprint: text(value.fingerprint, 'operation.fingerprint', SHA256),
    phase,
    checkpoint,
    status,
    createdAt: integer(value.createdAt, 'operation.createdAt'),
    updatedAt: integer(value.updatedAt, 'operation.updatedAt'),
    request: parsedRequest,
    source: target(value.source, 'operation.source'),
    target: target(value.target, 'operation.target'),
    ...(Object.hasOwn(value, 'error') ? { error: text(value.error, 'operation.error') } : {}),
  }
  if (parsed.updatedAt < parsed.createdAt || parsed.fingerprint !== fingerprint(kind, moduleId, parsedRequest)) fail('operation fingerprint or timestamps are invalid')
  if (Object.hasOwn(value, 'result')) (parsed as { result?: ModuleCoordinatorOperationResult }).result = result(value.result, parsed)
  if (status === 'completed' && (checkpoint !== 'completed' || !parsed.result?.ok)) fail('completed operation terminal state is invalid')
  if (status === 'failed' && (checkpoint !== 'compensated' || parsed.result?.ok !== false)) fail('failed operation terminal state is invalid')
  if (status === 'pending' && parsed.result) fail('pending operation cannot contain a result')
  return parsed
}

function event(input: unknown): ModuleCoordinatorEvent {
  const value = record(input, 'event')
  fields(value, ['moduleId', 'at', 'snapshot'], [], 'event')
  const moduleId = text(value.moduleId, 'event.moduleId', MODULE_ID) as ModuleId
  const snapshot = record(value.snapshot, 'event.snapshot')
  fields(snapshot, ['id', 'version', 'state', 'restartCount'], ['endpoint', 'pid', 'diagnostic'], 'event.snapshot')
  if (snapshot.id !== moduleId || !DAEMON_STATES.has(snapshot.state as string)) fail('event snapshot identity or state is invalid')
  const parsedSnapshot: ModuleCoordinatorEvent['snapshot'] = {
    id: moduleId,
    version: text(snapshot.version, 'event.snapshot.version', VERSION) as ModuleVersion,
    state: snapshot.state as ModuleCoordinatorEvent['snapshot']['state'],
    restartCount: integer(snapshot.restartCount, 'event.snapshot.restartCount'),
    ...(Object.hasOwn(snapshot, 'pid') ? { pid: integer(snapshot.pid, 'event.snapshot.pid') } : {}),
  }
  if (Object.hasOwn(snapshot, 'endpoint')) {
    const endpoint = record(snapshot.endpoint, 'event.snapshot.endpoint')
    fields(endpoint, ['host', 'port'], [], 'event.snapshot.endpoint')
    if (endpoint.host !== '127.0.0.1' && endpoint.host !== '::1') fail('event endpoint host is not loopback')
    ;(parsedSnapshot as { endpoint?: { host: '127.0.0.1' | '::1'; port: number } }).endpoint = { host: endpoint.host, port: integer(endpoint.port, 'event.snapshot.endpoint.port') }
  }
  if (Object.hasOwn(snapshot, 'diagnostic')) {
    const diagnostic = record(snapshot.diagnostic, 'event.snapshot.diagnostic')
    fields(diagnostic, ['code', 'message', 'at', 'restartCount'], [], 'event.snapshot.diagnostic')
    if (!DIAGNOSTIC_CODES.has(diagnostic.code as string)) fail('event diagnostic code is invalid')
    ;(parsedSnapshot as { diagnostic?: ModuleCoordinatorEvent['snapshot']['diagnostic'] }).diagnostic = {
      code: diagnostic.code as NonNullable<ModuleCoordinatorEvent['snapshot']['diagnostic']>['code'],
      message: text(diagnostic.message, 'event.snapshot.diagnostic.message'),
      at: integer(diagnostic.at, 'event.snapshot.diagnostic.at'),
      restartCount: integer(diagnostic.restartCount, 'event.snapshot.diagnostic.restartCount'),
    }
  }
  return { moduleId, at: integer(value.at, 'event.at'), snapshot: parsedSnapshot }
}

export function parseModuleCoordinatorState(input: unknown): ModuleCoordinatorState {
  const value = record(input, 'state')
  fields(value, ['schemaVersion', 'operations', 'events'], [], 'state')
  if (value.schemaVersion !== MODULE_COORDINATOR_STATE_SCHEMA_VERSION) fail('state schema version is unsupported')
  const operations = array(value.operations, MAX_OPERATIONS, 'state.operations').map(operation)
  if (new Set(operations.map((item) => item.id)).size !== operations.length) fail('operation ids must be unique')
  const events = array(value.events, MAX_EVENTS, 'state.events').map(event)
  return { schemaVersion: MODULE_COORDINATOR_STATE_SCHEMA_VERSION, operations, events }
}
