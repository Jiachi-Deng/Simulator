import { createHash } from 'node:crypto'
import {
  OPEN_DESIGN_M1_CASES,
  type OpenDesignM1Case,
} from './open-design-m1-cases'

export const OPEN_DESIGN_M1_FIXED_CASE_AUTHORITY_VERSION = 2 as const
export const OPEN_DESIGN_M1_INTERACTION_SCHEMA_VERSION = 2 as const
export const OPEN_DESIGN_M1_INTERACTION_RESET = 'clear-origin-storage-and-reload' as const

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SAFE_DATA_ATTRIBUTE = /^data-m1-[a-z][a-z0-9-]{0,31}$/

export type InteractionTargetKind = 'control' | 'input' | 'range' | 'observation'
export type InteractionAction =
  | { readonly kind: 'pointerClick'; readonly target: string }
  | { readonly kind: 'replaceText'; readonly target: string; readonly text: string }
  | { readonly kind: 'pressKeys'; readonly target: string; readonly keys: readonly string[] }
  | { readonly kind: 'setViewport'; readonly width: number; readonly height: number }

export interface InteractionTarget {
  readonly semanticId: string
  readonly kind: InteractionTargetKind
  readonly initiallyVisible: boolean
}

export type InteractionCapture =
  | { readonly id: string; readonly kind: 'element'; readonly semanticId: string }
  | { readonly id: string; readonly kind: 'collection'; readonly semanticPrefix: string }
  | { readonly id: string; readonly kind: 'document' }
  | { readonly id: string; readonly kind: 'secret-safety'; readonly semanticPrefix: string }

export type InteractionMetricField =
  | 'visible'
  | 'inViewport'
  | 'enabled'
  | 'checked'
  | 'textSha256'
  | 'valueSha256'
  | 'numericValue'
  | 'rectLeft'
  | 'rectRight'
  | 'attribute'
  | 'visibleCount'
  | 'idDigest'
  | 'stateDigest'
  | 'innerWidth'
  | 'scrollWidth'
  | 'noHorizontalOverflow'
  | 'safe'

export interface InteractionMetric {
  readonly stage: 'initial' | 'final'
  readonly capture: string
  readonly field: InteractionMetricField
  readonly attribute?: string
}

export type InteractionComparison = 'equals' | 'notEquals' | 'greaterThan' | 'lessThan' | 'atLeast' | 'atMost'
export type InteractionAssertion =
  | {
      readonly id: string
      readonly kind: 'compare'
      readonly comparison: InteractionComparison
      readonly left: InteractionMetric
      readonly right: InteractionMetric | { readonly literal: string | number | boolean }
    }
  | {
      readonly id: string
      readonly kind: 'collectionAllAttributeEquals'
      readonly stage: 'initial' | 'final'
      readonly capture: string
      readonly attribute: string
      readonly value: string
    }
  | {
      readonly id: string
      readonly kind: 'collectionDistinctAttributeAtLeast'
      readonly stage: 'initial' | 'final'
      readonly capture: string
      readonly attribute: string
      readonly count: number
    }
  | {
      readonly id: string
      readonly kind: 'collectionAttributeCountAtLeast'
      readonly stage: 'initial' | 'final'
      readonly capture: string
      readonly attribute: string
      readonly value: string
      readonly count: number
    }

export interface OpenDesignM1InteractionScenario {
  readonly id: string
  readonly reset: typeof OPEN_DESIGN_M1_INTERACTION_RESET
  readonly actions: readonly InteractionAction[]
  readonly assertions: readonly InteractionAssertion[]
}

export interface OpenDesignM1InteractionVector {
  readonly schemaVersion: typeof OPEN_DESIGN_M1_INTERACTION_SCHEMA_VERSION
  readonly caseId: string
  readonly viewport: { readonly width: 1280; readonly height: 900; readonly deviceScaleFactor: 1 }
  readonly instructions: string
  readonly targets: readonly InteractionTarget[]
  readonly captures: readonly InteractionCapture[]
  readonly initialAssertions: readonly InteractionAssertion[]
  readonly scenarios: readonly OpenDesignM1InteractionScenario[]
}

export interface OpenDesignM1CaseV2 extends OpenDesignM1Case {
  readonly authorityVersion: typeof OPEN_DESIGN_M1_FIXED_CASE_AUTHORITY_VERSION
  readonly interactionVectorSha256: string
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonical(value: unknown): string {
  return JSON.stringify(value)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  }
  return value
}

function sid(caseId: string, token: string): string {
  return `${caseId}.${token}`
}

function prefix(caseId: string, token: string): string {
  return `${caseId}.${token}.`
}

function target(caseId: string, token: string, kind: InteractionTargetKind = 'control', initiallyVisible = true): InteractionTarget {
  return { semanticId: sid(caseId, token), kind, initiallyVisible }
}

function element(caseId: string, id: string, token = id): InteractionCapture {
  return { id, kind: 'element', semanticId: sid(caseId, token) }
}

function collection(caseId: string, id: string, token = id): InteractionCapture {
  return { id, kind: 'collection', semanticPrefix: prefix(caseId, token) }
}

function documentCapture(id = 'document'): InteractionCapture {
  return { id, kind: 'document' }
}

function secretSafety(caseId: string, id: string, token: string): InteractionCapture {
  return { id, kind: 'secret-safety', semanticPrefix: token ? prefix(caseId, token) : `${caseId}.` }
}

function metric(
  stage: InteractionMetric['stage'],
  capture: string,
  field: InteractionMetricField,
  attribute?: string,
): InteractionMetric {
  return { stage, capture, field, ...(attribute ? { attribute } : {}) }
}

function compare(
  id: string,
  comparison: InteractionComparison,
  left: InteractionMetric,
  right: InteractionMetric | string | number | boolean,
): InteractionAssertion {
  return {
    id,
    kind: 'compare',
    comparison,
    left,
    right: typeof right === 'object' ? right : { literal: right },
  }
}

function allAttribute(id: string, stage: 'initial' | 'final', capture: string, attribute: string, value: string): InteractionAssertion {
  return { id, kind: 'collectionAllAttributeEquals', stage, capture, attribute, value }
}

function distinctAtLeast(id: string, stage: 'initial' | 'final', capture: string, attribute: string, count: number): InteractionAssertion {
  return { id, kind: 'collectionDistinctAttributeAtLeast', stage, capture, attribute, count }
}

function attributeCountAtLeast(
  id: string,
  stage: 'initial' | 'final',
  capture: string,
  attribute: string,
  value: string,
  count: number,
): InteractionAssertion {
  return { id, kind: 'collectionAttributeCountAtLeast', stage, capture, attribute, value, count }
}

function click(caseId: string, token: string): InteractionAction {
  return { kind: 'pointerClick', target: sid(caseId, token) }
}

function replaceText(caseId: string, token: string, text: string): InteractionAction {
  return { kind: 'replaceText', target: sid(caseId, token), text }
}

function pressKeys(caseId: string, token: string, keys: readonly string[]): InteractionAction {
  return { kind: 'pressKeys', target: sid(caseId, token), keys }
}

function viewport(width: number, height: number): InteractionAction {
  return { kind: 'setViewport', width, height }
}

function scenario(
  id: string,
  actions: readonly InteractionAction[],
  assertions: readonly InteractionAssertion[],
): OpenDesignM1InteractionScenario {
  return { id, reset: OPEN_DESIGN_M1_INTERACTION_RESET, actions, assertions }
}

function vector(
  caseId: string,
  instructions: string,
  targets: readonly InteractionTarget[],
  captures: readonly InteractionCapture[],
  initialAssertions: readonly InteractionAssertion[],
  scenarios: readonly OpenDesignM1InteractionScenario[],
): OpenDesignM1InteractionVector {
  return {
    schemaVersion: 2,
    caseId,
    viewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
    instructions,
    targets,
    captures,
    initialAssertions,
    scenarios,
  }
}

const VECTORS: readonly OpenDesignM1InteractionVector[] = [
  vector('D01',
    'KPI 使用 kpi.*；订单行使用 row.1..row.8+，每行提供 data-m1-status 与 data-m1-entity-id；退款筛选为 refunded-filter；抽屉为 drawer，并同步 data-m1-state=open|closed 与所选 data-m1-entity-id；关闭按钮为 drawer-close。',
    [target('D01', 'refunded-filter'), target('D01', 'row.2'), target('D01', 'drawer', 'observation', false), target('D01', 'drawer-close', 'control', false)],
    [collection('D01', 'kpis', 'kpi'), collection('D01', 'rows', 'row'), element('D01', 'filter', 'refunded-filter'), element('D01', 'drawer'), element('D01', 'row2', 'row.2')],
    [compare('kpi-cardinality', 'atLeast', metric('initial', 'kpis', 'visibleCount'), 3), compare('row-cardinality', 'atLeast', metric('initial', 'rows', 'visibleCount'), 8)],
    [
      scenario('refunded-filter', [click('D01', 'refunded-filter')], [
        compare('rows-reduced', 'lessThan', metric('final', 'rows', 'visibleCount'), metric('initial', 'rows', 'visibleCount')),
        allAttribute('rows-all-refunded', 'final', 'rows', 'data-m1-status', 'refunded'),
        compare('filter-active', 'equals', metric('final', 'filter', 'attribute', 'aria-pressed'), 'true'),
      ]),
      scenario('open-matching-drawer', [click('D01', 'row.2')], [
        compare('drawer-open', 'equals', metric('final', 'drawer', 'attribute', 'data-m1-state'), 'open'),
        compare('drawer-entity-matches', 'equals', metric('final', 'drawer', 'attribute', 'data-m1-entity-id'), metric('final', 'row2', 'attribute', 'data-m1-entity-id')),
      ]),
      scenario('close-drawer', [click('D01', 'row.2'), click('D01', 'drawer-close')], [
        compare('drawer-closed', 'equals', metric('final', 'drawer', 'attribute', 'data-m1-state'), 'closed'),
      ]),
    ]),
  vector('D02',
    '套餐使用 plan.*，交易使用 transaction.*；时间范围按钮 range-30d/range-90d；趋势容器 trend 提供 data-m1-range 与随数据变化的 data-m1-signature。',
    [target('D02', 'range-30d'), target('D02', 'range-90d'), target('D02', 'trend', 'observation')],
    [collection('D02', 'plans', 'plan'), collection('D02', 'transactions', 'transaction'), element('D02', 'trend')],
    [compare('plan-cardinality', 'atLeast', metric('initial', 'plans', 'visibleCount'), 3), compare('transaction-cardinality', 'atLeast', metric('initial', 'transactions', 'visibleCount'), 5), compare('initial-range-30d', 'equals', metric('initial', 'trend', 'attribute', 'data-m1-range'), '30d')],
    [
      scenario('select-90d', [click('D02', 'range-90d')], [
        compare('range-is-90d', 'equals', metric('final', 'trend', 'attribute', 'data-m1-range'), '90d'),
        compare('series-changed', 'notEquals', metric('final', 'trend', 'attribute', 'data-m1-signature'), metric('initial', 'trend', 'attribute', 'data-m1-signature')),
      ]),
      scenario('restore-30d', [click('D02', 'range-90d'), click('D02', 'range-30d')], [
        compare('range-restored', 'equals', metric('final', 'trend', 'attribute', 'data-m1-range'), '30d'),
        compare('series-restored', 'equals', metric('final', 'trend', 'attribute', 'data-m1-signature'), metric('initial', 'trend', 'attribute', 'data-m1-signature')),
      ]),
    ]),
  vector('D03',
    '工单使用 ticket.*，每项提供 data-m1-risk=risk|safe；SLA 风险筛选为 risk-filter。初始至少 2 个 risk 和 2 个 safe。',
    [target('D03', 'risk-filter')],
    [collection('D03', 'tickets', 'ticket'), element('D03', 'riskFilter', 'risk-filter')],
    [compare('ticket-cardinality', 'atLeast', metric('initial', 'tickets', 'visibleCount'), 6), attributeCountAtLeast('risk-cardinality', 'initial', 'tickets', 'data-m1-risk', 'risk', 2), attributeCountAtLeast('safe-cardinality', 'initial', 'tickets', 'data-m1-risk', 'safe', 2)],
    [scenario('filter-risk', [click('D03', 'risk-filter')], [
      compare('tickets-reduced', 'lessThan', metric('final', 'tickets', 'visibleCount'), metric('initial', 'tickets', 'visibleCount')),
      allAttribute('tickets-all-risk', 'final', 'tickets', 'data-m1-risk', 'risk'),
    ])]),
  vector('D04',
    '里程碑使用 milestone.*；项目卡使用 project.* 并有 data-m1-entity-id；第二张卡的开关为 project.2，详情为 project-details，提供 data-m1-state 与匹配 entity id。',
    [target('D04', 'project.2'), target('D04', 'project-details', 'observation', false)],
    [collection('D04', 'milestones', 'milestone'), collection('D04', 'projects', 'project'), element('D04', 'project2', 'project.2'), element('D04', 'details', 'project-details')],
    [compare('milestone-cardinality', 'atLeast', metric('initial', 'milestones', 'visibleCount'), 3), compare('project-cardinality', 'atLeast', metric('initial', 'projects', 'visibleCount'), 4)],
    [
      scenario('open-project', [click('D04', 'project.2')], [compare('details-open', 'equals', metric('final', 'details', 'attribute', 'data-m1-state'), 'open'), compare('details-match', 'equals', metric('final', 'details', 'attribute', 'data-m1-entity-id'), metric('final', 'project2', 'attribute', 'data-m1-entity-id'))]),
      scenario('close-project', [click('D04', 'project.2'), click('D04', 'project.2')], [compare('details-closed', 'equals', metric('final', 'details', 'attribute', 'data-m1-state'), 'closed')]),
    ]),
  vector('L01',
    '定价卡使用 pricing.*，FAQ 使用 faq.*；第一项开关 faq.1，回答 faq-answer.1；首屏 CTA 为 primary-cta。所有语义节点在 390px viewport 下边界不得越出视口。',
    [target('L01', 'faq.1'), target('L01', 'faq-answer.1', 'observation', false), target('L01', 'pricing.1', 'observation'), target('L01', 'primary-cta', 'observation')],
    [collection('L01', 'pricing'), collection('L01', 'faqs', 'faq'), element('L01', 'faq1', 'faq.1'), element('L01', 'answer1', 'faq-answer.1'), element('L01', 'pricing1', 'pricing.1'), element('L01', 'primaryCta', 'primary-cta'), documentCapture()],
    [compare('pricing-exactly-three', 'equals', metric('initial', 'pricing', 'visibleCount'), 3), compare('faq-cardinality', 'atLeast', metric('initial', 'faqs', 'visibleCount'), 3)],
    [
      scenario('faq-toggle', [click('L01', 'faq.1')], [compare('faq-expanded', 'equals', metric('final', 'faq1', 'attribute', 'aria-expanded'), 'true'), compare('answer-visible', 'equals', metric('final', 'answer1', 'visible'), true)]),
      scenario('narrow-viewport', [viewport(390, 844)], [
        compare('viewport-width', 'equals', metric('final', 'document', 'innerWidth'), 390),
        compare('no-horizontal-overflow', 'equals', metric('final', 'document', 'noHorizontalOverflow'), true),
        compare('cta-left-in-viewport', 'atLeast', metric('final', 'primaryCta', 'rectLeft'), 0),
        compare('cta-right-in-viewport', 'atMost', metric('final', 'primaryCta', 'rectRight'), metric('final', 'document', 'innerWidth')),
        compare('pricing-left-in-viewport', 'atLeast', metric('final', 'pricing1', 'rectLeft'), 0),
        compare('pricing-right-in-viewport', 'atMost', metric('final', 'pricing1', 'rectRight'), metric('final', 'document', 'innerWidth')),
        compare('faq-left-in-viewport', 'atLeast', metric('final', 'faq1', 'rectLeft'), 0),
        compare('faq-right-in-viewport', 'atMost', metric('final', 'faq1', 'rectRight'), metric('final', 'document', 'innerWidth')),
      ]),
    ]),
  vector('L02',
    '商品使用 product.* 并有 data-m1-category/data-m1-entity-id；商品 1 收藏按钮 favorite.1、加购按钮 quick-add.1；购物袋 cart 提供 data-m1-count；反馈 feedback 提供 entity id；running 筛选为 category-running。',
    [target('L02', 'favorite.1'), target('L02', 'quick-add.1'), target('L02', 'category-running'), target('L02', 'cart', 'observation'), target('L02', 'feedback', 'observation', false)],
    [collection('L02', 'products', 'product'), element('L02', 'favorite1', 'favorite.1'), element('L02', 'product1', 'product.1'), element('L02', 'cart'), element('L02', 'feedback')],
    [compare('product-cardinality', 'atLeast', metric('initial', 'products', 'visibleCount'), 8), distinctAtLeast('category-cardinality', 'initial', 'products', 'data-m1-category', 2)],
    [
      scenario('favorite-product', [click('L02', 'favorite.1')], [compare('favorite-pressed', 'equals', metric('final', 'favorite1', 'attribute', 'aria-pressed'), 'true'), compare('product-favorited', 'equals', metric('final', 'product1', 'attribute', 'data-m1-state'), 'favorite')]),
      scenario('quick-add', [click('L02', 'quick-add.1')], [compare('cart-incremented', 'greaterThan', metric('final', 'cart', 'attribute', 'data-m1-count'), metric('initial', 'cart', 'attribute', 'data-m1-count')), compare('feedback-matches-product', 'equals', metric('final', 'feedback', 'attribute', 'data-m1-entity-id'), metric('final', 'product1', 'attribute', 'data-m1-entity-id'))]),
      scenario('running-filter', [click('L02', 'category-running')], [compare('products-reduced', 'lessThan', metric('final', 'products', 'visibleCount'), metric('initial', 'products', 'visibleCount')), allAttribute('products-all-running', 'final', 'products', 'data-m1-category', 'running')]),
    ]),
  vector('L03',
    '预约预设按钮为 party-4、date-next-friday、time-1900，提交为 reservation-submit；表单状态 reservation-state 提供 party/date/time 语义值；确认 confirmation 提供相同值与 data-m1-state=confirmed。',
    [target('L03', 'party-4'), target('L03', 'date-next-friday'), target('L03', 'time-1900'), target('L03', 'reservation-submit'), target('L03', 'reservation-state', 'observation'), target('L03', 'confirmation', 'observation', false)],
    [element('L03', 'reservation', 'reservation-state'), element('L03', 'confirmation')],
    [],
    [scenario('submit-reservation', [click('L03', 'party-4'), click('L03', 'date-next-friday'), click('L03', 'time-1900'), click('L03', 'reservation-submit')], [
      compare('confirmation-visible', 'equals', metric('final', 'confirmation', 'visible'), true),
      compare('confirmation-state', 'equals', metric('final', 'confirmation', 'attribute', 'data-m1-state'), 'confirmed'),
      compare('party-matches', 'equals', metric('final', 'confirmation', 'attribute', 'data-m1-party'), metric('final', 'reservation', 'attribute', 'data-m1-party')),
      compare('date-matches', 'equals', metric('final', 'confirmation', 'attribute', 'data-m1-date'), metric('final', 'reservation', 'attribute', 'data-m1-date')),
      compare('time-matches', 'equals', metric('final', 'confirmation', 'attribute', 'data-m1-time'), metric('final', 'reservation', 'attribute', 'data-m1-time')),
      compare('party-four', 'equals', metric('final', 'reservation', 'attribute', 'data-m1-party'), '4'),
      compare('date-next-friday', 'equals', metric('final', 'reservation', 'attribute', 'data-m1-date'), 'next-friday'),
      compare('time-1900', 'equals', metric('final', 'reservation', 'attribute', 'data-m1-time'), '19:00'),
    ])]),
  vector('L04',
    '讲者使用 speaker.*，议程使用 agenda.* 并提供 data-m1-day 与 data-m1-signature；日期按钮 day-1/day-2；议程容器 agenda-state 提供当前 day 与 signature。',
    [target('L04', 'day-1'), target('L04', 'day-2'), target('L04', 'agenda-state', 'observation')],
    [collection('L04', 'speakers', 'speaker'), collection('L04', 'agenda'), element('L04', 'agendaState', 'agenda-state')],
    [compare('speaker-cardinality', 'atLeast', metric('initial', 'speakers', 'visibleCount'), 4), compare('agenda-cardinality', 'atLeast', metric('initial', 'agenda', 'visibleCount'), 3), compare('initial-day-one', 'equals', metric('initial', 'agendaState', 'attribute', 'data-m1-day'), '1')],
    [
      scenario('select-day-two', [click('L04', 'day-2')], [allAttribute('agenda-all-day-two', 'final', 'agenda', 'data-m1-day', '2'), compare('day-two-selected', 'equals', metric('final', 'agendaState', 'attribute', 'data-m1-day'), '2'), compare('agenda-changed', 'notEquals', metric('final', 'agenda', 'stateDigest'), metric('initial', 'agenda', 'stateDigest'))]),
      scenario('restore-day-one', [click('L04', 'day-2'), click('L04', 'day-1')], [allAttribute('agenda-all-day-one', 'final', 'agenda', 'data-m1-day', '1'), compare('day-one-restored', 'equals', metric('final', 'agendaState', 'attribute', 'data-m1-day'), '1'), compare('agenda-restored', 'equals', metric('final', 'agenda', 'stateDigest'), metric('initial', 'agenda', 'stateDigest'))]),
    ]),
  vector('E01',
    '便签使用 sticky.* 并有 entity id；第二张为 sticky.2；选择状态 selection 与属性面板 property-panel 同步 selected id/signature；放大为 zoom-in，画布 canvas-state 提供 numeric data-m1-zoom，zoom-value 的 data-m1-value 同步。',
    [target('E01', 'sticky.2'), target('E01', 'zoom-in'), target('E01', 'selection', 'observation'), target('E01', 'property-panel', 'observation'), target('E01', 'canvas-state', 'observation'), target('E01', 'zoom-value', 'observation')],
    [collection('E01', 'stickies', 'sticky'), element('E01', 'sticky2', 'sticky.2'), element('E01', 'selection'), element('E01', 'property', 'property-panel'), element('E01', 'canvas', 'canvas-state'), element('E01', 'zoomValue', 'zoom-value')],
    [compare('sticky-cardinality', 'equals', metric('initial', 'stickies', 'visibleCount'), 3)],
    [
      scenario('select-sticky', [click('E01', 'sticky.2')], [compare('selection-matches', 'equals', metric('final', 'selection', 'attribute', 'data-m1-selected-id'), metric('final', 'sticky2', 'attribute', 'data-m1-entity-id')), compare('property-matches', 'equals', metric('final', 'property', 'attribute', 'data-m1-selected-id'), metric('final', 'sticky2', 'attribute', 'data-m1-entity-id')), compare('property-changed', 'notEquals', metric('final', 'property', 'attribute', 'data-m1-signature'), metric('initial', 'property', 'attribute', 'data-m1-signature'))]),
      scenario('zoom-in', [click('E01', 'zoom-in')], [compare('zoom-increased', 'greaterThan', metric('final', 'canvas', 'attribute', 'data-m1-zoom'), metric('initial', 'canvas', 'attribute', 'data-m1-zoom')), compare('zoom-value-matches', 'equals', metric('final', 'canvas', 'attribute', 'data-m1-zoom'), metric('final', 'zoomValue', 'attribute', 'data-m1-value'))]),
    ]),
  vector('E02',
    '亮度 range 为 brightness；画布 canvas-state 提供 data-m1-brightness/data-m1-filter/data-m1-signature/data-m1-view/data-m1-rotation；前后对比 before-after；旋转 rotate-90。',
    [target('E02', 'brightness', 'range'), target('E02', 'before-after'), target('E02', 'rotate-90'), target('E02', 'canvas-state', 'observation')],
    [element('E02', 'brightness'), element('E02', 'beforeAfter', 'before-after'), element('E02', 'canvas', 'canvas-state')],
    [],
    [
      scenario('brightness', [pressKeys('E02', 'brightness', ['ArrowRight', 'ArrowRight', 'ArrowRight'])], [compare('brightness-increased', 'greaterThan', metric('final', 'brightness', 'numericValue'), metric('initial', 'brightness', 'numericValue')), compare('canvas-brightness-increased', 'greaterThan', metric('final', 'canvas', 'attribute', 'data-m1-brightness'), metric('initial', 'canvas', 'attribute', 'data-m1-brightness')), compare('canvas-filter-changed', 'notEquals', metric('final', 'canvas', 'attribute', 'data-m1-filter'), metric('initial', 'canvas', 'attribute', 'data-m1-filter'))]),
      scenario('before-after', [click('E02', 'before-after')], [compare('toggle-pressed', 'equals', metric('final', 'beforeAfter', 'attribute', 'aria-pressed'), 'true'), compare('view-before', 'equals', metric('final', 'canvas', 'attribute', 'data-m1-view'), 'before'), compare('signature-changed', 'notEquals', metric('final', 'canvas', 'attribute', 'data-m1-signature'), metric('initial', 'canvas', 'attribute', 'data-m1-signature'))]),
      scenario('rotate', [click('E02', 'rotate-90')], [compare('rotation-90', 'equals', metric('final', 'canvas', 'attribute', 'data-m1-rotation'), '90'), compare('rotation-changed', 'notEquals', metric('final', 'canvas', 'attribute', 'data-m1-rotation'), metric('initial', 'canvas', 'attribute', 'data-m1-rotation'))]),
    ]),
  vector('E03',
    '组件 component.1 有 entity id；属性面板 property-panel 同步 selected id；mobile 按钮 device-mobile；画布 canvas-state 提供 viewport/width；文本编辑器 text-editor；可见标题 heading。',
    [target('E03', 'component.1'), target('E03', 'device-mobile'), target('E03', 'text-editor', 'input'), target('E03', 'property-panel', 'observation'), target('E03', 'canvas-state', 'observation'), target('E03', 'heading', 'observation')],
    [element('E03', 'component1', 'component.1'), element('E03', 'property', 'property-panel'), element('E03', 'mobile', 'device-mobile'), element('E03', 'canvas', 'canvas-state'), element('E03', 'editor', 'text-editor'), element('E03', 'heading'), documentCapture()],
    [],
    [
      scenario('select-component', [click('E03', 'component.1')], [compare('panel-selection-matches', 'equals', metric('final', 'property', 'attribute', 'data-m1-selected-id'), metric('final', 'component1', 'attribute', 'data-m1-entity-id'))]),
      scenario('mobile-viewport', [click('E03', 'device-mobile')], [compare('mobile-pressed', 'equals', metric('final', 'mobile', 'attribute', 'aria-pressed'), 'true'), compare('canvas-mobile', 'equals', metric('final', 'canvas', 'attribute', 'data-m1-viewport'), 'mobile'), compare('canvas-width', 'atMost', metric('final', 'canvas', 'attribute', 'data-m1-width'), 430), compare('no-overflow', 'equals', metric('final', 'document', 'noHorizontalOverflow'), true)]),
      scenario('replace-heading', [replaceText('E03', 'text-editor', 'M1 updated heading')], [compare('editor-value', 'equals', metric('final', 'editor', 'valueSha256'), sha256('M1 updated heading')), compare('heading-text', 'equals', metric('final', 'heading', 'textSha256'), sha256('M1 updated heading'))]),
    ]),
  vector('E04',
    '条件节点 condition-node 有 entity id；属性面板 property-panel 同步 selected id；启用开关 enable；状态 flow-state；模拟运行 simulate-run；日志 log.* 并以 data-m1-status 标记。',
    [target('E04', 'condition-node'), target('E04', 'enable'), target('E04', 'simulate-run'), target('E04', 'property-panel', 'observation'), target('E04', 'flow-state', 'observation')],
    [element('E04', 'condition', 'condition-node'), element('E04', 'property', 'property-panel'), element('E04', 'enable'), element('E04', 'flow', 'flow-state'), collection('E04', 'logs', 'log')],
    [],
    [
      scenario('select-condition', [click('E04', 'condition-node')], [compare('panel-selection-matches', 'equals', metric('final', 'property', 'attribute', 'data-m1-selected-id'), metric('final', 'condition', 'attribute', 'data-m1-entity-id'))]),
      scenario('enable-flow', [click('E04', 'enable')], [compare('enable-checked', 'equals', metric('final', 'enable', 'checked'), true), compare('flow-enabled', 'equals', metric('final', 'flow', 'attribute', 'data-m1-status'), 'enabled')]),
      scenario('simulate-run', [click('E04', 'simulate-run')], [compare('log-added', 'greaterThan', metric('final', 'logs', 'visibleCount'), metric('initial', 'logs', 'visibleCount')), allAttribute('logs-completed', 'final', 'logs', 'data-m1-status', 'completed'), compare('flow-completed', 'equals', metric('final', 'flow', 'attribute', 'data-m1-result'), 'completed')]),
    ]),
  vector('S01',
    '成员使用 member.*，带 role/entity id；admin 筛选 role-admin；邀请 invite-open、invite-email、invite-submit，验证 invite-validation，成功 invite-confirmation；选择 select.1/select.2；批量状态 batch-state 提供 count。',
    [target('S01', 'role-admin'), target('S01', 'invite-open'), target('S01', 'invite-email', 'input', false), target('S01', 'invite-submit', 'control', false), target('S01', 'invite-validation', 'observation', false), target('S01', 'invite-confirmation', 'observation', false), target('S01', 'select.1'), target('S01', 'select.2'), target('S01', 'batch-state', 'observation')],
    [collection('S01', 'members', 'member'), element('S01', 'email', 'invite-email'), element('S01', 'validation', 'invite-validation'), element('S01', 'confirmation', 'invite-confirmation'), element('S01', 'batch', 'batch-state')],
    [],
    [
      scenario('filter-admin', [click('S01', 'role-admin')], [compare('members-reduced', 'lessThan', metric('final', 'members', 'visibleCount'), metric('initial', 'members', 'visibleCount')), allAttribute('members-all-admin', 'final', 'members', 'data-m1-role', 'admin')]),
      scenario('invite-empty-validation', [click('S01', 'invite-open'), click('S01', 'invite-submit')], [compare('validation-visible', 'equals', metric('final', 'validation', 'visible'), true), compare('validation-invalid', 'equals', metric('final', 'validation', 'attribute', 'data-m1-state'), 'invalid')]),
      scenario('invite-success', [click('S01', 'invite-open'), replaceText('S01', 'invite-email', 'm1.acceptance@example.test'), click('S01', 'invite-submit')], [compare('email-value', 'equals', metric('final', 'email', 'valueSha256'), sha256('m1.acceptance@example.test')), compare('confirmation-visible', 'equals', metric('final', 'confirmation', 'visible'), true), compare('confirmation-success', 'equals', metric('final', 'confirmation', 'attribute', 'data-m1-state'), 'success')]),
      scenario('batch-select-two', [click('S01', 'select.1'), click('S01', 'select.2')], [compare('batch-count-two', 'equals', metric('final', 'batch', 'attribute', 'data-m1-count'), '2')]),
    ]),
  vector('S02',
    '发票 invoice.* 有 entity id；第一张下载 invoice-download.1；反馈 download-feedback 匹配 entity id；升级 upgrade-open/upgrade-close；对话框 upgrade-dialog；套餐 upgrade-plan.* 有不同 data-m1-plan。',
    [target('S02', 'invoice-download.1'), target('S02', 'download-feedback', 'observation', false), target('S02', 'upgrade-open'), target('S02', 'upgrade-close', 'control', false), target('S02', 'upgrade-dialog', 'observation', false)],
    [element('S02', 'invoice1', 'invoice.1'), element('S02', 'feedback', 'download-feedback'), element('S02', 'dialog', 'upgrade-dialog'), collection('S02', 'upgradePlans', 'upgrade-plan')],
    [],
    [
      scenario('download-invoice', [click('S02', 'invoice-download.1')], [compare('download-feedback-visible', 'equals', metric('final', 'feedback', 'visible'), true), compare('download-matches', 'equals', metric('final', 'feedback', 'attribute', 'data-m1-entity-id'), metric('final', 'invoice1', 'attribute', 'data-m1-entity-id'))]),
      scenario('upgrade-plans', [click('S02', 'upgrade-open')], [compare('upgrade-dialog-visible', 'equals', metric('final', 'dialog', 'visible'), true), compare('upgrade-plan-cardinality', 'atLeast', metric('final', 'upgradePlans', 'visibleCount'), 2), distinctAtLeast('upgrade-plans-distinct', 'final', 'upgradePlans', 'data-m1-plan', 2)]),
      scenario('close-upgrade', [click('S02', 'upgrade-open'), click('S02', 'upgrade-close')], [compare('upgrade-dialog-closed', 'equals', metric('final', 'dialog', 'visible'), false)]),
    ]),
  vector('S03',
    'API key 行 key.* 只显示合成脱敏值，带 scope/entity id/status；read 筛选 scope-read；创建 create-open/create-confirm；一次性提示 one-time-secret 仅暴露 data-m1-secret-present=true 与 digest，不放原文属性；撤销 revoke.1/revoke-confirm。',
    [target('S03', 'scope-read'), target('S03', 'create-open'), target('S03', 'create-confirm', 'control', false), target('S03', 'one-time-secret', 'observation', false), target('S03', 'revoke.1'), target('S03', 'revoke-confirm', 'control', false)],
    [collection('S03', 'keys', 'key'), element('S03', 'oneTime', 'one-time-secret'), element('S03', 'key1', 'key.1'), secretSafety('S03', 'secretSafety', '')],
    [compare('synthetic-secret-safe', 'equals', metric('initial', 'secretSafety', 'safe'), true)],
    [
      scenario('filter-read', [click('S03', 'scope-read')], [compare('keys-reduced', 'lessThan', metric('final', 'keys', 'visibleCount'), metric('initial', 'keys', 'visibleCount')), allAttribute('keys-all-read', 'final', 'keys', 'data-m1-scope', 'read')]),
      scenario('create-key', [click('S03', 'create-open'), click('S03', 'create-confirm')], [compare('one-time-visible', 'equals', metric('final', 'oneTime', 'visible'), true), compare('secret-present', 'equals', metric('final', 'oneTime', 'attribute', 'data-m1-secret-present'), 'true'), compare('still-secret-safe', 'equals', metric('final', 'secretSafety', 'safe'), true)]),
      scenario('revoke-key', [click('S03', 'revoke.1'), click('S03', 'revoke-confirm')], [compare('key-revoked', 'equals', metric('final', 'key1', 'attribute', 'data-m1-status'), 'revoked')]),
    ]),
  vector('S04',
    '审计行 audit.* 有 event/entity id；事件筛选 event-security；第一行 audit.1；详情 audit-details 匹配 entity id；下一页 next-page；分页 page-state 提供 page/signature；表格 table-state 提供 data-m1-total>=12；导出 export 与 export-feedback=ready。',
    [target('S04', 'event-security'), target('S04', 'audit.1'), target('S04', 'next-page'), target('S04', 'export'), target('S04', 'audit-details', 'observation', false), target('S04', 'page-state', 'observation'), target('S04', 'table-state', 'observation'), target('S04', 'export-feedback', 'observation', false)],
    [collection('S04', 'audits', 'audit'), element('S04', 'audit1', 'audit.1'), element('S04', 'details', 'audit-details'), element('S04', 'page', 'page-state'), element('S04', 'table', 'table-state'), element('S04', 'exportFeedback', 'export-feedback')],
    [compare('visible-page-cardinality', 'atLeast', metric('initial', 'audits', 'visibleCount'), 6), compare('total-cardinality', 'atLeast', metric('initial', 'table', 'attribute', 'data-m1-total'), 12)],
    [
      scenario('filter-event', [click('S04', 'event-security')], [compare('audits-reduced', 'lessThan', metric('final', 'audits', 'visibleCount'), metric('initial', 'audits', 'visibleCount')), allAttribute('audits-all-security', 'final', 'audits', 'data-m1-event', 'security')]),
      scenario('open-detail', [click('S04', 'audit.1')], [compare('detail-visible', 'equals', metric('final', 'details', 'visible'), true), compare('detail-matches', 'equals', metric('final', 'details', 'attribute', 'data-m1-entity-id'), metric('final', 'audit1', 'attribute', 'data-m1-entity-id'))]),
      scenario('next-page', [click('S04', 'next-page')], [compare('page-incremented', 'greaterThan', metric('final', 'page', 'attribute', 'data-m1-page'), metric('initial', 'page', 'attribute', 'data-m1-page')), compare('page-digest-changed', 'notEquals', metric('final', 'page', 'attribute', 'data-m1-signature'), metric('initial', 'page', 'attribute', 'data-m1-signature'))]),
      scenario('export', [click('S04', 'export')], [compare('export-ready', 'equals', metric('final', 'exportFeedback', 'attribute', 'data-m1-state'), 'ready')]),
    ]),
  vector('F01',
    '保留 KPI kpi.* 与订单 row.*；退款筛选 refunded-filter；row.2 打开 drawer，drawer 同步 entity id/state，并提供 data-m1-side=right。蓝紫主题只用于 H2 静态视觉，不作为 machine self-report。',
    [target('F01', 'refunded-filter'), target('F01', 'row.2'), target('F01', 'drawer', 'observation', false)],
    [collection('F01', 'kpis', 'kpi'), collection('F01', 'rows', 'row'), element('F01', 'row2', 'row.2'), element('F01', 'drawer'), documentCapture()],
    [compare('kpi-preserved', 'atLeast', metric('initial', 'kpis', 'visibleCount'), 3), compare('rows-preserved', 'atLeast', metric('initial', 'rows', 'visibleCount'), 8)],
    [
      scenario('refunded-filter', [click('F01', 'refunded-filter')], [compare('rows-reduced', 'lessThan', metric('final', 'rows', 'visibleCount'), metric('initial', 'rows', 'visibleCount')), allAttribute('rows-all-refunded', 'final', 'rows', 'data-m1-status', 'refunded')]),
      scenario('matching-drawer', [click('F01', 'row.2')], [
        compare('drawer-visible', 'equals', metric('final', 'drawer', 'visible'), true),
        compare('drawer-in-viewport', 'equals', metric('final', 'drawer', 'inViewport'), true),
        compare('drawer-open', 'equals', metric('final', 'drawer', 'attribute', 'data-m1-state'), 'open'),
        compare('drawer-right-side', 'equals', metric('final', 'drawer', 'attribute', 'data-m1-side'), 'right'),
        compare('drawer-left-bounds', 'atLeast', metric('final', 'drawer', 'rectLeft'), 640),
        compare('drawer-right-bounds', 'atMost', metric('final', 'drawer', 'rectRight'), metric('final', 'document', 'innerWidth')),
        compare('drawer-matches', 'equals', metric('final', 'drawer', 'attribute', 'data-m1-entity-id'), metric('final', 'row2', 'attribute', 'data-m1-entity-id')),
      ]),
    ]),
  vector('F02',
    '保留 pricing.* 与 faq.*；月付/年付按钮 monthly/annual；每个价格提供 data-m1-period/data-m1-price/data-m1-savings；CTA 为 final-cta；FAQ 第一项 faq.1 与 faq-answer.1。',
    [target('F02', 'monthly'), target('F02', 'annual'), target('F02', 'faq.1'), target('F02', 'faq-answer.1', 'observation', false), target('F02', 'final-cta', 'observation')],
    [collection('F02', 'pricing'), collection('F02', 'faqs', 'faq'), element('F02', 'faq1', 'faq.1'), element('F02', 'answer1', 'faq-answer.1'), element('F02', 'cta', 'final-cta')],
    [compare('pricing-exactly-three', 'equals', metric('initial', 'pricing', 'visibleCount'), 3), compare('faq-preserved', 'atLeast', metric('initial', 'faqs', 'visibleCount'), 3), compare('cta-updated', 'equals', metric('initial', 'cta', 'textSha256'), sha256('开始 14 天试用')), allAttribute('initial-monthly', 'initial', 'pricing', 'data-m1-period', 'monthly')],
    [
      scenario('annual-pricing', [click('F02', 'annual')], [allAttribute('annual-period', 'final', 'pricing', 'data-m1-period', 'annual'), allAttribute('annual-savings', 'final', 'pricing', 'data-m1-savings', '20%'), compare('prices-changed', 'notEquals', metric('final', 'pricing', 'stateDigest'), metric('initial', 'pricing', 'stateDigest'))]),
      scenario('faq-toggle', [click('F02', 'faq.1')], [compare('faq-expanded', 'equals', metric('final', 'faq1', 'attribute', 'aria-expanded'), 'true'), compare('answer-visible', 'equals', metric('final', 'answer1', 'visible'), true)]),
    ]),
  vector('F03',
    '保留 sticky.*、sticky.2 与 property-panel；缩放 150 按钮 zoom-150；画布 canvas-state 提供 zoom；minimap 提供 signature；图层 layer.1 与 lock-layer，锁定后 property-editor disabled。',
    [target('F03', 'sticky.2'), target('F03', 'zoom-150'), target('F03', 'layer.1'), target('F03', 'lock-layer'), target('F03', 'property-panel', 'observation'), target('F03', 'canvas-state', 'observation'), target('F03', 'minimap', 'observation'), target('F03', 'property-editor', 'observation')],
    [collection('F03', 'stickies', 'sticky'), element('F03', 'sticky2', 'sticky.2'), element('F03', 'property', 'property-panel'), element('F03', 'canvas', 'canvas-state'), element('F03', 'minimap'), element('F03', 'layer1', 'layer.1'), element('F03', 'propertyEditor', 'property-editor')],
    [compare('sticky-preserved', 'atLeast', metric('initial', 'stickies', 'visibleCount'), 3)],
    [
      scenario('zoom-150', [click('F03', 'zoom-150')], [compare('canvas-zoom-150', 'equals', metric('final', 'canvas', 'attribute', 'data-m1-zoom'), '150'), compare('minimap-changed', 'notEquals', metric('final', 'minimap', 'attribute', 'data-m1-signature'), metric('initial', 'minimap', 'attribute', 'data-m1-signature'))]),
      scenario('lock-layer', [click('F03', 'layer.1'), click('F03', 'lock-layer')], [compare('layer-locked', 'equals', metric('final', 'layer1', 'attribute', 'data-m1-locked'), 'true'), compare('property-disabled', 'equals', metric('final', 'propertyEditor', 'enabled'), false)]),
      scenario('sticky-selection-after-clean-reload', [click('F03', 'sticky.2')], [compare('property-matches-sticky', 'equals', metric('final', 'property', 'attribute', 'data-m1-selected-id'), metric('final', 'sticky2', 'attribute', 'data-m1-entity-id'))]),
    ]),
  vector('F04',
    '保留 audit.*、分页与原筛选 original-filter；original-filter 固定筛选 data-m1-event=login；高风险保存视图 saved-high-risk；行 audit.1；JSON 详情 json-details 仅以 signature/entity id 取证；复制 copy-json 与 copied-feedback；下一页 next-page/page-state。',
    [target('F04', 'saved-high-risk'), target('F04', 'original-filter'), target('F04', 'audit.1'), target('F04', 'copy-json', 'control', false), target('F04', 'next-page'), target('F04', 'json-details', 'observation', false), target('F04', 'copied-feedback', 'observation', false), target('F04', 'page-state', 'observation')],
    [collection('F04', 'audits', 'audit'), element('F04', 'audit1', 'audit.1'), element('F04', 'details', 'json-details'), element('F04', 'copied', 'copied-feedback'), element('F04', 'page', 'page-state')],
    [compare('audit-preserved', 'atLeast', metric('initial', 'audits', 'visibleCount'), 12)],
    [
      scenario('saved-high-risk', [click('F04', 'saved-high-risk')], [compare('audits-reduced', 'lessThan', metric('final', 'audits', 'visibleCount'), metric('initial', 'audits', 'visibleCount')), allAttribute('audits-all-high-risk', 'final', 'audits', 'data-m1-risk', 'high')]),
      scenario('matching-json-detail', [click('F04', 'audit.1')], [compare('details-visible', 'equals', metric('final', 'details', 'visible'), true), compare('details-match', 'equals', metric('final', 'details', 'attribute', 'data-m1-entity-id'), metric('final', 'audit1', 'attribute', 'data-m1-entity-id'))]),
      scenario('copy-feedback', [click('F04', 'audit.1'), click('F04', 'copy-json')], [compare('copy-feedback-visible', 'equals', metric('final', 'copied', 'visible'), true), compare('copy-feedback-state', 'equals', metric('final', 'copied', 'attribute', 'data-m1-state'), 'copied')]),
      scenario('next-page', [click('F04', 'next-page')], [compare('page-incremented', 'greaterThan', metric('final', 'page', 'attribute', 'data-m1-page'), metric('initial', 'page', 'attribute', 'data-m1-page')), compare('page-digest-changed', 'notEquals', metric('final', 'page', 'attribute', 'data-m1-signature'), metric('initial', 'page', 'attribute', 'data-m1-signature'))]),
      scenario('original-filter', [click('F04', 'original-filter')], [compare('original-filter-effective', 'notEquals', metric('final', 'audits', 'stateDigest'), metric('initial', 'audits', 'stateDigest')), allAttribute('original-filter-matches-login', 'final', 'audits', 'data-m1-event', 'login')]),
    ]),
]

export function validateOpenDesignM1InteractionVector(vectorValue: OpenDesignM1InteractionVector): void {
  if (vectorValue.schemaVersion !== 2 || !/^[DLESF][0-9]{2}$/.test(vectorValue.caseId)
    || vectorValue.viewport.width !== 1280 || vectorValue.viewport.height !== 900
    || vectorValue.viewport.deviceScaleFactor !== 1 || vectorValue.instructions.length < 20
    || vectorValue.instructions.length > 2_048) {
    throw new TypeError(`OpenDesign M1 interaction vector is invalid: ${vectorValue.caseId}`)
  }
  const targetIds = new Set<string>()
  for (const value of vectorValue.targets) {
    if (!SAFE_ID.test(value.semanticId) || !value.semanticId.startsWith(`${vectorValue.caseId}.`)
      || targetIds.has(value.semanticId)) throw new TypeError(`OpenDesign M1 interaction target is invalid: ${vectorValue.caseId}`)
    targetIds.add(value.semanticId)
  }
  const captureIds = new Set<string>()
  for (const value of vectorValue.captures) {
    if (!SAFE_ID.test(value.id) || captureIds.has(value.id)) throw new TypeError(`OpenDesign M1 interaction capture is invalid: ${vectorValue.caseId}`)
    captureIds.add(value.id)
    if (value.kind === 'element' && (!SAFE_ID.test(value.semanticId)
      || !value.semanticId.startsWith(`${vectorValue.caseId}.`))) {
      throw new TypeError(`OpenDesign M1 interaction capture target is invalid: ${vectorValue.caseId}.${value.id}`)
    }
    if ((value.kind === 'collection' || value.kind === 'secret-safety')
      && (!value.semanticPrefix.startsWith(`${vectorValue.caseId}.`) || !value.semanticPrefix.endsWith('.'))) {
      throw new TypeError(`OpenDesign M1 interaction capture prefix is invalid: ${vectorValue.caseId}.${value.id}`)
    }
  }
  const scenarioIds = new Set<string>()
  const assertionIds = new Set<string>()
  const validateAssertion = (assertion: InteractionAssertion): void => {
    if (!SAFE_ID.test(assertion.id) || assertionIds.has(assertion.id)) {
      throw new TypeError(`OpenDesign M1 interaction assertion is invalid: ${vectorValue.caseId}`)
    }
    assertionIds.add(assertion.id)
    if (assertion.kind === 'compare') {
      for (const operand of [assertion.left, ...('capture' in assertion.right ? [assertion.right] : [])]) {
        if (!captureIds.has(operand.capture) || (operand.field === 'attribute'
          && (!operand.attribute || !(SAFE_DATA_ATTRIBUTE.test(operand.attribute) || operand.attribute.startsWith('aria-'))))) {
          throw new TypeError(`OpenDesign M1 interaction metric is invalid: ${vectorValue.caseId}.${assertion.id}`)
        }
      }
    } else if (!captureIds.has(assertion.capture) || !SAFE_DATA_ATTRIBUTE.test(assertion.attribute)
      || ('count' in assertion && (!Number.isSafeInteger(assertion.count) || assertion.count < 1))) {
      throw new TypeError(`OpenDesign M1 interaction collection assertion is invalid: ${vectorValue.caseId}.${assertion.id}`)
    }
  }
  for (const assertion of vectorValue.initialAssertions) validateAssertion(assertion)
  for (const value of vectorValue.scenarios) {
    if (!SAFE_ID.test(value.id) || scenarioIds.has(value.id) || value.reset !== OPEN_DESIGN_M1_INTERACTION_RESET
      || value.actions.length < 1 || value.actions.length > 8 || value.assertions.length < 1) {
      throw new TypeError(`OpenDesign M1 interaction scenario is invalid: ${vectorValue.caseId}`)
    }
    scenarioIds.add(value.id)
    for (const action of value.actions) {
      if (action.kind === 'setViewport') {
        if (!Number.isSafeInteger(action.width) || !Number.isSafeInteger(action.height)
          || action.width < 320 || action.width > 2_560 || action.height < 480 || action.height > 1_600) {
          throw new TypeError(`OpenDesign M1 viewport action is invalid: ${vectorValue.caseId}.${value.id}`)
        }
      } else if (!targetIds.has(action.target)) {
        throw new TypeError(`OpenDesign M1 interaction action target is invalid: ${vectorValue.caseId}.${value.id}`)
      }
      if (action.kind === 'replaceText' && (action.text.length < 1 || action.text.length > 256)) {
        throw new TypeError(`OpenDesign M1 replacement text is invalid: ${vectorValue.caseId}.${value.id}`)
      }
      if (action.kind === 'pressKeys' && (action.keys.length < 1 || action.keys.length > 12
        || action.keys.some((key) => !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Space'].includes(key)))) {
        throw new TypeError(`OpenDesign M1 key action is invalid: ${vectorValue.caseId}.${value.id}`)
      }
    }
    for (const assertion of value.assertions) validateAssertion(assertion)
  }
}

for (const interactionVector of VECTORS) validateOpenDesignM1InteractionVector(interactionVector)
if (VECTORS.length !== 20 || new Set(VECTORS.map((value) => value.caseId)).size !== 20) {
  throw new Error('OpenDesign M1 interaction vector inventory is invalid')
}

export const OPEN_DESIGN_M1_INTERACTION_VECTORS = deepFreeze([...VECTORS])

export function openDesignM1InteractionVectorSha256(value: OpenDesignM1InteractionVector): string {
  return sha256(canonical(value))
}

export const OPEN_DESIGN_M1_CASES_V2: readonly OpenDesignM1CaseV2[] = Object.freeze(
  OPEN_DESIGN_M1_CASES.map((baseCase) => {
    const interactionVector = OPEN_DESIGN_M1_INTERACTION_VECTORS.find((candidate) => candidate.caseId === baseCase.id)
    if (!interactionVector) throw new Error(`OpenDesign M1 interaction vector is missing: ${baseCase.id}`)
    const interactionVectorSha256 = openDesignM1InteractionVectorSha256(interactionVector)
    const semanticTargets = interactionVector.targets.map((value) => value.semanticId).join(', ')
    const semanticCollections = interactionVector.captures.flatMap((value) => (
      value.kind === 'collection' || value.kind === 'secret-safety' ? [value.semanticPrefix] : []
    )).join(', ')
    const prompt = `${baseCase.prompt}\nM1 fixed-cases/v2 可重复功能验收要求：把 data-m1-id 语义钩子放在真实渲染内容和真实可操作控件上；禁止 hidden/dummy 镜像或仅为测试自报状态。所有动作目标必须是原生可交互元素，或具有正确 ARIA role 的控件，处于 rendered/enabled 状态，尺寸至少 24x24 CSS px；验收器会先用固定 CDP DOM 目标滚动到视口，再要求中心点可 hit-test，并只用真实 Input.* 输入。集合基数统计整个 document 内的 rendered 成员，不受当前 viewport 影响。状态使用标准 ARIA 与 data-m1-* 属性表达，并与用户可见状态同步。必须提供精确目标：${semanticTargets}。集合成员前缀：${semanticCollections || '无'}。Case 专属要求：${interactionVector.instructions}`
    return Object.freeze({
      ...baseCase,
      authorityVersion: OPEN_DESIGN_M1_FIXED_CASE_AUTHORITY_VERSION,
      prompt,
      interactionVectorSha256,
    })
  }),
)

export function renderOpenDesignM1CaseManifestV2(): string {
  return `${JSON.stringify({
    schemaVersion: OPEN_DESIGN_M1_FIXED_CASE_AUTHORITY_VERSION,
    cases: OPEN_DESIGN_M1_CASES_V2,
    interactionVectors: OPEN_DESIGN_M1_INTERACTION_VECTORS.map((value) => ({
      caseId: value.caseId,
      sha256: openDesignM1InteractionVectorSha256(value),
    })),
  }, null, 2)}\n`
}

export const OPEN_DESIGN_M1_INTERACTION_VECTORS_CANONICAL_SHA256 =
  'aff473ff29b6facb1b927d3379150f42370a6cda17f9754d22eccb6610206c05' as const
export const OPEN_DESIGN_M1_CASE_MANIFEST_V2_SHA256 =
  'd8a4e59c105642272f72faa31eac83e65f1c15c0be551f50c62ef3655fe6513a' as const
if (sha256(canonical(OPEN_DESIGN_M1_INTERACTION_VECTORS)) !== OPEN_DESIGN_M1_INTERACTION_VECTORS_CANONICAL_SHA256
  || sha256(renderOpenDesignM1CaseManifestV2()) !== OPEN_DESIGN_M1_CASE_MANIFEST_V2_SHA256) {
  throw new Error('OpenDesign M1 fixed-cases/v2 authority drifted')
}
export const OPEN_DESIGN_M1_CASE_V2_HASHES = Object.freeze(OPEN_DESIGN_M1_CASES_V2.map((value) => ({
  id: value.id,
  promptSha256: sha256(value.prompt),
  seedArchiveSha256: value.seedArchiveSha256,
  interactionVectorSha256: value.interactionVectorSha256,
})))
