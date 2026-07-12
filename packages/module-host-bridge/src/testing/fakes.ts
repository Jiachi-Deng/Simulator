import type {
  ApprovalResolution,
  AuditSink,
  Clock,
  EntropySource,
  EventEnvelope,
  PathAuthority,
  PathResolution,
  TokenHasher,
  TrustedApprovalResolver,
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

  map(input: string, canonicalPath: string, realPath = canonicalPath): this {
    this.resolutions.set(input, { canonicalPath: normalize(canonicalPath), realPath: normalize(realPath) })
    return this
  }

  async resolve(untrustedPath: string): Promise<PathResolution> {
    const mapped = this.resolutions.get(untrustedPath)
    if (mapped) return { ...mapped }
    const path = normalize(untrustedPath)
    return { canonicalPath: path, realPath: path }
  }

  isEqualOrWithin(candidateRealPath: string, rootRealPath: string): boolean {
    const candidate = normalize(candidateRealPath)
    const root = normalize(rootRealPath)
    return candidate === root || candidate.startsWith(root === '/' ? '/' : `${root}/`)
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
  const rooted = path.startsWith('/') ? path : `/${path}`
  const parts: string[] = []
  for (const part of rooted.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}
