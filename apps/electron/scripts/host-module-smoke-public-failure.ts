const SMOKE_INTERNAL_ERROR = 'SMOKE_INTERNAL_ERROR'
const SAFE_SMOKE_PHASES = new Set([
  10, 20, 30, 40, 50,
  60, 61, 62, 63, 64, 65, 66, 67, 68,
  70, 80,
  90, 91, 92, 93, 94, 95, 96, 97, 98,
  100, 110,
  120, 121, 122, 123, 124, 125, 126, 127, 128,
  130, 140, 150,
])

const SAFE_ARGUMENT_FAILURES = new Set([
  'Unknown argument',
  '--app requires a value',
  '--scenario requires a value',
  '--app may be specified only once',
  '--scenario may be specified only once',
  '--scenario must be v1-compat or v2-open-design-rc',
  '--scenario is required',
])

export const SAFE_WRAPPER_FAILURE_CODES = new Set([
  'FIXTURE_BUILD_FAILED',
  'SMOKE_OWNED_PROCESS_SIGNAL_FAILED',
  'SMOKE_OWNED_PROCESS_REAP_FAILED',
  'SMOKE_EXECUTABLE_MISSING',
  'SMOKE_CHILD_REAP_FAILED',
  'SMOKE_CHILD_TIMEOUT',
  'SMOKE_RESULT_MISSING',
  'SMOKE_RESULT_INVALID',
  'SMOKE_CHILD_FAILED',
  'SMOKE_PACKAGED_STATE_INVALID',
  'SMOKE_FIXTURE_IDENTITY_INVALID',
  'SMOKE_ASSERTIONS_FAILED',
  'SMOKE_CONTRACT_VERSION_INVALID',
  'SMOKE_V2_EVIDENCE_INCOMPLETE',
  'SMOKE_V1_EVIDENCE_INCOMPLETE',
  'SMOKE_PROCESS_EVIDENCE_INVALID',
  'SMOKE_PROCESS_RESIDUE',
  'SMOKE_PROCESS_GROUP_RESIDUE',
  'SMOKE_SERVER_LOCK_RESIDUE',
  'SMOKE_SESSION_PERSISTENCE_INVALID',
])

export const SAFE_WRAPPER_DETAIL_KEYS = new Set([
  'status',
  'phase',
  'resultBytes',
  'stdoutBytes',
  'stderrBytes',
])

function isSafeDetail(detail: string, seenKeys: Set<string>): boolean {
  const separator = detail.indexOf('=')
  if (separator <= 0 || separator !== detail.lastIndexOf('=')) return false
  const key = detail.slice(0, separator)
  const valueText = detail.slice(separator + 1)
  const value = Number(valueText)
  if (!SAFE_WRAPPER_DETAIL_KEYS.has(key) || seenKeys.has(key)) return false
  if (!Number.isSafeInteger(value) || String(value) !== valueText) return false
  if (key === 'phase' && !SAFE_SMOKE_PHASES.has(value)) return false
  seenKeys.add(key)
  return true
}

export function publicWrapperFailure(error: unknown): string {
  if (!(error instanceof Error)) return SMOKE_INTERNAL_ERROR
  if (SAFE_ARGUMENT_FAILURES.has(error.message)) return error.message

  const parts = error.message.split(' ')
  const code = parts.shift()
  if (!code || !SAFE_WRAPPER_FAILURE_CODES.has(code)) return SMOKE_INTERNAL_ERROR

  const seenKeys = new Set<string>()
  if (!parts.every((detail) => isSafeDetail(detail, seenKeys))) return SMOKE_INTERNAL_ERROR
  return error.message
}
