import { describe, expect, it } from 'bun:test'
import type { OpenDesignM1InteractionVector } from './open-design-m1-interaction-vectors'
import {
  OPEN_DESIGN_M1_INTERACTION_VECTORS,
} from './open-design-m1-interaction-vectors'
import {
  createDeterministicOpenDesignM1InteractionEvidenceFixture,
  createSchemaMaximumOpenDesignM1InteractionEvidenceFixture,
  OPEN_DESIGN_M1_INTERACTION_MAX_BYTES,
  openDesignM1NormalizedOutcomeDigest,
  runOpenDesignM1PreviewInteraction,
  validateOpenDesignM1InteractionEvidence,
  type InteractionCdpSession,
} from './open-design-m1-preview-interactions'

const previewUrl = 'http://127.0.0.1:45001/'
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])

const vector: OpenDesignM1InteractionVector = {
  schemaVersion: 2,
  caseId: 'D99',
  viewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
  instructions: 'A deterministic visible button changes a real visible state node.',
  targets: [{ semanticId: 'D99.button', kind: 'control', initiallyVisible: true }],
  captures: [{ id: 'button', kind: 'element', semanticId: 'D99.button' }],
  initialAssertions: [{
    id: 'initial-idle', kind: 'compare', comparison: 'equals',
    left: { stage: 'initial', capture: 'button', field: 'attribute', attribute: 'data-m1-state' },
    right: { literal: 'idle' },
  }],
  scenarios: [{
    id: 'activate',
    reset: 'clear-origin-storage-and-reload',
    actions: [{ kind: 'pointerClick', target: 'D99.button' }],
    assertions: [{
      id: 'button-active', kind: 'compare', comparison: 'equals',
      left: { stage: 'final', capture: 'button', field: 'attribute', attribute: 'data-m1-state' },
      right: { literal: 'active' },
    }],
  }],
}

function belowFoldVector(caseId: 'L01' | 'F02'): OpenDesignM1InteractionVector {
  const semanticId = `${caseId}.below-fold`
  return {
    ...vector,
    caseId,
    instructions: 'A real below-fold control is scrolled into view through the fixed CDP DOM authority before trusted input.',
    targets: [{ semanticId, kind: 'control', initiallyVisible: true }],
    captures: [{ id: 'button', kind: 'element', semanticId }],
    scenarios: [{
      ...vector.scenarios[0]!,
      actions: [{ kind: 'pointerClick', target: semanticId }],
    }],
  }
}

function renderedCollectionVector(): OpenDesignM1InteractionVector {
  const base = belowFoldVector('L01')
  return {
    ...base,
    captures: [...base.captures, { id: 'rows', kind: 'collection', semanticPrefix: 'L01.row.' }],
    initialAssertions: [{
      id: 'rendered-anywhere', kind: 'compare', comparison: 'equals',
      left: { stage: 'initial', capture: 'rows', field: 'visibleCount' },
      right: { literal: 2 },
    }],
  }
}

class MockSession implements InteractionCdpSession {
  readonly #listeners = new Set<(method: string, params: Record<string, unknown>) => void>()
  readonly dead: boolean
  readonly fault?: 'console' | 'network'
  readonly semanticId: string
  readonly belowFold: boolean
  readonly mainWorldForgery: boolean
  clicked = false
  scrolled = false
  observerNext = 0
  activeContextId = 0
  nextContextId = 40
  events: Array<{ sequence: number; type: string; isTrusted: boolean; target: string }> = []
  readonly calls: string[] = []
  readonly observerReadContexts: Array<number | undefined> = []
  readonly evaluatedExpressions: string[] = []

  constructor(options: {
    dead?: boolean
    fault?: 'console' | 'network'
    semanticId?: string
    belowFold?: boolean
    mainWorldForgery?: boolean
  } = {}) {
    this.dead = options.dead ?? false
    this.fault = options.fault
    this.semanticId = options.semanticId ?? 'D99.button'
    this.belowFold = options.belowFold ?? false
    this.mainWorldForgery = options.mainWorldForgery ?? false
  }
  async connect(): Promise<void> {}
  onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
  close(): void {}
  async screenshot(): Promise<Buffer> { return png }

  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    this.calls.push(method)
    if (method === 'Runtime.enable' && this.fault === 'console') {
      for (const listener of this.#listeners) listener('Runtime.exceptionThrown', {})
    }
    if (method === 'Network.enable' && this.fault === 'network') {
      for (const listener of this.#listeners) {
        listener('Network.requestWillBeSent', { requestId: 'external-1', request: { url: 'https://example.test/failure' } })
        listener('Network.loadingFailed', { requestId: 'external-1' })
      }
    }
    if (method === 'Page.navigate') {
      this.clicked = false
      this.scrolled = false
      this.observerNext = 0
      this.events = []
    }
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root-frame' } } }
    if (method === 'Page.createIsolatedWorld') {
      this.activeContextId = ++this.nextContextId
      return { executionContextId: this.activeContextId }
    }
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
    if (method === 'DOM.querySelectorAll') return { nodeIds: [2] }
    if (method === 'DOM.scrollIntoViewIfNeeded') this.scrolled = true
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
      if (!this.dead) this.clicked = true
      this.events.push({ sequence: ++this.observerNext, type: 'click', isTrusted: true, target: this.semanticId })
    }
    return {}
  }

  async evaluate(expression: string, executionContextId?: number): Promise<unknown> {
    this.evaluatedExpressions.push(expression)
    if (expression.includes('href:location.href')) return { href: previewUrl, readyState: 'complete' }
    if (expression.includes('events.slice(-64)')) {
      this.observerReadContexts.push(executionContextId)
      if (executionContextId !== this.activeContextId && this.mainWorldForgery) {
        return { next: 9_999, events: [{ sequence: 9_999, type: 'click', isTrusted: true, target: this.semanticId }] }
      }
      return { next: this.observerNext, events: this.events }
    }
    if (expression.includes('if(globalThis.__simulatorM1TrustedObserver)')) {
      if (executionContextId !== this.activeContextId) throw new Error('observer installed outside isolated world')
      return true
    }
    if (expression.includes('const prefix="L01.row."')) {
      return {
        overflow: false,
        items: [1, 2].map((ordinal) => ({
          id: `L01.row.${ordinal}`, attrs: {}, text: `row ${ordinal}`, value: '',
        })),
      }
    }
    if (expression.includes(`const id=${JSON.stringify(this.semanticId)}`)) {
      const inViewport = !this.belowFold || this.scrolled
      return {
        present: true,
        semanticId: this.semanticId,
        tag: 'button',
        role: '',
        visible: true,
        inViewport,
        enabled: true,
        checked: null,
        rect: { x: 10, y: inViewport ? 10 : 1_200, width: 80, height: 32 },
        hitIdentity: inViewport ? this.semanticId : null,
        attrs: { 'data-m1-state': this.clicked ? 'active' : 'idle' },
        text: 'Activate',
        value: '',
        numericValue: null,
      }
    }
    throw new Error(`unexpected observation: ${expression.slice(0, 60)}`)
  }
}

async function run(options: {
  dead?: boolean
  fault?: 'console' | 'network'
  vector?: OpenDesignM1InteractionVector
  belowFold?: boolean
  mainWorldForgery?: boolean
} = {}) {
  const requests: string[] = []
  const activeVector = options.vector ?? vector
  const semanticId = activeVector.targets[0]!.semanticId
  const session = new MockSession({ ...options, semanticId })
  const result = await runOpenDesignM1PreviewInteraction({
    previewUrl,
    vector: activeVector,
    captureScreenshot: true,
    fetchImpl: async (input, init) => {
      const url = String(input)
      requests.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.includes('/json/new?')) {
        return new Response(JSON.stringify({
          id: 'preview-interaction-test',
          type: 'page',
          webSocketDebuggerUrl: 'ws://127.0.0.1:9347/devtools/page/preview-interaction-test',
        }), { status: 200 })
      }
      return new Response('Target is closing', { status: 200 })
    },
    createSession: () => session,
  })
  return { requests, result, session }
}

describe('OpenDesign M1 fixed-cases/v2 Preview interaction runner', () => {
  it('uses trusted CDP input, seals a replayable capture chain, and closes the target', async () => {
    const { requests, result } = await run()
    expect(result.screenshot).toEqual(png)
    expect(result.interaction.ledger).toHaveLength(1)
    expect(result.interaction.ledger[0]!.actions).toHaveLength(1)
    expect(result.interaction.ledger[0]!.actions[0]).toMatchObject({
      kind: 'pointerClick', target: 'D99.button', isTrusted: true,
      hitTestIdentity: 'D99.button', observedEventTypes: ['click'],
    })
    expect(result.interaction.ledger[0]!.assertions).toEqual([{ id: 'button-active', passed: true }])
    expect(() => validateOpenDesignM1InteractionEvidence(vector, result.interaction)).not.toThrow()
    expect(requests[0]).toContain('PUT http://127.0.0.1:9347/json/new?')
    expect(requests.at(-1)).toBe('GET http://127.0.0.1:9347/json/close/preview-interaction-test')
  })

  it('fails closed when the real control is dead even though a trusted click was delivered', async () => {
    await expect(run({ dead: true })).rejects.toThrow('final assertions')
  }, 5_000)

  it('fails closed on a console exception or failed non-loopback request', async () => {
    await expect(run({ fault: 'console' })).rejects.toThrow('runtime-exception')
    await expect(run({ fault: 'network' })).rejects.toThrow('non-loopback-request-failure')
  })

  it('rejects wrong state, missing or duplicate actions, and vector mismatch after resealing attempts', async () => {
    const { result } = await run()
    const wrongState = structuredClone(result.interaction) as any
    wrongState.ledger[0].finalCaptures.button.attributes['data-m1-state'] = 'idle'
    await expect(() => validateOpenDesignM1InteractionEvidence(vector, wrongState)).toThrow('interaction evidence')

    const missing = structuredClone(result.interaction) as any
    missing.ledger[0].actions = []
    await expect(() => validateOpenDesignM1InteractionEvidence(vector, missing)).toThrow('ledger[0]')

    const duplicate = structuredClone(result.interaction) as any
    duplicate.ledger[0].actions.push(structuredClone(duplicate.ledger[0].actions[0]))
    await expect(() => validateOpenDesignM1InteractionEvidence(vector, duplicate)).toThrow('ledger[0]')

    const mismatch = structuredClone(result.interaction) as any
    mismatch.vectorSha256 = 'f'.repeat(64)
    await expect(() => validateOpenDesignM1InteractionEvidence(vector, mismatch)).toThrow('authority')

    const untrusted = structuredClone(result.interaction) as any
    untrusted.ledger[0].actions[0].isTrusted = false
    await expect(() => validateOpenDesignM1InteractionEvidence(vector, untrusted)).toThrow('actions[0]')

    const redundantSemanticAttribute = structuredClone(result.interaction) as any
    redundantSemanticAttribute.initial.captures.button.attributes['data-m1-id'] = 'D99.button'
    expect(() => validateOpenDesignM1InteractionEvidence(vector, redundantSemanticAttribute))
      .toThrow('attributes.authority')
  })

  it('rejects oversized evidence before accepting a structurally forged ledger', async () => {
    const { result } = await run()
    const oversized = structuredClone(result.interaction) as any
    oversized.ledger = Array.from({ length: 2_000 }, () => structuredClone(oversized.ledger[0]))
    expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBeGreaterThan(OPEN_DESIGN_M1_INTERACTION_MAX_BYTES)
    expect(() => validateOpenDesignM1InteractionEvidence(vector, oversized)).toThrow('$interaction.size')
  })

  it.each(['L01', 'F02'] as const)('scrolls a rendered below-fold %s control with CDP DOM authority before trusted input', async (caseId) => {
    const { result, session } = await run({ vector: belowFoldVector(caseId), belowFold: true })
    expect(result.interaction.ledger[0]!.actions[0]!.isTrusted).toBe(true)
    const scrollIndex = session.calls.indexOf('DOM.scrollIntoViewIfNeeded')
    const inputIndex = session.calls.indexOf('Input.dispatchMouseEvent')
    expect(scrollIndex).toBeGreaterThan(-1)
    expect(inputIndex).toBeGreaterThan(scrollIndex)
  })

  it('counts rendered collection members across the document instead of only the current viewport', async () => {
    const { result, session } = await run({ vector: renderedCollectionVector(), belowFold: true })
    expect(result.interaction.initial.captures.rows).toMatchObject({ kind: 'collection', visibleCount: 2 })
    const collectionProbe = session.evaluatedExpressions.find((expression) => expression.includes('const prefix="L01.row."'))!
    expect(collectionProbe).toContain("rect.width>0&&rect.height>0")
    expect(collectionProbe).not.toContain('rect.bottom>0')
    expect(collectionProbe).not.toContain('rect.top<innerHeight')
  })

  it('keeps the trusted-event ledger in an isolated execution context despite a main-world forgery', async () => {
    const { result, session } = await run({ mainWorldForgery: true })
    expect(result.interaction.ledger[0]!.actions[0]!.observedEventTypes).toContain('click')
    expect(session.observerReadContexts.length).toBeGreaterThan(0)
    expect(session.observerReadContexts.every((contextId) => contextId === session.activeContextId)).toBe(true)
    expect(session.calls.filter((method) => method === 'Page.createIsolatedWorld').length).toBeGreaterThanOrEqual(2)
  })

  it('derives S04 functional equivalence from actual passing cardinalities instead of a generic PASS shape', () => {
    const s04 = OPEN_DESIGN_M1_INTERACTION_VECTORS.find((candidate) => candidate.caseId === 'S04')!
    const first = structuredClone(createDeterministicOpenDesignM1InteractionEvidenceFixture(s04)) as any
    first.initial.captures.audits.visibleCount = 8
    first.initial.captures.table.attributes['data-m1-total'] = '12'
    first.normalizedOutcomeDigest = openDesignM1NormalizedOutcomeDigest(s04, first.initial, first.ledger)
    expect(() => validateOpenDesignM1InteractionEvidence(s04, first)).not.toThrow()

    const second = structuredClone(first) as any
    second.initial.captures.audits.visibleCount = 7
    second.initial.captures.table.attributes['data-m1-total'] = '13'
    second.normalizedOutcomeDigest = openDesignM1NormalizedOutcomeDigest(s04, second.initial, second.ledger)
    expect(() => validateOpenDesignM1InteractionEvidence(s04, second)).not.toThrow()
    expect(second.normalizedOutcomeDigest).not.toBe(first.normalizedOutcomeDigest)

    const tampered = structuredClone(first) as any
    tampered.initial.captures.audits.visibleCount = 7
    expect(() => validateOpenDesignM1InteractionEvidence(s04, tampered)).toThrow('normalizedOutcomeDigest')
  })

  it('normalizes opaque entity, signature, idDigest, and stateDigest values by their relation graph', () => {
    const relationVector: OpenDesignM1InteractionVector = {
      schemaVersion: 2,
      caseId: 'D98',
      viewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
      instructions: 'A fixed control preserves a rendered collection identity relation without exposing implementation-specific opaque identifiers.',
      targets: [{ semanticId: 'D98.control', kind: 'control', initiallyVisible: true }],
      captures: [{ id: 'items', kind: 'collection', semanticPrefix: 'D98.item.' }],
      initialAssertions: [],
      scenarios: [{
        id: 'preserve', reset: 'clear-origin-storage-and-reload',
        actions: [{ kind: 'pointerClick', target: 'D98.control' }],
        assertions: [{
          id: 'ids-preserved', kind: 'compare', comparison: 'equals',
          left: { stage: 'final', capture: 'items', field: 'idDigest' },
          right: { stage: 'initial', capture: 'items', field: 'idDigest' },
        }],
      }],
    }
    for (const candidate of [
      OPEN_DESIGN_M1_INTERACTION_VECTORS.find((value) => value.caseId === 'D01')!,
      OPEN_DESIGN_M1_INTERACTION_VECTORS.find((value) => value.caseId === 'D02')!,
      OPEN_DESIGN_M1_INTERACTION_VECTORS.find((value) => value.caseId === 'L04')!,
      relationVector,
    ]) {
      const original = createDeterministicOpenDesignM1InteractionEvidenceFixture(candidate)
      const rewritten = structuredClone(original) as any
      const replacements = new Map<string, string>()
      const rewrite = (category: string, value: string): string => {
        const key = `${category}:${value}`
        const existing = replacements.get(key)
        if (existing) return existing
        const next = `${category}-replacement-${replacements.size + 1}`
        replacements.set(key, next)
        return next
      }
      const snapshots = [rewritten.initial.captures, ...rewritten.ledger.flatMap((entry: any) => [
        entry.initialCaptures, entry.finalCaptures,
      ])]
      for (const snapshot of snapshots) {
        for (const capture of Object.values(snapshot) as any[]) {
          if (capture.kind === 'element') {
            for (const name of ['data-m1-entity-id', 'data-m1-selected-id']) {
              if (typeof capture.attributes[name] === 'string') capture.attributes[name] = rewrite('entity', capture.attributes[name])
            }
            if (typeof capture.attributes['data-m1-signature'] === 'string') {
              capture.attributes['data-m1-signature'] = rewrite('signature', capture.attributes['data-m1-signature'])
            }
          } else if (capture.kind === 'collection') {
            capture.idDigest = rewrite('id-digest', capture.idDigest)
            capture.stateDigest = rewrite('state-digest', capture.stateDigest)
          }
        }
      }
      expect(openDesignM1NormalizedOutcomeDigest(candidate, rewritten.initial, rewritten.ledger))
        .toBe(original.normalizedOutcomeDigest)
    }
  })

  it('accepts only no-escape printable 64-byte state tokens while preserving common product token forms', () => {
    const valid = [
      '123e4567-e89b-12d3-a456-426614174000',
      'a'.repeat(64),
      'true',
      '2026-07-17T12:34:56.789Z',
      'm1.acceptance@example.test',
    ]
    for (const token of valid) {
      const tokenVector: OpenDesignM1InteractionVector = {
        ...vector,
        caseId: 'D97',
        targets: [{ semanticId: 'D97.button', kind: 'control', initiallyVisible: true }],
        captures: [{ id: 'button', kind: 'element', semanticId: 'D97.button' }],
        initialAssertions: [{
          id: 'token-valid', kind: 'compare', comparison: 'equals',
          left: { stage: 'initial', capture: 'button', field: 'attribute', attribute: 'data-m1-state' },
          right: { literal: token },
        }],
        scenarios: [{
          id: 'preserve', reset: 'clear-origin-storage-and-reload',
          actions: [{ kind: 'pointerClick', target: 'D97.button' }],
          assertions: [{
            id: 'token-preserved', kind: 'compare', comparison: 'equals',
            left: { stage: 'final', capture: 'button', field: 'attribute', attribute: 'data-m1-state' },
            right: { literal: token },
          }],
        }],
      }
      expect(() => createDeterministicOpenDesignM1InteractionEvidenceFixture(tokenVector)).not.toThrow()
    }

    const fixture = createDeterministicOpenDesignM1InteractionEvidenceFixture(vector)
    for (const invalid of ['contains"quote', 'contains\\slash', 'contains\ncontrol', 'x'.repeat(65)]) {
      const tampered = structuredClone(fixture) as any
      tampered.initial.captures.button.attributes['data-m1-state'] = invalid
      expect(() => validateOpenDesignM1InteractionEvidence(vector, tampered)).toThrow('attributes')
    }
  })

  it('keeps every true schema-maximum fixed-case fixture below 192 KiB within the 256 KiB interaction cap', () => {
    const sizes = OPEN_DESIGN_M1_INTERACTION_VECTORS.map((candidate) => {
      const evidence = createSchemaMaximumOpenDesignM1InteractionEvidenceFixture(candidate)
      expect(() => validateOpenDesignM1InteractionEvidence(candidate, evidence)).not.toThrow()
      const referencedAttributes = new Map<string, Set<string>>()
      const visitAssertions = (assertions: readonly any[]): void => {
        for (const assertion of assertions) {
          if (assertion.kind === 'compare') {
            for (const metric of [assertion.left, ...('capture' in assertion.right ? [assertion.right] : [])]) {
              if (metric.field === 'attribute') {
                const names = referencedAttributes.get(metric.capture) ?? new Set<string>()
                names.add(metric.attribute)
                referencedAttributes.set(metric.capture, names)
              }
            }
          } else {
            const names = referencedAttributes.get(assertion.capture) ?? new Set<string>()
            names.add(assertion.attribute)
            referencedAttributes.set(assertion.capture, names)
          }
        }
      }
      visitAssertions(candidate.initialAssertions)
      for (const scenario of candidate.scenarios) visitAssertions(scenario.assertions)
      const snapshots = [evidence.initial.captures, ...evidence.ledger.flatMap((entry) => [
        entry.initialCaptures, entry.finalCaptures,
      ])]
      for (const definition of candidate.captures) {
        const captures = snapshots.map((snapshot) => snapshot[definition.id]!)
        if (definition.kind === 'collection') {
          expect(captures.some((capture) => capture.kind === 'collection' && capture.visibleCount === 128)).toBe(true)
          for (const attribute of referencedAttributes.get(definition.id) ?? []) {
            expect(captures.some((capture) => capture.kind === 'collection'
              && Object.keys(capture.attributeCounts[attribute] ?? {}).length === 64)).toBe(true)
          }
        } else if (definition.kind === 'element') {
          for (const attribute of referencedAttributes.get(definition.id) ?? []) {
            expect(captures.every((capture) => capture.kind === 'element'
              && Object.hasOwn(capture.attributes, attribute))).toBe(true)
          }
        } else if (definition.kind === 'secret-safety') {
          expect(captures.every((capture) => capture.kind === 'secret-safety'
            && capture.inspectedVisibleNodes === 128)).toBe(true)
        }
      }
      for (const action of evidence.ledger.flatMap((entry) => entry.actions)) {
        expect(action.elapsedMs).toBe(3_000)
        if (action.kind !== 'setViewport') {
          expect(action.observedEventTypes).toHaveLength(8)
          expect(action.rect).toEqual({
            x: Number.MAX_SAFE_INTEGER, y: Number.MAX_SAFE_INTEGER, width: 10_000, height: 10_000,
          })
        }
      }
      return { caseId: candidate.caseId, bytes: Buffer.byteLength(JSON.stringify(evidence), 'utf8') }
    })
    const worst = sizes.sort((left, right) => right.bytes - left.bytes)[0]!
    expect(worst).toEqual({ caseId: 'F04', bytes: 122_623 })
    expect(worst.bytes).toBeLessThan(192 * 1024)
    expect(OPEN_DESIGN_M1_INTERACTION_MAX_BYTES).toBe(256 * 1024)
  })
})
