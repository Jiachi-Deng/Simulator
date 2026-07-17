import { createHash } from 'node:crypto'
import type {
  InteractionAction,
  InteractionAssertion,
  InteractionCapture,
  InteractionMetric,
  OpenDesignM1InteractionVector,
} from './open-design-m1-interaction-vectors'
import {
  OPEN_DESIGN_M1_INTERACTION_RESET,
  openDesignM1InteractionVectorSha256,
  validateOpenDesignM1InteractionVector,
} from './open-design-m1-interaction-vectors'

const SHA256 = /^[0-9a-f]{64}$/
const SAFE_SEMANTIC_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SAFE_ATTRIBUTE = /^(?:aria-[a-z][a-z0-9-]{0,31}|data-m1-[a-z][a-z0-9-]{0,31})$/
// Printable ASCII state tokens that serialize into JSON without escaping.
const SAFE_ATTRIBUTE_VALUE_SOURCE = String.raw`^[\x20-\x21\x23-\x5b\x5d-\x7e]{0,64}$`
const SAFE_ATTRIBUTE_VALUE = new RegExp(SAFE_ATTRIBUTE_VALUE_SOURCE)
const SECRET_SHAPED_VALUE = /(?:sk-(?:live|prod)-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ACTION_TIMEOUT_MS = 3_000
const MAX_CAPTURE_ITEMS = 128
export const OPEN_DESIGN_M1_INTERACTION_MAX_BYTES = 256 * 1024

type JsonObject = Record<string, unknown>
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type SafeElementObservation = {
  readonly kind: 'element'
  readonly semanticId: string
  readonly present: boolean
  /** Rendered in the document, independent of the current viewport. */
  readonly visible: boolean
  readonly inViewport: boolean
  readonly enabled: boolean
  readonly checked: boolean | null
  readonly rect: SafeRect | null
  readonly textSha256: string
  readonly valueSha256: string
  readonly numericValue: number | null
  readonly attributes: Readonly<Record<string, string>>
}

export type SafeCollectionObservation = {
  readonly kind: 'collection'
  readonly semanticPrefix: string
  readonly visibleCount: number
  readonly idDigest: string
  readonly stateDigest: string
  readonly attributeCounts: Readonly<Record<string, Readonly<Record<string, number>>>>
}

export type SafeDocumentObservation = {
  readonly kind: 'document'
  readonly innerWidth: number
  readonly scrollWidth: number
  readonly noHorizontalOverflow: boolean
}

export type SafeSecretObservation = {
  readonly kind: 'secret-safety'
  readonly semanticPrefix: string
  readonly inspectedVisibleNodes: number
  readonly safe: boolean
}

export type SafeCaptureObservation =
  | SafeElementObservation
  | SafeCollectionObservation
  | SafeDocumentObservation
  | SafeSecretObservation

export type SafeCaptureSnapshot = Readonly<Record<string, SafeCaptureObservation>>

export interface SafeRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface InteractionActionEvidence {
  readonly ordinal: number
  readonly kind: InteractionAction['kind']
  readonly target: string | null
  readonly isTrusted: true
  readonly hitTestIdentity: string | null
  readonly rect: SafeRect | null
  readonly observedEventTypes: readonly string[]
  readonly elapsedMs: number
  readonly preCaptureDigest: string
  readonly postCaptureDigest: string
}

export interface InteractionAssertionEvidence {
  readonly id: string
  readonly passed: true
}

export interface OpenDesignM1InteractionEvidence {
  readonly schemaVersion: 2
  readonly vectorSha256: string
  readonly initial: {
    readonly captures: SafeCaptureSnapshot
    readonly assertions: readonly InteractionAssertionEvidence[]
  }
  readonly ledger: readonly {
    readonly scenarioId: string
    readonly reset: typeof OPEN_DESIGN_M1_INTERACTION_RESET
    readonly initialCaptures: SafeCaptureSnapshot
    readonly actions: readonly InteractionActionEvidence[]
    readonly finalCaptures: SafeCaptureSnapshot
    readonly assertions: readonly InteractionAssertionEvidence[]
  }[]
  readonly normalizedOutcomeDigest: string
}

export interface OpenDesignM1PreviewInteractionResult {
  readonly interaction: OpenDesignM1InteractionEvidence
  readonly screenshot?: Buffer
}

export interface InteractionCdpSession {
  connect(): Promise<void>
  send(method: string, params?: JsonObject): Promise<any>
  evaluate(expression: string, executionContextId?: number): Promise<unknown>
  onEvent(listener: (method: string, params: JsonObject) => void): () => void
  screenshot(): Promise<Buffer>
  close(): void
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as JsonObject).sort().map((key) => (
      `${JSON.stringify(key)}:${canonical((value as JsonObject)[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function captureChainDigest(snapshot: SafeCaptureSnapshot): string {
  const stable: JsonObject = {}
  for (const [id, capture] of Object.entries(snapshot)) {
    if (capture.kind === 'element') {
      const { rect: _rect, inViewport: _inViewport, ...functional } = capture
      stable[id] = functional
    } else {
      stable[id] = capture
    }
  }
  return sha256(canonical(stable))
}

function exactKeys(value: JsonObject, expected: readonly string[], path: string): void {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${path}`)
  }
}

function objectAt(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${path}`)
  }
  return value as JsonObject
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${path}`)
  }
  return value
}

function exactLoopbackPreviewUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || url.username || url.password || url.search || url.hash) {
    throw new Error('Preview interaction URL is invalid')
  }
  return url.href
}

class WebSocketInteractionCdpSession implements InteractionCdpSession {
  readonly #socket: WebSocket
  readonly #pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
  readonly #listeners = new Set<(method: string, params: JsonObject) => void>()
  #nextId = 1

  constructor(url: string) {
    this.#socket = new WebSocket(url)
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      this.#socket.addEventListener('open', () => resolvePromise(), { once: true })
      this.#socket.addEventListener('error', () => reject(new Error('Preview interaction CDP connection failed')), { once: true })
    })
    this.#socket.addEventListener('message', (event) => {
      let message: { id?: number; method?: string; params?: JsonObject; result?: unknown; error?: { message?: string } }
      try {
        message = JSON.parse(String(event.data))
      } catch {
        for (const pending of this.#pending.values()) pending.reject(new Error('Preview interaction CDP response is invalid'))
        this.#pending.clear()
        return
      }
      if (message.id) {
        const pending = this.#pending.get(message.id)
        if (!pending) return
        this.#pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message ?? 'Preview interaction CDP request failed'))
        else pending.resolve(message.result)
        return
      }
      if (message.method && message.params) {
        for (const listener of this.#listeners) listener(message.method, message.params)
      }
    })
    this.#socket.addEventListener('close', () => {
      for (const pending of this.#pending.values()) pending.reject(new Error('Preview interaction CDP closed'))
      this.#pending.clear()
    })
  }

  send(method: string, params: JsonObject = {}): Promise<any> {
    const id = this.#nextId++
    return new Promise((resolvePromise, reject) => {
      this.#pending.set(id, { resolve: resolvePromise, reject })
      this.#socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression: string, executionContextId?: number): Promise<unknown> {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
      ...(executionContextId === undefined ? {} : { contextId: executionContextId }),
    })
    if (response?.exceptionDetails) throw new Error('Preview interaction observation failed')
    return response?.result?.value
  }

  onEvent(listener: (method: string, params: JsonObject) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async screenshot(): Promise<Buffer> {
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    if (typeof result?.data !== 'string') throw new Error('Preview interaction screenshot is unavailable')
    return Buffer.from(result.data, 'base64')
  }

  close(): void {
    this.#socket.close()
  }
}

const OBSERVER_INSTALL = `(()=>{
  if(globalThis.__simulatorM1TrustedObserver)return true;
  const state={next:0,events:[]};
  const record=(event)=>{
    const semantic=event.target instanceof Element?event.target.closest('[data-m1-id]')?.getAttribute('data-m1-id')??null:null;
    state.events.push({sequence:++state.next,type:String(event.type).slice(0,32),isTrusted:event.isTrusted===true,target:semantic});
    if(state.events.length>64)state.events.splice(0,state.events.length-64);
  };
  for(const type of ['pointerdown','click','keydown','input','change'])document.addEventListener(type,record,true);
  Object.defineProperty(globalThis,'__simulatorM1TrustedObserver',{value:state,configurable:false,writable:false});
  return true;
})()`

function targetObservationExpression(semanticId: string, allowedAttributes: readonly string[] = []): string {
  if (!SAFE_SEMANTIC_ID.test(semanticId)) throw new TypeError('Preview interaction semantic target is invalid')
  if (allowedAttributes.some((name) => !SAFE_ATTRIBUTE.test(name) || name === 'data-m1-id')) {
    throw new TypeError('Preview interaction element attribute authority is invalid')
  }
  return `(()=>{
    const id=${JSON.stringify(semanticId)};
    const allowed=new Set(${JSON.stringify([...allowedAttributes].sort())});const safeValue=new RegExp(${JSON.stringify(SAFE_ATTRIBUTE_VALUE_SOURCE)});
    const node=[...document.querySelectorAll('[data-m1-id]')].find((candidate)=>candidate.getAttribute('data-m1-id')===id);
    if(!(node instanceof Element))return {present:false,semanticId:id};
    const rect=node.getBoundingClientRect();const style=getComputedStyle(node);
    const visible=!node.hidden&&style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)!==0&&rect.width>0&&rect.height>0;
    const inViewport=visible&&rect.bottom>0&&rect.right>0&&rect.top<innerHeight&&rect.left<innerWidth;
    const disabled=('disabled'in node&&node.disabled===true)||node.getAttribute('aria-disabled')==='true';
    const centerX=rect.left+rect.width/2,centerY=rect.top+rect.height/2;
    const hit=inViewport?document.elementFromPoint(centerX,centerY):null;const hitIdentity=hit instanceof Element?hit.closest('[data-m1-id]')?.getAttribute('data-m1-id')??null:null;
    const attrs={};for(const attr of [...node.attributes])if(allowed.has(attr.name)){const value=String(attr.value);if(!safeValue.test(value))return {present:true,semanticId:id,invalidAttribute:true};attrs[attr.name]=value;}
    const text=String(node.innerText??node.textContent??'').replace(/\\s+/g,' ').trim().slice(0,512);
    const value=typeof node.value==='string'?node.value.slice(0,512):'';
    const numericValue=Number.isFinite(Number(node.value))&&String(node.value).trim()!==''?Number(node.value):null;
    return {present:true,semanticId:id,tag:node.tagName.toLowerCase(),role:node.getAttribute('role')??'',visible,inViewport,enabled:visible&&!disabled,checked:typeof node.checked==='boolean'?node.checked:null,rect:{x:rect.left,y:rect.top,width:rect.width,height:rect.height},hitIdentity,attrs,text,value,numericValue};
  })()`
}

function collectionObservationExpression(semanticPrefix: string, allowedAttributes: readonly string[]): string {
  if (!SAFE_SEMANTIC_ID.test(semanticPrefix.slice(0, -1)) || !semanticPrefix.endsWith('.')) {
    throw new TypeError('Preview interaction semantic collection is invalid')
  }
  if (allowedAttributes.some((name) => !SAFE_ATTRIBUTE.test(name) || name === 'data-m1-id')) {
    throw new TypeError('Preview interaction collection attribute authority is invalid')
  }
  return `(()=>{
    const prefix=${JSON.stringify(semanticPrefix)};const allowed=new Set(${JSON.stringify([...allowedAttributes].sort())});const safeValue=new RegExp(${JSON.stringify(SAFE_ATTRIBUTE_VALUE_SOURCE)});const items=[];
    for(const node of document.querySelectorAll('[data-m1-id]')){
      const id=node.getAttribute('data-m1-id')??'';if(!id.startsWith(prefix))continue;
      const rect=node.getBoundingClientRect(),style=getComputedStyle(node);
      const visible=!node.hidden&&style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)!==0&&rect.width>0&&rect.height>0;
      if(!visible)continue;const attrs={};for(const attr of [...node.attributes])if(allowed.has(attr.name)){const value=String(attr.value);if(!safeValue.test(value))return {overflow:true,items:[]};attrs[attr.name]=value;}
      items.push({id,attrs,text:String(node.innerText??node.textContent??'').replace(/\\s+/g,' ').trim().slice(0,512),value:typeof node.value==='string'?node.value.slice(0,512):''});
      if(items.length>${MAX_CAPTURE_ITEMS})return {overflow:true,items:[]};
    }
    items.sort((left,right)=>left.id.localeCompare(right.id));return {overflow:false,items};
  })()`
}

const DOCUMENT_OBSERVATION = `(()=>({innerWidth:window.innerWidth,scrollWidth:Math.max(document.documentElement.scrollWidth,document.body?.scrollWidth??0),noHorizontalOverflow:Math.max(document.documentElement.scrollWidth,document.body?.scrollWidth??0)<=window.innerWidth+1}))()`

function secretSafetyExpression(semanticPrefix: string): string {
  if (!SAFE_SEMANTIC_ID.test(semanticPrefix.slice(0, -1)) || !semanticPrefix.endsWith('.')) {
    throw new TypeError('Preview interaction secret prefix is invalid')
  }
  return `(()=>{
    const prefix=${JSON.stringify(semanticPrefix)};let inspected=0;let safe=true;
    const secret=/(?:sk-(?:live|prod)-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
    for(const node of document.querySelectorAll('[data-m1-id]')){
      const id=node.getAttribute('data-m1-id')??'';if(!id.startsWith(prefix))continue;
      const rect=node.getBoundingClientRect(),style=getComputedStyle(node);if(node.hidden||style.display==='none'||style.visibility==='hidden'||rect.width<=0||rect.height<=0)continue;
      inspected++;if(secret.test(String(node.textContent??'')))safe=false;if(inspected>${MAX_CAPTURE_ITEMS})return {overflow:true,inspected,safe:false};
    }return {overflow:false,inspected,safe};
  })()`
}

const OBSERVER_READ = `(()=>{const state=globalThis.__simulatorM1TrustedObserver;if(!state)return null;return {next:state.next,events:state.events.slice(-64)}})()`

function safeRect(value: unknown, path: string): SafeRect {
  const object = objectAt(value, path)
  exactKeys(object, ['height', 'width', 'x', 'y'], path)
  const result = {
    x: finite(object.x, `${path}.x`),
    y: finite(object.y, `${path}.y`),
    width: finite(object.width, `${path}.width`),
    height: finite(object.height, `${path}.height`),
  }
  if (result.width < 0 || result.height < 0 || result.width > 10_000 || result.height > 10_000) {
    throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${path}`)
  }
  return result
}

function safeAttributes(value: unknown, path: string): Readonly<Record<string, string>> {
  const object = objectAt(value, path)
  const result: Record<string, string> = {}
  const keys = Object.keys(object).sort()
  if (keys.length > 32) throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${path}`)
  for (const key of keys) {
    if (!SAFE_ATTRIBUTE.test(key) || typeof object[key] !== 'string' || !SAFE_ATTRIBUTE_VALUE.test(object[key] as string)) {
      throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${path}.${key}`)
    }
    const attributeValue = object[key] as string
    if (SECRET_SHAPED_VALUE.test(attributeValue)
      || (key.includes('secret') && !(
        (key === 'data-m1-secret-present' && ['true', 'false'].includes(attributeValue))
        || (key === 'data-m1-secret-digest' && SHA256.test(attributeValue))
      ))) {
      throw new TypeError(`OpenDesign M1 interaction evidence contains unsafe secret-shaped state: ${path}.${key}`)
    }
    result[key] = attributeValue
  }
  return result
}

type CaptureRequirements = Readonly<{
  attributes: Readonly<Record<string, readonly string[]>>
  fields: Readonly<Record<string, readonly InteractionMetric['field'][]>>
}>

function captureRequirements(vector: OpenDesignM1InteractionVector): CaptureRequirements {
  const attributes = new Map<string, Set<string>>()
  const fields = new Map<string, Set<InteractionMetric['field']>>()
  for (const capture of vector.captures) {
    attributes.set(capture.id, new Set())
    fields.set(capture.id, new Set())
  }
  const visitAssertion = (assertion: InteractionAssertion): void => {
    if (assertion.kind === 'compare') {
      for (const metric of [assertion.left, ...('capture' in assertion.right ? [assertion.right] : [])]) {
        fields.get(metric.capture)?.add(metric.field)
        if (metric.field === 'attribute' && metric.attribute) attributes.get(metric.capture)?.add(metric.attribute)
      }
      return
    }
    fields.get(assertion.capture)?.add('visibleCount')
    attributes.get(assertion.capture)?.add(assertion.attribute)
  }
  for (const assertion of vector.initialAssertions) visitAssertion(assertion)
  for (const scenario of vector.scenarios) for (const assertion of scenario.assertions) visitAssertion(assertion)
  return {
    attributes: Object.fromEntries([...attributes].map(([id, names]) => [id, [...names].sort()])),
    fields: Object.fromEntries([...fields].map(([id, names]) => [id, [...names].sort()])),
  }
}

async function captureElement(
  session: InteractionCdpSession,
  capture: Extract<InteractionCapture, { kind: 'element' }>,
  allowedAttributes: readonly string[],
  contextId: number,
): Promise<SafeElementObservation> {
  const raw = objectAt(await session.evaluate(
    targetObservationExpression(capture.semanticId, allowedAttributes), contextId,
  ), capture.id)
  if (raw.present === false) {
    return {
      kind: 'element', semanticId: capture.semanticId, present: false, visible: false, inViewport: false, enabled: false,
      checked: null, rect: null, textSha256: sha256(''), valueSha256: sha256(''), numericValue: null, attributes: {},
    }
  }
  if (raw.present !== true || typeof raw.visible !== 'boolean' || typeof raw.inViewport !== 'boolean'
    || typeof raw.enabled !== 'boolean'
    || (raw.checked !== null && typeof raw.checked !== 'boolean') || typeof raw.text !== 'string'
    || typeof raw.value !== 'string' || raw.text.length > 512 || raw.value.length > 512
    || (raw.numericValue !== null && (typeof raw.numericValue !== 'number' || !Number.isFinite(raw.numericValue)))) {
    throw new Error(`Preview interaction element observation is invalid: ${capture.id}`)
  }
  return {
    kind: 'element', semanticId: capture.semanticId, present: true, visible: raw.visible,
    inViewport: raw.inViewport,
    enabled: raw.enabled, checked: raw.checked as boolean | null, rect: safeRect(raw.rect, `${capture.id}.rect`),
    textSha256: sha256(raw.text), valueSha256: sha256(raw.value), numericValue: raw.numericValue as number | null,
    attributes: safeAttributes(raw.attrs, `${capture.id}.attributes`),
  }
}

async function captureCollection(
  session: InteractionCdpSession,
  capture: Extract<InteractionCapture, { kind: 'collection' }>,
  allowedAttributes: readonly string[],
  contextId: number,
): Promise<SafeCollectionObservation> {
  const raw = objectAt(await session.evaluate(
    collectionObservationExpression(capture.semanticPrefix, allowedAttributes), contextId,
  ), capture.id)
  if (raw.overflow !== false || !Array.isArray(raw.items) || raw.items.length > MAX_CAPTURE_ITEMS) {
    throw new Error(`Preview interaction collection observation is invalid: ${capture.id}`)
  }
  const items = raw.items.map((item, index) => {
    const object = objectAt(item, `${capture.id}[${index}]`)
    if (typeof object.id !== 'string' || !object.id.startsWith(capture.semanticPrefix)
      || !SAFE_SEMANTIC_ID.test(object.id) || typeof object.text !== 'string' || object.text.length > 512
      || typeof object.value !== 'string' || object.value.length > 512) {
      throw new Error(`Preview interaction collection member is invalid: ${capture.id}`)
    }
    return {
      id: object.id,
      attributes: safeAttributes(object.attrs, `${capture.id}[${index}].attributes`),
      textSha256: sha256(object.text),
      valueSha256: sha256(object.value),
    }
  })
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error(`Preview interaction collection contains duplicate semantic ids: ${capture.id}`)
  const attributeCounts: Record<string, Record<string, number>> = {}
  for (const item of items) {
    for (const [name, value] of Object.entries(item.attributes)) {
      const counts = attributeCounts[name] ??= {}
      counts[value] = (counts[value] ?? 0) + 1
    }
  }
  return {
    kind: 'collection', semanticPrefix: capture.semanticPrefix, visibleCount: items.length,
    idDigest: sha256(items.map((item) => item.id).join('\n')),
    stateDigest: sha256(canonical(items)),
    attributeCounts,
  }
}

async function captureDocument(session: InteractionCdpSession, contextId: number): Promise<SafeDocumentObservation> {
  const raw = objectAt(await session.evaluate(DOCUMENT_OBSERVATION, contextId), 'document')
  const innerWidth = finite(raw.innerWidth, 'document.innerWidth')
  const scrollWidth = finite(raw.scrollWidth, 'document.scrollWidth')
  if (typeof raw.noHorizontalOverflow !== 'boolean' || innerWidth < 1 || scrollWidth < 1) {
    throw new Error('Preview interaction document observation is invalid')
  }
  return { kind: 'document', innerWidth, scrollWidth, noHorizontalOverflow: raw.noHorizontalOverflow }
}

async function captureSecret(
  session: InteractionCdpSession,
  capture: Extract<InteractionCapture, { kind: 'secret-safety' }>,
  contextId: number,
): Promise<SafeSecretObservation> {
  const raw = objectAt(await session.evaluate(secretSafetyExpression(capture.semanticPrefix), contextId), capture.id)
  if (raw.overflow !== false || !Number.isSafeInteger(raw.inspected) || typeof raw.safe !== 'boolean'
    || (raw.inspected as number) < 1 || (raw.inspected as number) > MAX_CAPTURE_ITEMS) {
    throw new Error(`Preview interaction secret-safety observation is invalid: ${capture.id}`)
  }
  return { kind: 'secret-safety', semanticPrefix: capture.semanticPrefix, inspectedVisibleNodes: raw.inspected as number, safe: raw.safe }
}

async function captureAll(
  session: InteractionCdpSession,
  captures: readonly InteractionCapture[],
  requirements: CaptureRequirements,
  contextId: number,
): Promise<SafeCaptureSnapshot> {
  const result: Record<string, SafeCaptureObservation> = {}
  for (const capture of captures) {
    if (capture.kind === 'element') result[capture.id] = await captureElement(session, capture, requirements.attributes[capture.id] ?? [], contextId)
    else if (capture.kind === 'collection') result[capture.id] = await captureCollection(session, capture, requirements.attributes[capture.id] ?? [], contextId)
    else if (capture.kind === 'document') result[capture.id] = await captureDocument(session, contextId)
    else result[capture.id] = await captureSecret(session, capture, contextId)
  }
  return result
}

function metricValue(snapshotInitial: SafeCaptureSnapshot, snapshotFinal: SafeCaptureSnapshot, metric: InteractionMetric): unknown {
  const snapshot = metric.stage === 'initial' ? snapshotInitial : snapshotFinal
  const capture = snapshot[metric.capture]
  if (!capture) return undefined
  if (metric.field === 'attribute') {
    return capture.kind === 'element' && metric.attribute ? capture.attributes[metric.attribute] : undefined
  }
  if (metric.field === 'visible') return capture.kind === 'element' ? capture.visible : undefined
  if (metric.field === 'inViewport') return capture.kind === 'element' ? capture.inViewport : undefined
  if (metric.field === 'enabled') return capture.kind === 'element' ? capture.enabled : undefined
  if (metric.field === 'checked') return capture.kind === 'element' ? capture.checked : undefined
  if (metric.field === 'textSha256') return capture.kind === 'element' ? capture.textSha256 : undefined
  if (metric.field === 'valueSha256') return capture.kind === 'element' ? capture.valueSha256 : undefined
  if (metric.field === 'numericValue') return capture.kind === 'element' ? capture.numericValue : undefined
  if (metric.field === 'rectLeft') return capture.kind === 'element' ? capture.rect?.x : undefined
  if (metric.field === 'rectRight') return capture.kind === 'element' && capture.rect
    ? capture.rect.x + capture.rect.width
    : undefined
  if (metric.field === 'visibleCount') return capture.kind === 'collection' ? capture.visibleCount : undefined
  if (metric.field === 'idDigest') return capture.kind === 'collection' ? capture.idDigest : undefined
  if (metric.field === 'stateDigest') return capture.kind === 'collection' ? capture.stateDigest : undefined
  if (metric.field === 'innerWidth') return capture.kind === 'document' ? capture.innerWidth : undefined
  if (metric.field === 'scrollWidth') return capture.kind === 'document' ? capture.scrollWidth : undefined
  if (metric.field === 'noHorizontalOverflow') return capture.kind === 'document' ? capture.noHorizontalOverflow : undefined
  return capture.kind === 'secret-safety' ? capture.safe : undefined
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return Number(value)
  return undefined
}

function assertionPasses(
  assertion: InteractionAssertion,
  initial: SafeCaptureSnapshot,
  final: SafeCaptureSnapshot,
): boolean {
  if (assertion.kind === 'compare') {
    const left = metricValue(initial, final, assertion.left)
    const right = 'capture' in assertion.right
      ? metricValue(initial, final, assertion.right)
      : assertion.right.literal
    if (left === undefined || left === null || right === undefined || right === null) return false
    const leftNumber = numeric(left)
    const rightNumber = numeric(right)
    if (assertion.comparison === 'equals') return left === right || (leftNumber !== undefined && rightNumber !== undefined && leftNumber === rightNumber)
    if (assertion.comparison === 'notEquals') return !(left === right || (leftNumber !== undefined && rightNumber !== undefined && leftNumber === rightNumber))
    if (leftNumber === undefined || rightNumber === undefined) return false
    if (assertion.comparison === 'greaterThan') return leftNumber > rightNumber
    if (assertion.comparison === 'lessThan') return leftNumber < rightNumber
    if (assertion.comparison === 'atLeast') return leftNumber >= rightNumber
    return leftNumber <= rightNumber
  }
  const snapshot = assertion.stage === 'initial' ? initial : final
  const capture = snapshot[assertion.capture]
  if (!capture || capture.kind !== 'collection' || capture.visibleCount < 1) return false
  const counts = capture.attributeCounts[assertion.attribute] ?? {}
  if (assertion.kind === 'collectionAllAttributeEquals') return counts[assertion.value] === capture.visibleCount
  if (assertion.kind === 'collectionDistinctAttributeAtLeast') return Object.keys(counts).length >= assertion.count
  return (counts[assertion.value] ?? 0) >= assertion.count
}

function evaluateAssertions(
  assertions: readonly InteractionAssertion[],
  initial: SafeCaptureSnapshot,
  final: SafeCaptureSnapshot,
): readonly InteractionAssertionEvidence[] {
  return assertions.map((assertion) => {
    if (!assertionPasses(assertion, initial, final)) {
      throw new Error(`Preview interaction assertion failed: ${assertion.id}`)
    }
    return { id: assertion.id, passed: true as const }
  })
}

class EquivalenceTokens {
  readonly #values = new Map<string, Map<string, string>>()

  token(category: string, value: string): string {
    let values = this.#values.get(category)
    if (!values) {
      values = new Map()
      this.#values.set(category, values)
    }
    const existing = values.get(value)
    if (existing) return existing
    const token = `${category}-${values.size + 1}`
    values.set(value, token)
    return token
  }
}

function normalizeAttributeValue(name: string, value: string, tokens: EquivalenceTokens): string {
  if (name === 'data-m1-entity-id' || name === 'data-m1-selected-id') {
    return tokens.token('entity', value)
  }
  if (name === 'data-m1-signature') return tokens.token('signature', value)
  if (name === 'data-m1-secret-digest') return tokens.token('secret-digest', value)
  return value
}

function normalizedMetricValue(metric: InteractionMetric, value: unknown, tokens: EquivalenceTokens): unknown {
  if (metric.field === 'rectLeft' || metric.field === 'rectRight') return 'finite-layout-coordinate'
  if (metric.field === 'stateDigest' && typeof value === 'string') return tokens.token('state-digest', value)
  if (metric.field === 'idDigest' && typeof value === 'string') return tokens.token('id-digest', value)
  if (metric.field === 'attribute' && metric.attribute && typeof value === 'string') {
    return normalizeAttributeValue(metric.attribute, value, tokens)
  }
  return value
}

function metricDescriptor(metric: InteractionMetric): JsonObject {
  return {
    stage: metric.stage,
    capture: metric.capture,
    field: metric.field,
    ...(metric.attribute ? { attribute: metric.attribute } : {}),
  }
}

function normalizedAssertionOutcome(
  assertion: InteractionAssertion,
  initial: SafeCaptureSnapshot,
  final: SafeCaptureSnapshot,
  tokens: EquivalenceTokens,
): JsonObject {
  if (!assertionPasses(assertion, initial, final)) {
    throw new Error(`Cannot normalize failed Preview interaction assertion: ${assertion.id}`)
  }
  if (assertion.kind === 'compare') {
    const leftValue = metricValue(initial, final, assertion.left)
    const rightValue = 'capture' in assertion.right
      ? metricValue(initial, final, assertion.right)
      : assertion.right.literal
    return {
      id: assertion.id,
      kind: assertion.kind,
      comparison: assertion.comparison,
      passed: true,
      left: {
        metric: metricDescriptor(assertion.left),
        value: normalizedMetricValue(assertion.left, leftValue, tokens),
      },
      right: 'capture' in assertion.right
        ? {
            metric: metricDescriptor(assertion.right),
            value: normalizedMetricValue(assertion.right, rightValue, tokens),
          }
        : {
            literal: normalizedMetricValue(assertion.left, rightValue, tokens),
          },
    }
  }
  const snapshot = assertion.stage === 'initial' ? initial : final
  const capture = snapshot[assertion.capture]
  if (!capture || capture.kind !== 'collection') throw new Error(`Cannot normalize missing collection: ${assertion.id}`)
  const normalizedCounts = Object.fromEntries(Object.entries(capture.attributeCounts[assertion.attribute] ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([value, count]) => [normalizeAttributeValue(assertion.attribute, value, tokens), count]))
  return {
    id: assertion.id,
    kind: assertion.kind,
    passed: true,
    stage: assertion.stage,
    capture: assertion.capture,
    attribute: assertion.attribute,
    visibleCount: capture.visibleCount,
    attributeCounts: normalizedCounts,
    ...(assertion.kind === 'collectionAllAttributeEquals'
      ? { expectedValue: normalizeAttributeValue(assertion.attribute, assertion.value, tokens) }
      : { requiredCount: assertion.count }),
    ...(assertion.kind === 'collectionAttributeCountAtLeast'
      ? { expectedValue: normalizeAttributeValue(assertion.attribute, assertion.value, tokens) }
      : {}),
  }
}

function normalizedCaptureSnapshot(
  vector: OpenDesignM1InteractionVector,
  snapshot: SafeCaptureSnapshot,
  requirements: CaptureRequirements,
  tokens: EquivalenceTokens,
): JsonObject {
  const result: JsonObject = {}
  for (const definition of vector.captures) {
    const capture = snapshot[definition.id]
    if (!capture) throw new Error(`Cannot normalize missing Preview capture: ${definition.id}`)
    const fields = new Set(requirements.fields[definition.id] ?? [])
    if (capture.kind === 'element') {
      const attributes = Object.fromEntries(Object.entries(capture.attributes)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => [name, normalizeAttributeValue(name, value, tokens)]))
      result[definition.id] = {
        kind: capture.kind,
        present: capture.present,
        visible: capture.visible,
        enabled: capture.enabled,
        checked: capture.checked,
        numericValue: capture.numericValue,
        ...(fields.has('inViewport') ? { inViewport: capture.inViewport } : {}),
        ...(fields.has('textSha256') ? { textSha256: capture.textSha256 } : {}),
        ...(fields.has('valueSha256') ? { valueSha256: capture.valueSha256 } : {}),
        attributes,
      }
    } else if (capture.kind === 'collection') {
      const attributeCounts = Object.fromEntries(Object.entries(capture.attributeCounts)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, counts]) => [name, Object.fromEntries(Object.entries(counts)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([value, count]) => [normalizeAttributeValue(name, value, tokens), count]))]))
      result[definition.id] = {
        kind: capture.kind,
        visibleCount: capture.visibleCount,
        attributeCounts,
        ...(fields.has('idDigest') ? { idDigest: tokens.token('id-digest', capture.idDigest) } : {}),
        ...(fields.has('stateDigest') ? { stateDigest: tokens.token('state-digest', capture.stateDigest) } : {}),
      }
    } else if (capture.kind === 'document') {
      result[definition.id] = {
        kind: capture.kind,
        innerWidth: capture.innerWidth,
        scrollWidth: capture.scrollWidth,
        noHorizontalOverflow: capture.noHorizontalOverflow,
      }
    } else {
      result[definition.id] = {
        kind: capture.kind,
        inspectedVisibleNodes: capture.inspectedVisibleNodes,
        safe: capture.safe,
      }
    }
  }
  return result
}

function normalizedOutcome(
  vector: OpenDesignM1InteractionVector,
  initial: OpenDesignM1InteractionEvidence['initial'],
  ledger: OpenDesignM1InteractionEvidence['ledger'],
): JsonObject {
  const requirements = captureRequirements(vector)
  const tokens = new EquivalenceTokens()
  return {
    schemaVersion: 2,
    caseId: vector.caseId,
    vectorSha256: openDesignM1InteractionVectorSha256(vector),
    initialCaptures: normalizedCaptureSnapshot(vector, initial.captures, requirements, tokens),
    initialAssertions: vector.initialAssertions.map((assertion) => (
      normalizedAssertionOutcome(assertion, initial.captures, initial.captures, tokens)
    )),
    scenarios: vector.scenarios.map((value, index) => ({
      id: value.id,
      reset: value.reset,
      initialCaptures: normalizedCaptureSnapshot(vector, ledger[index]!.initialCaptures, requirements, tokens),
      actions: value.actions.map((action) => ({
        kind: action.kind,
        ...('target' in action ? { target: action.target } : { width: action.width, height: action.height }),
      })),
      trustedActions: ledger[index]!.actions.map((action) => ({
        kind: action.kind,
        target: action.target,
        isTrusted: action.isTrusted,
        hitTestIdentity: action.hitTestIdentity,
        requiredEventObserved: action.kind === 'setViewport'
          ? action.observedEventTypes.includes('cdp-emulation')
          : action.kind === 'pointerClick'
            ? action.observedEventTypes.includes('click')
            : action.kind === 'pressKeys'
              ? action.observedEventTypes.includes('keydown')
              : action.observedEventTypes.includes('input'),
      })),
      finalCaptures: normalizedCaptureSnapshot(vector, ledger[index]!.finalCaptures, requirements, tokens),
      assertions: value.assertions.map((assertion) => normalizedAssertionOutcome(
        assertion,
        ledger[index]!.initialCaptures,
        ledger[index]!.finalCaptures,
        tokens,
      )),
    })),
  }
}

export function openDesignM1NormalizedOutcomeDigest(
  vector: OpenDesignM1InteractionVector,
  initial: OpenDesignM1InteractionEvidence['initial'],
  ledger: OpenDesignM1InteractionEvidence['ledger'],
): string {
  return sha256(canonical(normalizedOutcome(vector, initial, ledger)))
}

async function waitFor<T>(label: string, probe: () => Promise<T | false>, timeoutMs = ACTION_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value !== false) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
  throw new Error(`${label} was not observed${lastError instanceof Error ? ` (${lastError.name})` : ''}`)
}

async function createTrustedObserverContext(session: InteractionCdpSession): Promise<number> {
  const frameTree = objectAt(await session.send('Page.getFrameTree'), 'Preview frame tree')
  const rootFrame = objectAt(frameTree.frameTree, 'Preview root frame')
  const frame = objectAt(rootFrame.frame, 'Preview root frame descriptor')
  if (typeof frame.id !== 'string' || !SAFE_SEMANTIC_ID.test(frame.id)) {
    throw new Error('Preview trusted-event frame is invalid')
  }
  const isolated = objectAt(await session.send('Page.createIsolatedWorld', {
    frameId: frame.id,
    worldName: 'simulator-m1-trusted-observer-v2',
    grantUniveralAccess: false,
  }), 'Preview isolated world')
  if (!Number.isSafeInteger(isolated.executionContextId) || (isolated.executionContextId as number) < 1) {
    throw new Error('Preview trusted-event isolated world is unavailable')
  }
  const contextId = isolated.executionContextId as number
  if (await session.evaluate(OBSERVER_INSTALL, contextId) !== true) {
    throw new Error('Preview trusted-event observer is unavailable')
  }
  return contextId
}

async function requireReady(session: InteractionCdpSession, previewUrl: string): Promise<number> {
  await waitFor('Preview interaction page readiness', async () => {
    const value = await session.evaluate(`(()=>({href:location.href,readyState:document.readyState}))()`)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    return (value as JsonObject).href === previewUrl && (value as JsonObject).readyState === 'complete' ? true : false
  }, 30_000)
  return createTrustedObserverContext(session)
}

type RawTarget = {
  present: true
  semanticId: string
  tag: string
  role: string
  visible: boolean
  inViewport: boolean
  enabled: boolean
  rect: SafeRect
  hitIdentity: string | null
}

async function rawTarget(
  session: InteractionCdpSession,
  semanticId: string,
  contextId: number,
): Promise<{ value: JsonObject; rect: SafeRect }> {
  const value = objectAt(await session.evaluate(targetObservationExpression(semanticId), contextId), semanticId)
  if (value.present !== true || value.semanticId !== semanticId || typeof value.tag !== 'string'
    || typeof value.role !== 'string' || typeof value.visible !== 'boolean'
    || typeof value.inViewport !== 'boolean' || typeof value.enabled !== 'boolean') {
    throw new Error(`Preview interaction target is invalid: ${semanticId}`)
  }
  return { value, rect: safeRect(value.rect, `${semanticId}.rect`) }
}

function requireNativeTarget(value: JsonObject, rect: SafeRect, semanticId: string): void {
  const native = ['button', 'input', 'select', 'textarea', 'a'].includes(value.tag as string)
  const role = ['button', 'tab', 'checkbox', 'radio', 'switch', 'option', 'row'].includes(value.role as string)
  if ((!native && !role) || rect.width < 24 || rect.height < 24) {
    throw new Error(`Preview action target is not a >=24x24 native/ARIA control: ${semanticId}`)
  }
}

async function requireRenderedTarget(session: InteractionCdpSession, semanticId: string, contextId: number): Promise<void> {
  const { value, rect } = await rawTarget(session, semanticId, contextId)
  if (value.visible !== true || value.enabled !== true) {
    throw new Error(`Initial semantic action target is unavailable: ${semanticId}`)
  }
  requireNativeTarget(value, rect, semanticId)
}

async function scrollExactTargetIntoView(session: InteractionCdpSession, semanticId: string): Promise<void> {
  if (!SAFE_SEMANTIC_ID.test(semanticId)) throw new Error('Preview scroll target is invalid')
  const documentResult = objectAt(await session.send('DOM.getDocument', { depth: 1, pierce: true }), 'Preview DOM document')
  const root = objectAt(documentResult.root, 'Preview DOM root')
  if (!Number.isSafeInteger(root.nodeId) || (root.nodeId as number) < 1) throw new Error('Preview DOM root is invalid')
  const query = objectAt(await session.send('DOM.querySelectorAll', {
    nodeId: root.nodeId,
    selector: `[data-m1-id="${semanticId}"]`,
  }), 'Preview DOM query')
  if (!Array.isArray(query.nodeIds) || query.nodeIds.length !== 1
    || !Number.isSafeInteger(query.nodeIds[0]) || (query.nodeIds[0] as number) < 1) {
    throw new Error(`Preview action target is missing or ambiguous: ${semanticId}`)
  }
  await session.send('DOM.scrollIntoViewIfNeeded', { nodeId: query.nodeIds[0] })
}

async function requireActionTarget(session: InteractionCdpSession, semanticId: string, contextId: number): Promise<RawTarget> {
  await scrollExactTargetIntoView(session, semanticId)
  const { value, rect } = await rawTarget(session, semanticId, contextId)
  if (value.present !== true || value.semanticId !== semanticId || typeof value.tag !== 'string'
    || typeof value.role !== 'string' || value.visible !== true || value.enabled !== true
    || value.inViewport !== true || (value.hitIdentity !== semanticId)) {
    throw new Error(`Preview action target is not visible/enabled/hit-testable: ${semanticId}`)
  }
  requireNativeTarget(value, rect, semanticId)
  return {
    present: true, semanticId, tag: value.tag as string, role: value.role as string,
    visible: true, inViewport: true, enabled: true, rect, hitIdentity: semanticId,
  }
}

async function observerState(session: InteractionCdpSession, contextId: number): Promise<{ next: number; events: Array<{ sequence: number; type: string; isTrusted: boolean; target: string | null }> }> {
  const value = objectAt(await session.evaluate(OBSERVER_READ, contextId), 'trustedObserver')
  if (!Number.isSafeInteger(value.next) || !Array.isArray(value.events) || value.events.length > 64) {
    throw new Error('Preview trusted-event observation is invalid')
  }
  const events = value.events.map((entry, index) => {
    const object = objectAt(entry, `trustedObserver.events[${index}]`)
    if (!Number.isSafeInteger(object.sequence) || typeof object.type !== 'string'
      || typeof object.isTrusted !== 'boolean' || (object.target !== null && typeof object.target !== 'string')) {
      throw new Error('Preview trusted-event observation is invalid')
    }
    return object as { sequence: number; type: string; isTrusted: boolean; target: string | null }
  })
  return { next: value.next as number, events }
}

const KEY_CODES: Readonly<Record<string, { key: string; code: string; windowsVirtualKeyCode: number }>> = Object.freeze({
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 },
})

async function clickTarget(session: InteractionCdpSession, target: RawTarget): Promise<void> {
  const x = target.rect.x + target.rect.width / 2
  const y = target.rect.y + target.rect.height / 2
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

async function dispatchKey(session: InteractionCdpSession, key: keyof typeof KEY_CODES): Promise<void> {
  const descriptor = KEY_CODES[key]
  if (!descriptor) throw new Error(`Preview interaction key is unsupported: ${key}`)
  await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...descriptor })
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...descriptor })
}

async function executeAction(
  session: InteractionCdpSession,
  action: InteractionAction,
  captures: readonly InteractionCapture[],
  requirements: CaptureRequirements,
  contextId: number,
  ordinal: number,
): Promise<InteractionActionEvidence> {
  const startedAt = Date.now()
  if (action.kind === 'setViewport') {
    const beforeSnapshot = await captureAll(session, captures, requirements, contextId)
    const preCaptureDigest = captureChainDigest(beforeSnapshot)
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: action.width, height: action.height, deviceScaleFactor: 1, mobile: false,
    })
    const finalSnapshot = await captureAll(session, captures, requirements, contextId)
    const elapsedMs = Date.now() - startedAt
    if (elapsedMs > ACTION_TIMEOUT_MS) throw new Error('Preview viewport action exceeded 3 seconds')
    return {
      ordinal, kind: action.kind, target: null, isTrusted: true, hitTestIdentity: null, rect: null,
      observedEventTypes: ['cdp-emulation'], elapsedMs, preCaptureDigest,
      postCaptureDigest: captureChainDigest(finalSnapshot),
    }
  }
  const target = await requireActionTarget(session, action.target, contextId)
  const beforeSnapshot = await captureAll(session, captures, requirements, contextId)
  const preCaptureDigest = captureChainDigest(beforeSnapshot)
  const beforeEvents = await observerState(session, contextId)
  if (action.kind === 'pointerClick') {
    await clickTarget(session, target)
  } else if (action.kind === 'pressKeys') {
    await clickTarget(session, target)
    for (const key of action.keys) await dispatchKey(session, key)
  } else {
    await clickTarget(session, target)
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Meta', code: 'MetaLeft', modifiers: 4, windowsVirtualKeyCode: 91 })
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65 })
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65 })
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91 })
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    await session.send('Input.insertText', { text: action.text })
  }
  const requiredType = action.kind === 'pointerClick' ? 'click' : action.kind === 'pressKeys' ? 'keydown' : 'input'
  const observed = await waitFor('trusted Preview action event', async () => {
    const state = await observerState(session, contextId)
    const events = state.events.filter((event) => event.sequence > beforeEvents.next && event.target === action.target)
    return events.some((event) => event.type === requiredType && event.isTrusted) ? events : false
  })
  if (observed.some((event) => event.isTrusted !== true)) throw new Error('Preview action emitted an untrusted event')
  const finalSnapshot = await captureAll(session, captures, requirements, contextId)
  const elapsedMs = Date.now() - startedAt
  if (elapsedMs > ACTION_TIMEOUT_MS) throw new Error('Preview action exceeded 3 seconds')
  return {
    ordinal,
    kind: action.kind,
    target: action.target,
    isTrusted: true,
    hitTestIdentity: target.hitIdentity,
    rect: target.rect,
    observedEventTypes: [...new Set(observed.map((event) => event.type))].sort(),
    elapsedMs,
    preCaptureDigest,
    postCaptureDigest: captureChainDigest(finalSnapshot),
  }
}

async function resetScenario(
  session: InteractionCdpSession,
  previewUrl: string,
  vector: OpenDesignM1InteractionVector,
): Promise<number> {
  const origin = new URL(previewUrl).origin
  await session.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' })
  await session.send('Network.clearBrowserCache')
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: vector.viewport.width,
    height: vector.viewport.height,
    deviceScaleFactor: vector.viewport.deviceScaleFactor,
    mobile: false,
  })
  await session.send('Page.navigate', { url: previewUrl })
  return requireReady(session, previewUrl)
}

function targetSocket(value: unknown, cdpOrigin: string): { id: string; webSocketDebuggerUrl: string } {
  const object = objectAt(value, 'Preview target')
  if (typeof object.id !== 'string' || !SAFE_SEMANTIC_ID.test(object.id) || object.type !== 'page'
    || typeof object.webSocketDebuggerUrl !== 'string') throw new Error('Preview interaction CDP target is invalid')
  const socket = new URL(object.webSocketDebuggerUrl)
  const cdp = new URL(cdpOrigin)
  if (socket.protocol !== 'ws:' || socket.hostname !== cdp.hostname || socket.port !== cdp.port
    || socket.username || socket.password || socket.pathname !== `/devtools/page/${object.id}`) {
    throw new Error('Preview interaction CDP target socket is invalid')
  }
  return { id: object.id, webSocketDebuggerUrl: object.webSocketDebuggerUrl }
}

export async function runOpenDesignM1PreviewInteraction(options: {
  previewUrl: string
  vector: OpenDesignM1InteractionVector
  captureScreenshot: boolean
  cdpOrigin?: string
  fetchImpl?: FetchLike
  createSession?: (webSocketDebuggerUrl: string) => InteractionCdpSession
}): Promise<OpenDesignM1PreviewInteractionResult> {
  validateOpenDesignM1InteractionVector(options.vector)
  const requirements = captureRequirements(options.vector)
  const previewUrl = exactLoopbackPreviewUrl(options.previewUrl)
  const cdpOrigin = options.cdpOrigin ?? 'http://127.0.0.1:9347'
  const fetchImpl = options.fetchImpl ?? fetch
  const createResponse = await fetchImpl(`${cdpOrigin}/json/new?${encodeURIComponent(previewUrl)}`, {
    method: 'PUT', redirect: 'error',
  })
  const body = await createResponse.text()
  if (!createResponse.ok || Buffer.byteLength(body, 'utf8') > 32 * 1024) throw new Error('Preview interaction CDP target creation failed')
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { throw new Error('Preview interaction CDP target response is invalid') }
  const target = targetSocket(parsed, cdpOrigin)
  const session = (options.createSession ?? ((url: string) => new WebSocketInteractionCdpSession(url)))(target.webSocketDebuggerUrl)
  const faults: string[] = []
  const requests = new Map<string, string>()
  const recordFault = (fault: string): void => {
    if (faults.length < 64) faults.push(fault)
  }
  let screenshot: Buffer | undefined
  let interaction: OpenDesignM1InteractionEvidence | undefined
  let failure: unknown
  try {
    await session.connect()
    const removeListener = session.onEvent((method, params) => {
      if (method === 'Runtime.exceptionThrown') recordFault('runtime-exception')
      if (method === 'Runtime.consoleAPICalled' && params.type === 'error') recordFault('console-error')
      if (method === 'Log.entryAdded' && (params.entry as JsonObject | undefined)?.level === 'error') recordFault('log-error')
      if (method === 'Network.requestWillBeSent' && typeof params.requestId === 'string') {
        const url = (params.request as JsonObject | undefined)?.url
        if (typeof url === 'string') {
          if (requests.size >= 256 && !requests.has(params.requestId)) recordFault('network-observation-overflow')
          else requests.set(params.requestId, url)
        }
      }
      if ((method === 'Network.loadingFailed' || method === 'Network.responseReceived') && typeof params.requestId === 'string') {
        const url = requests.get(params.requestId)
        const status = (params.response as JsonObject | undefined)?.status
        if (url) {
          let nonLoopback = false
          try {
            const parsedUrl = new URL(url)
            nonLoopback = (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') && parsedUrl.hostname !== '127.0.0.1'
          } catch { nonLoopback = true }
          if (nonLoopback && (method === 'Network.loadingFailed' || (typeof status === 'number' && status >= 400))) {
            recordFault('non-loopback-request-failure')
          }
        }
      }
      if ((method === 'Network.loadingFinished' || method === 'Network.loadingFailed') && typeof params.requestId === 'string') {
        requests.delete(params.requestId)
      }
    })
    try {
      for (const method of ['Runtime.enable', 'Page.enable', 'Network.enable', 'Log.enable']) await session.send(method)
      await session.send('DOM.enable')
      const initialContextId = await resetScenario(session, previewUrl, options.vector)
      for (const targetDefinition of options.vector.targets.filter((value) => value.initiallyVisible)) {
        if (targetDefinition.kind === 'observation') {
          const value = objectAt(await session.evaluate(
            targetObservationExpression(targetDefinition.semanticId), initialContextId,
          ), targetDefinition.semanticId)
          if (value.present !== true || value.visible !== true) throw new Error(`Initial semantic observation target is unavailable: ${targetDefinition.semanticId}`)
        } else {
          await requireRenderedTarget(session, targetDefinition.semanticId, initialContextId)
        }
      }
      const initialCaptures = await captureAll(session, options.vector.captures, requirements, initialContextId)
      const initialAssertions = evaluateAssertions(options.vector.initialAssertions, initialCaptures, initialCaptures)
      if (options.captureScreenshot) {
        const value = await session.screenshot()
        if (!Buffer.isBuffer(value) || value.byteLength < PNG_SIGNATURE.byteLength || value.byteLength > 4 * 1024 * 1024
          || !value.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
          throw new Error('Preview interaction screenshot is invalid')
        }
        screenshot = value
      }
      const ledger: OpenDesignM1InteractionEvidence['ledger'][number][] = []
      for (const vectorScenario of options.vector.scenarios) {
        const scenarioContextId = await resetScenario(session, previewUrl, options.vector)
        const scenarioInitial = await captureAll(session, options.vector.captures, requirements, scenarioContextId)
        const actions: InteractionActionEvidence[] = []
        let previousDigest = captureChainDigest(scenarioInitial)
        for (let index = 0; index < vectorScenario.actions.length; index += 1) {
          const actionEvidence = await executeAction(
            session,
            vectorScenario.actions[index]!,
            options.vector.captures,
            requirements,
            scenarioContextId,
            index + 1,
          )
          if (actionEvidence.preCaptureDigest !== previousDigest) throw new Error('Preview interaction capture chain split')
          previousDigest = actionEvidence.postCaptureDigest
          actions.push(actionEvidence)
        }
        const scenarioFinal = await waitFor('Preview interaction final assertions', async () => {
          const candidate = await captureAll(session, options.vector.captures, requirements, scenarioContextId)
          try {
            evaluateAssertions(vectorScenario.assertions, scenarioInitial, candidate)
            return candidate
          } catch {
            return false
          }
        })
        const finalDigest = captureChainDigest(scenarioFinal)
        if (actions.at(-1)?.postCaptureDigest !== finalDigest) {
          actions[actions.length - 1] = { ...actions.at(-1)!, postCaptureDigest: finalDigest }
        }
        ledger.push({
          scenarioId: vectorScenario.id,
          reset: vectorScenario.reset,
          initialCaptures: scenarioInitial,
          actions,
          finalCaptures: scenarioFinal,
          assertions: evaluateAssertions(vectorScenario.assertions, scenarioInitial, scenarioFinal),
        })
      }
      if (faults.length !== 0) throw new Error(`Preview interaction observed ${faults[0]}`)
      const initial = { captures: initialCaptures, assertions: initialAssertions }
      interaction = {
        schemaVersion: 2,
        vectorSha256: openDesignM1InteractionVectorSha256(options.vector),
        initial,
        ledger,
        normalizedOutcomeDigest: openDesignM1NormalizedOutcomeDigest(options.vector, initial, ledger),
      }
      validateOpenDesignM1InteractionEvidence(options.vector, interaction)
    } finally {
      removeListener()
    }
  } catch (error) {
    failure = error
  }
  try { session.close() } catch (error) { failure = failure ? new AggregateError([failure, error], 'Preview interaction and cleanup failed') : error }
  try {
    const closeResponse = await fetchImpl(`${cdpOrigin}/json/close/${encodeURIComponent(target.id)}`, { redirect: 'error' })
    const closeBody = await closeResponse.text()
    if (!closeResponse.ok || Buffer.byteLength(closeBody, 'utf8') > 4 * 1024) throw new Error('Preview interaction CDP target cleanup failed')
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'Preview interaction and cleanup failed') : error
  }
  if (failure) throw failure
  if (!interaction) throw new Error('Preview interaction evidence is unavailable')
  return { interaction, ...(screenshot ? { screenshot } : {}) }
}

function deterministicFixtureSnapshot(vector: OpenDesignM1InteractionVector): SafeCaptureSnapshot {
  const requirements = captureRequirements(vector)
  const result: Record<string, SafeCaptureObservation> = {}
  for (const capture of vector.captures) {
    if (capture.kind === 'element') {
      result[capture.id] = {
        kind: 'element', semanticId: capture.semanticId, present: true, visible: true, inViewport: true, enabled: true,
        checked: false, rect: { x: 10, y: 10, width: 80, height: 32 },
        textSha256: sha256(`text:${vector.caseId}:${capture.id}`),
        valueSha256: sha256(`value:${vector.caseId}:${capture.id}`), numericValue: 1,
        attributes: Object.fromEntries((requirements.attributes[capture.id] ?? []).map((name) => [
          name,
          name === 'data-m1-secret-present' ? 'false'
            : name === 'data-m1-secret-digest' ? sha256(`secret:${vector.caseId}:${capture.id}`)
              : 'fixture',
        ])),
      }
    } else if (capture.kind === 'collection') {
      result[capture.id] = {
        kind: 'collection', semanticPrefix: capture.semanticPrefix, visibleCount: 8,
        idDigest: sha256(`ids:${vector.caseId}:${capture.id}`),
        stateDigest: sha256(`state:${vector.caseId}:${capture.id}:initial`), attributeCounts: {},
      }
    } else if (capture.kind === 'document') {
      result[capture.id] = { kind: 'document', innerWidth: 1280, scrollWidth: 1280, noHorizontalOverflow: true }
    } else {
      result[capture.id] = {
        kind: 'secret-safety', semanticPrefix: capture.semanticPrefix, inspectedVisibleNodes: 1, safe: true,
      }
    }
  }
  return result
}

function assignFixtureMetric(
  initial: SafeCaptureSnapshot,
  final: SafeCaptureSnapshot,
  metric: InteractionMetric,
  value: string | number | boolean,
): void {
  const snapshot = (metric.stage === 'initial' ? initial : final) as Record<string, any>
  const capture = snapshot[metric.capture]
  if (!capture) throw new Error(`Fixture metric capture is unavailable: ${metric.capture}`)
  if (metric.field === 'attribute') capture.attributes[metric.attribute!] = String(value)
  else if (metric.field === 'visible') {
    capture.visible = Boolean(value)
    if (!capture.visible) {
      capture.inViewport = false
      capture.enabled = false
    }
  } else if (metric.field === 'inViewport') {
    capture.inViewport = Boolean(value)
    if (capture.inViewport) capture.visible = true
  } else if (metric.field === 'enabled' || metric.field === 'checked'
    || metric.field === 'safe') capture[metric.field] = Boolean(value)
  else if (metric.field === 'noHorizontalOverflow') {
    capture.noHorizontalOverflow = Boolean(value)
    capture.scrollWidth = capture.noHorizontalOverflow ? Math.min(capture.scrollWidth, capture.innerWidth) : capture.innerWidth + 2
  }
  else if (metric.field === 'textSha256' || metric.field === 'valueSha256'
    || metric.field === 'idDigest' || metric.field === 'stateDigest') capture[metric.field] = String(value)
  else if (metric.field === 'rectLeft') {
    capture.rect ??= { x: 0, y: 0, width: 80, height: 32 }
    capture.rect.x = Number(value)
  } else if (metric.field === 'rectRight') {
    capture.rect ??= { x: 0, y: 0, width: 80, height: 32 }
    capture.rect.width = Math.max(24, Number(value) - capture.rect.x)
  } else {
    capture[metric.field] = Number(value)
    if (metric.field === 'innerWidth' && capture.noHorizontalOverflow) capture.scrollWidth = Math.min(capture.scrollWidth, capture.innerWidth)
    if (metric.field === 'scrollWidth') capture.noHorizontalOverflow = capture.scrollWidth <= capture.innerWidth + 1
  }
}

function fixtureMetricDefault(
  initial: SafeCaptureSnapshot,
  final: SafeCaptureSnapshot,
  metric: InteractionMetric,
): string | number | boolean {
  const existing = metricValue(initial, final, metric)
  if (typeof existing === 'string' || typeof existing === 'number' || typeof existing === 'boolean') return existing
  if (metric.field === 'textSha256' || metric.field === 'valueSha256'
    || metric.field === 'idDigest' || metric.field === 'stateDigest') return sha256(`fixture:${metric.capture}:${metric.field}`)
  if (metric.field === 'visible' || metric.field === 'inViewport' || metric.field === 'enabled' || metric.field === 'checked'
    || metric.field === 'noHorizontalOverflow' || metric.field === 'safe') return true
  if (metric.field === 'attribute') return 'fixture'
  return 1
}

function alternateFixtureValue(value: string | number | boolean, field: InteractionMetric['field']): string | number | boolean {
  if (typeof value === 'boolean') return !value
  if (typeof value === 'number') return value + 1
  if (field === 'textSha256' || field === 'valueSha256' || field === 'idDigest' || field === 'stateDigest') {
    return value === 'b'.repeat(64) ? 'c'.repeat(64) : 'b'.repeat(64)
  }
  return value === 'changed' ? 'different' : 'changed'
}

function satisfyFixtureAssertions(
  assertions: readonly InteractionAssertion[],
  initial: SafeCaptureSnapshot,
  final: SafeCaptureSnapshot,
): void {
  const ordered = [...assertions].sort((left, right) => {
    const rank = (value: InteractionAssertion): number => {
      if (value.kind !== 'compare') return 2
      if ('literal' in value.right) return 0
      return value.comparison === 'equals' ? 3 : 1
    }
    return rank(left) - rank(right)
  })
  for (const assertion of ordered) {
    if (assertionPasses(assertion, initial, final)) continue
    if (assertion.kind === 'compare') {
      if ('literal' in assertion.right) {
        const right = assertion.right.literal
        if (assertion.comparison === 'equals') assignFixtureMetric(initial, final, assertion.left, right)
        else if (assertion.comparison === 'notEquals') assignFixtureMetric(initial, final, assertion.left, alternateFixtureValue(right, assertion.left.field))
        else if (assertion.comparison === 'greaterThan') assignFixtureMetric(initial, final, assertion.left, Number(right) + 1)
        else if (assertion.comparison === 'lessThan') assignFixtureMetric(initial, final, assertion.left, Number(right) - 1)
        else if (assertion.comparison === 'atLeast') assignFixtureMetric(initial, final, assertion.left, right)
        else assignFixtureMetric(initial, final, assertion.left, right)
      } else {
        let right = fixtureMetricDefault(initial, final, assertion.right)
        if (metricValue(initial, final, assertion.right) === undefined) {
          assignFixtureMetric(initial, final, assertion.right, right)
        }
        if (assertionPasses(assertion, initial, final)) continue
        if (assertion.comparison === 'equals') {
          const left = fixtureMetricDefault(initial, final, assertion.left)
          const opposite = (metric: InteractionMetric): InteractionMetric => ({
            ...metric, stage: metric.stage === 'initial' ? 'final' : 'initial',
          })
          const leftChanged = left !== fixtureMetricDefault(initial, final, opposite(assertion.left))
          const rightChanged = right !== fixtureMetricDefault(initial, final, opposite(assertion.right))
          const shared = leftChanged && !rightChanged ? left : rightChanged ? right : right
          assignFixtureMetric(initial, final, assertion.right, shared)
          assignFixtureMetric(initial, final, assertion.left, shared)
        } else if (assertion.comparison === 'notEquals') {
          assignFixtureMetric(initial, final, assertion.right, right)
          assignFixtureMetric(initial, final, assertion.left, alternateFixtureValue(right, assertion.left.field))
        } else {
          const numericRight = numeric(right) ?? 1
          assignFixtureMetric(initial, final, assertion.right, numericRight)
          assignFixtureMetric(initial, final, assertion.left,
            assertion.comparison === 'greaterThan' ? numericRight + 1
              : assertion.comparison === 'lessThan' ? numericRight - 1
                : numericRight)
        }
      }
      continue
    }
    const snapshot = (assertion.stage === 'initial' ? initial : final) as Record<string, any>
    const capture = snapshot[assertion.capture]
    if (!capture || capture.kind !== 'collection') throw new Error(`Fixture collection is unavailable: ${assertion.capture}`)
    const counts = capture.attributeCounts[assertion.attribute] ??= {}
    if (assertion.kind === 'collectionAllAttributeEquals') {
      capture.attributeCounts[assertion.attribute] = { [assertion.value]: capture.visibleCount }
    } else if (assertion.kind === 'collectionDistinctAttributeAtLeast') {
      capture.visibleCount = Math.max(capture.visibleCount, assertion.count)
      const next: Record<string, number> = {}
      for (let index = 0; index < assertion.count; index += 1) next[`value-${index + 1}`] = 1
      capture.attributeCounts[assertion.attribute] = next
    } else {
      counts[assertion.value] = Math.max(counts[assertion.value] ?? 0, assertion.count)
      capture.visibleCount = Math.max(capture.visibleCount,
        Object.values(counts as Record<string, number>).reduce((sum, count) => sum + count, 0))
    }
    capture.stateDigest = sha256(canonical(capture.attributeCounts))
  }
}

/** Test-only deterministic fixture. The packaged producer never calls this helper. */
export function createDeterministicOpenDesignM1InteractionEvidenceFixture(
  vector: OpenDesignM1InteractionVector,
): OpenDesignM1InteractionEvidence {
  validateOpenDesignM1InteractionVector(vector)
  const initial = deterministicFixtureSnapshot(vector)
  satisfyFixtureAssertions(vector.initialAssertions, initial, initial)
  const ledger = vector.scenarios.map((scenario) => {
    const scenarioInitial = structuredClone(initial) as SafeCaptureSnapshot
    const scenarioFinal = structuredClone(scenarioInitial) as SafeCaptureSnapshot
    satisfyFixtureAssertions(scenario.assertions, scenarioInitial, scenarioFinal)
    const initialDigest = captureChainDigest(scenarioInitial)
    const finalDigest = captureChainDigest(scenarioFinal)
    const actions = scenario.actions.map((action, index): InteractionActionEvidence => ({
      ordinal: index + 1,
      kind: action.kind,
      target: 'target' in action ? action.target : null,
      isTrusted: true,
      hitTestIdentity: 'target' in action ? action.target : null,
      rect: 'target' in action ? { x: 10, y: 10, width: 80, height: 32 } : null,
      observedEventTypes: [action.kind === 'setViewport' ? 'cdp-emulation'
        : action.kind === 'pointerClick' ? 'click'
          : action.kind === 'pressKeys' ? 'keydown' : 'input'],
      elapsedMs: 1,
      preCaptureDigest: index === 0 ? initialDigest : (index === scenario.actions.length - 1 ? initialDigest : initialDigest),
      postCaptureDigest: index === scenario.actions.length - 1 ? finalDigest : initialDigest,
    }))
    return {
      scenarioId: scenario.id,
      reset: scenario.reset,
      initialCaptures: scenarioInitial,
      actions,
      finalCaptures: scenarioFinal,
      assertions: evaluateAssertions(scenario.assertions, scenarioInitial, scenarioFinal),
    }
  })
  const fixtureInitial = { captures: initial, assertions: evaluateAssertions(vector.initialAssertions, initial, initial) }
  const evidence: OpenDesignM1InteractionEvidence = {
    schemaVersion: 2,
    vectorSha256: openDesignM1InteractionVectorSha256(vector),
    initial: fixtureInitial,
    ledger,
    normalizedOutcomeDigest: openDesignM1NormalizedOutcomeDigest(vector, fixtureInitial, ledger),
  }
  validateOpenDesignM1InteractionEvidence(vector, evidence)
  return evidence
}

function maximumStateToken(label: string, ordinal: number): string {
  const prefix = `${label.replace(/[^A-Za-z0-9._-]/g, '-')}-${ordinal}-`
  return prefix.padEnd(64, 'x').slice(0, 64)
}

function schemaMaximumSnapshot(
  vector: OpenDesignM1InteractionVector,
  requirements: CaptureRequirements,
  stageOrdinal: number,
): SafeCaptureSnapshot {
  const result: Record<string, SafeCaptureObservation> = {}
  for (const capture of vector.captures) {
    if (capture.kind === 'element') {
      result[capture.id] = {
        kind: 'element', semanticId: capture.semanticId, present: true, visible: true, inViewport: true,
        enabled: true, checked: true, rect: { x: 10, y: 10, width: 80, height: 32 },
        textSha256: sha256(`schema-max-text:${vector.caseId}:${capture.id}:${stageOrdinal}`),
        valueSha256: sha256(`schema-max-value:${vector.caseId}:${capture.id}:${stageOrdinal}`),
        numericValue: Number.MAX_SAFE_INTEGER,
        attributes: Object.fromEntries((requirements.attributes[capture.id] ?? []).map((name, index) => [
          name,
          name === 'data-m1-secret-present' ? 'false'
            : name === 'data-m1-secret-digest' || name === 'data-m1-signature'
              ? sha256(`schema-max:${vector.caseId}:${capture.id}:${name}:${stageOrdinal}`)
              : maximumStateToken(`${capture.id}-${name}`, index + stageOrdinal + 1),
        ])),
      }
    } else if (capture.kind === 'collection') {
      const attributeCounts: Record<string, Record<string, number>> = {}
      for (const [attributeIndex, name] of (requirements.attributes[capture.id] ?? []).entries()) {
        attributeCounts[name] = Object.fromEntries(Array.from({ length: 64 }, (_, valueIndex) => [
          maximumStateToken(`${capture.id}-${attributeIndex}`, valueIndex + 1),
          2,
        ]))
      }
      result[capture.id] = {
        kind: 'collection', semanticPrefix: capture.semanticPrefix, visibleCount: MAX_CAPTURE_ITEMS,
        idDigest: sha256(`schema-max-ids:${vector.caseId}:${capture.id}:${stageOrdinal}`),
        stateDigest: sha256(`schema-max-state:${vector.caseId}:${capture.id}:${stageOrdinal}`),
        attributeCounts,
      }
    } else if (capture.kind === 'document') {
      result[capture.id] = {
        kind: 'document', innerWidth: Number.MAX_SAFE_INTEGER,
        scrollWidth: Number.MAX_SAFE_INTEGER, noHorizontalOverflow: true,
      }
    } else {
      result[capture.id] = {
        kind: 'secret-safety', semanticPrefix: capture.semanticPrefix,
        inspectedVisibleNodes: MAX_CAPTURE_ITEMS, safe: true,
      }
    }
  }
  return result
}

function maximumObservedEventTypes(required: string): readonly string[] {
  return [required, ...Array.from({ length: 7 }, (_, index) => (
    maximumStateToken('event', index + 1).padEnd(128, 'z')
  ))].sort()
}

function prepareSchemaMaximumAssertions(
  assertions: readonly InteractionAssertion[],
  initial: SafeCaptureSnapshot,
  final: SafeCaptureSnapshot,
): void {
  for (const assertion of assertions) {
    if (assertion.kind === 'collectionAttributeCountAtLeast') {
      const snapshot = (assertion.stage === 'initial' ? initial : final) as Record<string, SafeCaptureObservation>
      const capture = snapshot[assertion.capture]
      if (!capture || capture.kind !== 'collection') continue
      const counts = capture.attributeCounts[assertion.attribute] as Record<string, number> | undefined
      if (!counts || counts[assertion.value] !== undefined) continue
      const requiredValues = new Set(assertions.flatMap((candidate) => (
        candidate.kind === 'collectionAttributeCountAtLeast'
          && candidate.stage === assertion.stage
          && candidate.capture === assertion.capture
          && candidate.attribute === assertion.attribute
          ? [candidate.value]
          : []
      )))
      const first = Object.keys(counts).sort().find((value) => !requiredValues.has(value))
      if (first) {
        const count = counts[first]!
        delete counts[first]
        counts[assertion.value] = Math.max(count, assertion.count)
      }
      continue
    }
    if (assertion.kind !== 'compare' || !('capture' in assertion.right)
      || assertion.left.field !== 'visibleCount' || assertion.right.field !== 'visibleCount') continue
    if (assertion.comparison === 'greaterThan') {
      assignFixtureMetric(initial, final, assertion.right, MAX_CAPTURE_ITEMS - 1)
      assignFixtureMetric(initial, final, assertion.left, MAX_CAPTURE_ITEMS)
    } else if (assertion.comparison === 'lessThan') {
      assignFixtureMetric(initial, final, assertion.right, MAX_CAPTURE_ITEMS)
      assignFixtureMetric(initial, final, assertion.left, MAX_CAPTURE_ITEMS - 1)
    }
  }
}

function fitSchemaMaximumCollectionCounts(
  assertions: readonly InteractionAssertion[],
  snapshot: SafeCaptureSnapshot,
  stage: 'initial' | 'final',
): void {
  for (const [captureId, capture] of Object.entries(snapshot)) {
    if (capture.kind !== 'collection') continue
    for (const [attribute, readonlyCounts] of Object.entries(capture.attributeCounts)) {
      const counts = readonlyCounts as Record<string, number>
      let overflow = Object.values(counts).reduce((sum, count) => sum + count, 0) - capture.visibleCount
      if (overflow <= 0) continue
      const minimums = new Map<string, number>()
      let minimumDistinctValues = 0
      for (const assertion of assertions) {
        if (assertion.kind === 'collectionAttributeCountAtLeast' && assertion.stage === stage
          && assertion.capture === captureId && assertion.attribute === attribute) {
          minimums.set(assertion.value, Math.max(minimums.get(assertion.value) ?? 1, assertion.count))
        } else if (assertion.kind === 'collectionAllAttributeEquals' && assertion.stage === stage
          && assertion.capture === captureId && assertion.attribute === attribute) {
          minimums.set(assertion.value, capture.visibleCount)
          minimumDistinctValues = Math.max(minimumDistinctValues, 1)
        } else if (assertion.kind === 'collectionDistinctAttributeAtLeast' && assertion.stage === stage
          && assertion.capture === captureId && assertion.attribute === attribute) {
          minimumDistinctValues = Math.max(minimumDistinctValues, assertion.count)
        }
      }
      for (const value of Object.keys(counts).sort().reverse()) {
        const minimum = minimums.get(value) ?? 1
        const available = Math.max(0, counts[value]! - minimum)
        const reduction = Math.min(overflow, available)
        counts[value] = counts[value]! - reduction
        overflow -= reduction
        if (overflow === 0) break
      }
      const requiredDistinctValues = Math.max(minimumDistinctValues, minimums.size)
      for (const value of Object.keys(counts).sort().reverse()) {
        if (overflow === 0 || Object.keys(counts).length <= requiredDistinctValues || minimums.has(value)) continue
        overflow -= counts[value]!
        delete counts[value]
      }
      if (overflow !== 0) throw new Error('Schema-maximum collection counts cannot satisfy the fixed vector')
    }
  }
}

/** Test-only schema-maximum fixture. The packaged producer never calls this helper. */
export function createSchemaMaximumOpenDesignM1InteractionEvidenceFixture(
  vector: OpenDesignM1InteractionVector,
): OpenDesignM1InteractionEvidence {
  validateOpenDesignM1InteractionVector(vector)
  const requirements = captureRequirements(vector)
  const initialCaptures = schemaMaximumSnapshot(vector, requirements, 0)
  prepareSchemaMaximumAssertions(vector.initialAssertions, initialCaptures, initialCaptures)
  satisfyFixtureAssertions(vector.initialAssertions, initialCaptures, initialCaptures)
  fitSchemaMaximumCollectionCounts(vector.initialAssertions, initialCaptures, 'initial')
  const ledger = vector.scenarios.map((scenario, scenarioIndex) => {
    const scenarioInitial = schemaMaximumSnapshot(vector, requirements, scenarioIndex * 2 + 1)
    const scenarioFinal = structuredClone(scenarioInitial) as SafeCaptureSnapshot
    prepareSchemaMaximumAssertions(scenario.assertions, scenarioInitial, scenarioFinal)
    satisfyFixtureAssertions(scenario.assertions, scenarioInitial, scenarioFinal)
    fitSchemaMaximumCollectionCounts(scenario.assertions, scenarioInitial, 'initial')
    fitSchemaMaximumCollectionCounts(scenario.assertions, scenarioFinal, 'final')
    const initialDigest = captureChainDigest(scenarioInitial)
    const finalDigest = captureChainDigest(scenarioFinal)
    let previousDigest = initialDigest
    const actions = scenario.actions.map((action, actionIndex): InteractionActionEvidence => {
      const required = action.kind === 'setViewport' ? 'cdp-emulation'
        : action.kind === 'pointerClick' ? 'click'
          : action.kind === 'pressKeys' ? 'keydown' : 'input'
      const postCaptureDigest = actionIndex === scenario.actions.length - 1 ? finalDigest : initialDigest
      const evidence: InteractionActionEvidence = {
        ordinal: actionIndex + 1,
        kind: action.kind,
        target: 'target' in action ? action.target : null,
        isTrusted: true,
        hitTestIdentity: 'target' in action ? action.target : null,
        rect: 'target' in action
          ? { x: Number.MAX_SAFE_INTEGER, y: Number.MAX_SAFE_INTEGER, width: 10_000, height: 10_000 }
          : null,
        observedEventTypes: action.kind === 'setViewport' ? ['cdp-emulation'] : maximumObservedEventTypes(required),
        elapsedMs: ACTION_TIMEOUT_MS,
        preCaptureDigest: previousDigest,
        postCaptureDigest,
      }
      previousDigest = postCaptureDigest
      return evidence
    })
    return {
      scenarioId: scenario.id,
      reset: scenario.reset,
      initialCaptures: scenarioInitial,
      actions,
      finalCaptures: scenarioFinal,
      assertions: evaluateAssertions(scenario.assertions, scenarioInitial, scenarioFinal),
    }
  })
  const initial = {
    captures: initialCaptures,
    assertions: evaluateAssertions(vector.initialAssertions, initialCaptures, initialCaptures),
  }
  const evidence: OpenDesignM1InteractionEvidence = {
    schemaVersion: 2,
    vectorSha256: openDesignM1InteractionVectorSha256(vector),
    initial,
    ledger,
    normalizedOutcomeDigest: openDesignM1NormalizedOutcomeDigest(vector, initial, ledger),
  }
  validateOpenDesignM1InteractionEvidence(vector, evidence)
  return evidence
}

function validateSnapshot(
  value: unknown,
  captures: readonly InteractionCapture[],
  requirements: CaptureRequirements,
  path: string,
): SafeCaptureSnapshot {
  const object = objectAt(value, path)
  exactKeys(object, captures.map((capture) => capture.id), path)
  const result: Record<string, SafeCaptureObservation> = {}
  for (const capture of captures) {
    const itemPath = `${path}.${capture.id}`
    const item = objectAt(object[capture.id], itemPath)
    if (capture.kind === 'element') {
      exactKeys(item, ['attributes', 'checked', 'enabled', 'inViewport', 'kind', 'numericValue', 'present', 'rect', 'semanticId', 'textSha256', 'valueSha256', 'visible'], itemPath)
      if (item.kind !== 'element' || item.semanticId !== capture.semanticId || typeof item.present !== 'boolean'
        || typeof item.visible !== 'boolean' || typeof item.inViewport !== 'boolean' || typeof item.enabled !== 'boolean'
        || (item.checked !== null && typeof item.checked !== 'boolean')
        || !SHA256.test(String(item.textSha256)) || !SHA256.test(String(item.valueSha256))
        || (item.numericValue !== null && (typeof item.numericValue !== 'number' || !Number.isFinite(item.numericValue)))) {
        throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${itemPath}`)
      }
      const attributes = safeAttributes(item.attributes, `${itemPath}.attributes`)
      const allowedAttributes = new Set(requirements.attributes[capture.id] ?? [])
      if (Object.keys(attributes).some((name) => !allowedAttributes.has(name))) {
        throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${itemPath}.attributes.authority`)
      }
      if ((item.present === false && (item.visible !== false || item.inViewport !== false || item.enabled !== false || item.rect !== null
        || item.checked !== null || Object.keys(objectAt(item.attributes, `${itemPath}.attributes`)).length !== 0))
        || (item.present === true && item.rect === null)
        || (item.visible === false && (item.inViewport === true || item.enabled === true))) {
        throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${itemPath}.presence`)
      }
      result[capture.id] = {
        kind: 'element', semanticId: capture.semanticId, present: item.present, visible: item.visible,
        inViewport: item.inViewport,
        enabled: item.enabled, checked: item.checked as boolean | null,
        rect: item.rect === null ? null : safeRect(item.rect, `${itemPath}.rect`),
        textSha256: item.textSha256 as string, valueSha256: item.valueSha256 as string,
        numericValue: item.numericValue as number | null,
        attributes,
      }
    } else if (capture.kind === 'collection') {
      exactKeys(item, ['attributeCounts', 'idDigest', 'kind', 'semanticPrefix', 'stateDigest', 'visibleCount'], itemPath)
      if (item.kind !== 'collection' || item.semanticPrefix !== capture.semanticPrefix
        || !Number.isSafeInteger(item.visibleCount) || (item.visibleCount as number) < 0 || (item.visibleCount as number) > MAX_CAPTURE_ITEMS
        || !SHA256.test(String(item.idDigest)) || !SHA256.test(String(item.stateDigest))) {
        throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${itemPath}`)
      }
      const rawCounts = objectAt(item.attributeCounts, `${itemPath}.attributeCounts`)
      const attributeCounts: Record<string, Record<string, number>> = {}
      const attributeNames = Object.keys(rawCounts).sort()
      const allowedAttributes = new Set(requirements.attributes[capture.id] ?? [])
      if (attributeNames.some((name) => !allowedAttributes.has(name))) {
        throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${itemPath}.attributeCounts.authority`)
      }
      if (attributeNames.length > 32) throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${itemPath}.attributeCounts`)
      for (const name of attributeNames) {
        if (!SAFE_ATTRIBUTE.test(name)) throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${itemPath}.attributeCounts`)
        const counts = objectAt(rawCounts[name], `${itemPath}.attributeCounts.${name}`)
        const normalized: Record<string, number> = {}
        const valueNames = Object.keys(counts).sort()
        if (valueNames.length > 64) throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${itemPath}.attributeCounts.${name}`)
        let attributeTotal = 0
        for (const valueName of valueNames) {
          if (!SAFE_ATTRIBUTE_VALUE.test(valueName) || !Number.isSafeInteger(counts[valueName]) || (counts[valueName] as number) < 1) {
            throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${itemPath}.attributeCounts.${name}`)
          }
          normalized[valueName] = counts[valueName] as number
          attributeTotal += counts[valueName] as number
        }
        if (attributeTotal > (item.visibleCount as number)) {
          throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${itemPath}.attributeCounts.${name}`)
        }
        attributeCounts[name] = normalized
      }
      result[capture.id] = {
        kind: 'collection', semanticPrefix: capture.semanticPrefix, visibleCount: item.visibleCount as number,
        idDigest: item.idDigest as string, stateDigest: item.stateDigest as string, attributeCounts,
      }
    } else if (capture.kind === 'document') {
      exactKeys(item, ['innerWidth', 'kind', 'noHorizontalOverflow', 'scrollWidth'], itemPath)
      if (item.kind !== 'document' || typeof item.noHorizontalOverflow !== 'boolean') {
        throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${itemPath}`)
      }
      const innerWidth = finite(item.innerWidth, `${itemPath}.innerWidth`)
      const scrollWidth = finite(item.scrollWidth, `${itemPath}.scrollWidth`)
      if (item.noHorizontalOverflow !== (scrollWidth <= innerWidth + 1)) {
        throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${itemPath}.noHorizontalOverflow`)
      }
      result[capture.id] = { kind: 'document', innerWidth, scrollWidth, noHorizontalOverflow: item.noHorizontalOverflow }
    } else {
      exactKeys(item, ['inspectedVisibleNodes', 'kind', 'safe', 'semanticPrefix'], itemPath)
      if (item.kind !== 'secret-safety' || item.semanticPrefix !== capture.semanticPrefix
        || !Number.isSafeInteger(item.inspectedVisibleNodes) || (item.inspectedVisibleNodes as number) < 1
        || (item.inspectedVisibleNodes as number) > MAX_CAPTURE_ITEMS
        || typeof item.safe !== 'boolean') throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${itemPath}`)
      result[capture.id] = {
        kind: 'secret-safety', semanticPrefix: capture.semanticPrefix,
        inspectedVisibleNodes: item.inspectedVisibleNodes as number, safe: item.safe,
      }
    }
  }
  return result
}

function validateAssertionEvidence(
  value: unknown,
  expected: readonly InteractionAssertion[],
  initial: SafeCaptureSnapshot,
  final: SafeCaptureSnapshot,
  path: string,
): readonly InteractionAssertionEvidence[] {
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${path}`)
  }
  return value.map((item, index) => {
    const object = objectAt(item, `${path}[${index}]`)
    exactKeys(object, ['id', 'passed'], `${path}[${index}]`)
    if (object.id !== expected[index]!.id || object.passed !== true || !assertionPasses(expected[index]!, initial, final)) {
      throw new TypeError(`OpenDesign M1 interaction evidence assertion failed: ${path}[${index}]`)
    }
    return { id: object.id as string, passed: true }
  })
}

export function validateOpenDesignM1InteractionEvidence(
  vector: OpenDesignM1InteractionVector,
  value: unknown,
): OpenDesignM1InteractionEvidence {
  validateOpenDesignM1InteractionVector(vector)
  const requirements = captureRequirements(vector)
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new TypeError('OpenDesign M1 interaction evidence is invalid: $interaction.size')
  }
  if (serialized === undefined
    || Buffer.byteLength(serialized, 'utf8') > OPEN_DESIGN_M1_INTERACTION_MAX_BYTES) {
    throw new TypeError('OpenDesign M1 interaction evidence is invalid: $interaction.size')
  }
  const object = objectAt(value, '$interaction')
  exactKeys(object, ['initial', 'ledger', 'normalizedOutcomeDigest', 'schemaVersion', 'vectorSha256'], '$interaction')
  if (object.schemaVersion !== 2 || object.vectorSha256 !== openDesignM1InteractionVectorSha256(vector)
    || !SHA256.test(String(object.normalizedOutcomeDigest))) {
    throw new TypeError('OpenDesign M1 interaction evidence is invalid: $interaction.authority')
  }
  const initialObject = objectAt(object.initial, '$interaction.initial')
  exactKeys(initialObject, ['assertions', 'captures'], '$interaction.initial')
  const initialCaptures = validateSnapshot(initialObject.captures, vector.captures, requirements, '$interaction.initial.captures')
  const initialAssertions = validateAssertionEvidence(
    initialObject.assertions, vector.initialAssertions, initialCaptures, initialCaptures, '$interaction.initial.assertions',
  )
  if (!Array.isArray(object.ledger) || object.ledger.length !== vector.scenarios.length) {
    throw new TypeError('OpenDesign M1 interaction evidence is invalid: $interaction.ledger')
  }
  const ledger = object.ledger.map((item, scenarioIndex) => {
    const scenario = vector.scenarios[scenarioIndex]!
    const itemPath = `$interaction.ledger[${scenarioIndex}]`
    const entry = objectAt(item, itemPath)
    exactKeys(entry, ['actions', 'assertions', 'finalCaptures', 'initialCaptures', 'reset', 'scenarioId'], itemPath)
    if (entry.scenarioId !== scenario.id || entry.reset !== scenario.reset || !Array.isArray(entry.actions)
      || entry.actions.length !== scenario.actions.length) throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${itemPath}`)
    const scenarioInitial = validateSnapshot(entry.initialCaptures, vector.captures, requirements, `${itemPath}.initialCaptures`)
    const scenarioFinal = validateSnapshot(entry.finalCaptures, vector.captures, requirements, `${itemPath}.finalCaptures`)
    let captureDigest = captureChainDigest(scenarioInitial)
    const actions = entry.actions.map((actionValue, actionIndex) => {
      const expected = scenario.actions[actionIndex]!
      const actionPath = `${itemPath}.actions[${actionIndex}]`
      const action = objectAt(actionValue, actionPath)
      exactKeys(action, ['elapsedMs', 'hitTestIdentity', 'isTrusted', 'kind', 'observedEventTypes', 'ordinal', 'postCaptureDigest', 'preCaptureDigest', 'rect', 'target'], actionPath)
      const expectedTarget = 'target' in expected ? expected.target : null
      if (action.ordinal !== actionIndex + 1 || action.kind !== expected.kind || action.target !== expectedTarget
        || action.isTrusted !== true || action.preCaptureDigest !== captureDigest
        || !SHA256.test(String(action.postCaptureDigest)) || !Number.isSafeInteger(action.elapsedMs)
        || (action.elapsedMs as number) < 0 || (action.elapsedMs as number) > ACTION_TIMEOUT_MS
        || !Array.isArray(action.observedEventTypes) || action.observedEventTypes.length < 1
        || action.observedEventTypes.length > 8 || action.observedEventTypes.some((name) => typeof name !== 'string' || !SAFE_SEMANTIC_ID.test(name))) {
        throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${actionPath}`)
      }
      let rect: SafeRect | null = null
      if (expected.kind === 'setViewport') {
        if (action.hitTestIdentity !== null || action.rect !== null
          || JSON.stringify(action.observedEventTypes) !== JSON.stringify(['cdp-emulation'])) {
          throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${actionPath}`)
        }
      } else {
        if (action.hitTestIdentity !== expectedTarget || action.rect === null) {
          throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${actionPath}`)
        }
        rect = safeRect(action.rect, `${actionPath}.rect`)
        if (rect.width < 24 || rect.height < 24) throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${actionPath}.rect`)
        const required = expected.kind === 'pointerClick' ? 'click' : expected.kind === 'pressKeys' ? 'keydown' : 'input'
        if (!(action.observedEventTypes as unknown[]).includes(required)) throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${actionPath}.observedEventTypes`)
      }
      captureDigest = action.postCaptureDigest as string
      return {
        ordinal: action.ordinal as number,
        kind: action.kind as InteractionAction['kind'],
        target: action.target as string | null,
        isTrusted: true as const,
        hitTestIdentity: action.hitTestIdentity as string | null,
        rect,
        observedEventTypes: action.observedEventTypes as string[],
        elapsedMs: action.elapsedMs as number,
        preCaptureDigest: action.preCaptureDigest as string,
        postCaptureDigest: action.postCaptureDigest as string,
      }
    })
    if (captureDigest !== captureChainDigest(scenarioFinal)) {
      throw new TypeError(`OpenDesign M1 interaction evidence is invalid: ${itemPath}.captureChain`)
    }
    const assertions = validateAssertionEvidence(entry.assertions, scenario.assertions, scenarioInitial, scenarioFinal, `${itemPath}.assertions`)
    return {
      scenarioId: scenario.id, reset: scenario.reset, initialCaptures: scenarioInitial,
      actions, finalCaptures: scenarioFinal, assertions,
    }
  })
  const expectedNormalizedOutcomeDigest = openDesignM1NormalizedOutcomeDigest(
    vector,
    { captures: initialCaptures, assertions: initialAssertions },
    ledger,
  )
  if (object.normalizedOutcomeDigest !== expectedNormalizedOutcomeDigest) {
    throw new TypeError('OpenDesign M1 interaction evidence is invalid: $interaction.normalizedOutcomeDigest')
  }
  return {
    schemaVersion: 2,
    vectorSha256: object.vectorSha256 as string,
    initial: { captures: initialCaptures, assertions: initialAssertions },
    ledger,
    normalizedOutcomeDigest: object.normalizedOutcomeDigest as string,
  }
}
