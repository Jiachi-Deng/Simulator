import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSession,
  getSessionFilePath,
  parseModuleAgentRunMetadata,
  type ModuleAgentRunMetadata,
} from '..'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function validMetadata(overrides: Partial<ModuleAgentRunMetadata> = {}): ModuleAgentRunMetadata {
  return {
    transient: true,
    contractVersion: 2,
    moduleId: 'open-design',
    runHandle: `run_${'1'.repeat(32)}`,
    idempotencyKeyDigest: '2'.repeat(64),
    requestDigest: '3'.repeat(64),
    workerEpoch: 'epoch_1234',
    state: 'accepted',
    ...overrides,
  }
}

describe('parseModuleAgentRunMetadata', () => {
  it('accepts only the closed v1/v2 shape and returns a fresh plain object', () => {
    for (const contractVersion of [1, 2] as const) {
      const input = Object.assign(Object.create(null), validMetadata({ contractVersion }))
      const parsed = parseModuleAgentRunMetadata(input)
      expect(parsed).toEqual(validMetadata({ contractVersion }))
      expect(parsed).not.toBe(input)
      expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
    }
  })

  it('rejects unknown/missing fields, unsafe IDs, uppercase digests, and protocol drift', () => {
    expect(() => parseModuleAgentRunMetadata({ ...validMetadata(), extra: true })).toThrow('unknown field')
    const { requestDigest: _requestDigest, ...missing } = validMetadata()
    expect(() => parseModuleAgentRunMetadata(missing)).toThrow('required field is missing')
    expect(() => parseModuleAgentRunMetadata(validMetadata({ moduleId: '../escape' }))).toThrow('route-safe ID')
    expect(() => parseModuleAgentRunMetadata(validMetadata({ runHandle: 'session_deadbeef' }))).toThrow('run handle')
    expect(() => parseModuleAgentRunMetadata(validMetadata({ requestDigest: 'A'.repeat(64) }))).toThrow('lowercase SHA-256')
    expect(() => parseModuleAgentRunMetadata(validMetadata({ state: 'resuming' as never }))).toThrow('run state')
    expect(() => parseModuleAgentRunMetadata({ ...validMetadata(), contractVersion: 3 })).toThrow('1 or 2')
  })

  it('rejects accessors without invoking them', () => {
    let invoked = false
    const input = validMetadata() as unknown as Record<string, unknown>
    Object.defineProperty(input, 'moduleId', {
      enumerable: true,
      get() {
        invoked = true
        return 'open-design'
      },
    })
    expect(() => parseModuleAgentRunMetadata(input)).toThrow('data property')
    expect(invoked).toBe(false)
  })
})

describe('transient Session creation', () => {
  it('persists ownership in the first atomic JSONL header write', async () => {
    const root = mkdtempSync(join(tmpdir(), 'module-agent-run-session-'))
    roots.push(root)
    const moduleAgentRun = validMetadata({ contractVersion: 1 })

    const session = await createSession(root, {
      hidden: true,
      workingDirectory: root,
      moduleAgentRun,
    })

    const firstLine = readFileSync(getSessionFilePath(root, session.id), 'utf8').split('\n')[0]
    expect(firstLine).toBeTruthy()
    const header = JSON.parse(firstLine!) as Record<string, unknown>
    expect(header.moduleAgentRun).toEqual(moduleAgentRun)
    expect(header.messageCount).toBe(0)
  })
})
