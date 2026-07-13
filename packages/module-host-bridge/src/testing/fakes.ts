import type {
  ApprovalResolution,
  AuditSink,
  Clock,
  CredentialAuthority,
  EntropySource,
  EventEnvelope,
  PathAuthority,
  PathResolution,
  TokenHasher,
  TrustedApprovalResolver,
  URLAuthority,
} from '../types.ts'

export class FakeClock implements Clock {
  constructor(private current = 1_000) {}
  now(): number { return this.current }
  set(value: number): void { this.current = value }
  advance(milliseconds: number): void { this.current += milliseconds }
}

export class FakeEntropy implements EntropySource {
  private sequence = 0

  bytes(length: number): Uint8Array {
    const result = new Uint8Array(length)
    for (let index = 0; index < length; index += 1) result[index] = (this.sequence + index) & 0xff
    this.sequence = (this.sequence + length) & 0xff
    return result
  }
}

export class FakeTokenHasher implements TokenHasher {
  hash(value: string): string {
    const lanes = new Uint32Array([
      0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35,
      0x27d4eb2f, 0x165667b1, 0xd3a2646c, 0xfd7046c5,
    ])
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index)
      for (let lane = 0; lane < lanes.length; lane += 1) {
        lanes[lane] = Math.imul((lanes[lane]! ^ (code + lane)), 0x01000193) >>> 0
      }
    }
    return Array.from(lanes, lane => lane.toString(16).padStart(8, '0')).join('')
  }
}

export class FakePathAuthority implements PathAuthority {
  readonly resolutions = new Map<string, PathResolution>()

  constructor(private readonly options: { caseSensitive?: boolean } = {}) {}

  map(input: string, canonicalPath: string, realPath = canonicalPath): this {
    this.resolutions.set(input, {
      canonicalPath: normalize(canonicalPath),
      realPath: normalize(realPath),
    })
    return this
  }

  async resolve(untrustedPath: string): Promise<PathResolution> {
    const mapped = this.resolutions.get(untrustedPath)
    if (mapped) return { ...mapped }
    const path = normalize(untrustedPath)
    return { canonicalPath: path, realPath: path }
  }

  isEqualOrWithin(candidateRealPath: string, rootRealPath: string): boolean {
    const fold = (value: string) => this.options.caseSensitive === false ? value.toLocaleLowerCase('en-US') : value
    const candidate = fold(normalize(candidateRealPath))
    const root = fold(normalize(rootRealPath))
    return candidate === root || candidate.startsWith(root === '/' ? '/' : `${root}/`)
  }
}

interface FakeCredentialGrant {
  opaqueHandle: string
  ownerId: string
  moduleId: string
  processId: string
  operation: string
}

export class FakeCredentialAuthority implements CredentialAuthority {
  readonly grants: FakeCredentialGrant[] = []

  allow(grant: FakeCredentialGrant): this {
    this.grants.push({ ...grant })
    return this
  }

  validate(input: FakeCredentialGrant): boolean {
    return this.grants.some(grant => Object.keys(grant).every(key => (
      grant[key as keyof FakeCredentialGrant] === input[key as keyof FakeCredentialGrant]
    )))
  }
}

export class FakeURLAuthority implements URLAuthority {
  readonly allowedSchemes = new Set(['https:'])
  readonly allowedOrigins = new Set<string>()

  allowOrigin(origin: string): this {
    this.allowedOrigins.add(new URL(origin).origin)
    return this
  }

  authorize(input: Parameters<URLAuthority['authorize']>[0]): { authorized: boolean; normalizedUrl?: string } {
    let url: URL
    try {
      url = new URL(input.url)
    } catch {
      return { authorized: false }
    }
    if (!this.allowedSchemes.has(url.protocol)) return { authorized: false }
    if (this.allowedOrigins.size > 0 && !this.allowedOrigins.has(url.origin)) return { authorized: false }
    return { authorized: true, normalizedUrl: url.href }
  }
}

export class FakeAuditSink implements AuditSink {
  readonly events: EventEnvelope[] = []
  record(event: EventEnvelope): void { this.events.push(structuredClone(event)) }
}

interface PendingResolution {
  input: Parameters<TrustedApprovalResolver['resolve']>[0]
  resolve: (resolution: ApprovalResolution) => void
  reject: (error: Error) => void
}

export class FakeApprovalResolver implements TrustedApprovalResolver {
  readonly pending: PendingResolution[] = []

  resolve(input: PendingResolution['input']): Promise<ApprovalResolution> {
    return new Promise((resolve, reject) => this.pending.push({ input: structuredClone(input), resolve, reject }))
  }

  approve(index = 0, reason?: string): void {
    const pending = this.take(index)
    pending.resolve({ decision: 'approved', ...(reason ? { reason } : {}) })
  }

  deny(index = 0, reason?: string): void {
    const pending = this.take(index)
    pending.resolve({ decision: 'denied', ...(reason ? { reason } : {}) })
  }

  fail(index = 0): void {
    this.take(index).reject(new Error('fake resolver failure'))
  }

  private take(index: number): PendingResolution {
    const [pending] = this.pending.splice(index, 1)
    if (!pending) throw new Error(`No pending approval at index ${index}`)
    return pending
  }
}

function normalize(path: string): string {
  const slashed = path.replaceAll('\\', '/')
  const drive = /^([A-Za-z]):(?:\/|$)/.exec(slashed)
  const unc = slashed.startsWith('//')
  const prefix = drive ? `${drive[1]!.toUpperCase()}:` : unc ? '//' : '/'
  const remainder = drive ? slashed.slice(2) : unc ? slashed.slice(2) : slashed
  const parts: string[] = []
  for (const part of remainder.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  if (prefix === '//') return `//${parts.join('/')}`
  if (prefix.endsWith(':')) return `${prefix}/${parts.join('/')}`
  return `/${parts.join('/')}`
}
