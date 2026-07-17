import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OPEN_DESIGN_M1_MACHINE_ARTIFACT_NAME,
  OPEN_DESIGN_M1_MACHINE_FILE_COUNT,
  createDeterministicMachineEvidenceFixture,
  expectedMachineEvidencePaths,
  machineEvidenceTestOnly,
  type MachineEvidenceAuthority,
  validateOpenDesignM1MachineEvidence,
} from './open-design-m1-machine-evidence'
import { OPEN_DESIGN_RC_SOURCE_SHA } from './open-design-rc-acceptance-evidence'
import {
  OPEN_DESIGN_M1_MACHINE_ACCEPTANCE_DESCRIPTOR_CANONICAL_JSON,
  capturePreviewUrlScreenshot,
  preflightExternalBlackoutProxyChild,
  requirePreviewHttp200,
  runFixedFailStopBatch,
  runFixedPaidTurnBatch,
} from './run-open-design-m1-machine-evidence'
import { OPEN_DESIGN_ACCEPTANCE_DESCRIPTOR_CANONICAL_JSON } from '../../apps/electron/src/main/open-design-acceptance'

const roots: string[] = []
const canonical = (value: unknown): string => `${JSON.stringify(value)}\n`
const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const lkgCatalog = { fixture: 'lkg-catalog' }
const lkgEnvelope = { fixture: 'lkg-envelope' }
const rcCatalog = { fixture: 'rc-catalog' }
const rcEnvelope = { fixture: 'rc-envelope' }

const authority: MachineEvidenceAuthority = Object.freeze({
  hostHeadSha: '1234567890abcdef1234567890abcdef12345678',
  producerRunId: 9001,
  producerRunAttempt: 1,
  hostBuildRunId: 8001,
  hostArtifactSha256: 'a'.repeat(64),
  lkg: {
    archiveSha256: 'b'.repeat(64),
    catalogIssuedAt: '2026-07-16T22:00:00.000Z',
    catalogSequence: 2,
    catalogSha256: sha(JSON.stringify(lkgCatalog)),
    envelopeSha256: sha(JSON.stringify(lkgEnvelope)),
    expiresAt: '2026-07-18T22:00:00.000Z',
    extractedManifestSha256: 'c'.repeat(64),
  },
  rc: {
    archiveSha256: 'd'.repeat(64),
    catalogIssuedAt: '2026-07-17T00:00:00.000Z',
    catalogSequence: 3,
    catalogSha256: sha(JSON.stringify(rcCatalog)),
    envelopeSha256: sha(JSON.stringify(rcEnvelope)),
    expiresAt: '2026-07-18T22:00:00.000Z',
    extractedManifestSha256: 'e'.repeat(64),
    sourceSha: OPEN_DESIGN_RC_SOURCE_SHA,
  },
})

async function fixture(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'open-design-m1-machine-test-'))
  roots.push(parent)
  const root = join(parent, 'artifact')
  await createDeterministicMachineEvidenceFixture(root, authority)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('OpenDesign M1 machine evidence producer contract', () => {
  it('seals and validates the exact 150-file authority closure', async () => {
    const root = await fixture()
    expect(expectedMachineEvidencePaths()).toHaveLength(OPEN_DESIGN_M1_MACHINE_FILE_COUNT)
    const result = await validateOpenDesignM1MachineEvidence(root, authority)
    expect(result.artifactName).toBe(OPEN_DESIGN_M1_MACHINE_ARTIFACT_NAME)
    expect(result.fileCount).toBe(150)
    expect(result.objectPath).toBe('machine-manifest.json')
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(result.batchDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects an unknown schema field even after the artifact is resealed', async () => {
    const root = await fixture()
    await machineEvidenceTestOnly.replaceCanonicalJson(root, 'records/old/D01.json', (record) => {
      record.unknown = true
    })
    await machineEvidenceTestOnly.reseal(root)
    await expect(validateOpenDesignM1MachineEvidence(root, authority)).rejects.toThrow('records/old/D01.json')
  })

  it('rejects a blackout ledger containing a business event', async () => {
    const root = await fixture()
    const path = join(root, 'events/new/D01.jsonl')
    const events = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    const heartbeat = events.find((event) => event.type === 'heartbeat')
    heartbeat.business = true
    await writeFile(path, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, { mode: 0o600 })
    await machineEvidenceTestOnly.reseal(root)
    await expect(validateOpenDesignM1MachineEvidence(root, authority)).rejects.toThrow('contains a business event')
  })

  it('rejects a blackout record that did not buffer and replay an upstream event', async () => {
    const root = await fixture()
    await machineEvidenceTestOnly.replaceCanonicalJson(root, 'records/new/D01.json', (record) => {
      const blackout = record.blackout as Record<string, unknown>
      blackout.bufferedEventCount = 0
      blackout.replayedEventCount = 0
    })
    await machineEvidenceTestOnly.reseal(root)
    await expect(validateOpenDesignM1MachineEvidence(root, authority))
      .rejects.toThrow('replayedEventCount')
  })

  it('rejects forged blackout boundaries and non-monotonic event time', async () => {
    const boundaryRoot = await fixture()
    const boundaryPath = join(boundaryRoot, 'events/new/D01.jsonl')
    const boundaryEvents = (await readFile(boundaryPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    boundaryEvents[1].type = 'blackout.not-started'
    await writeFile(boundaryPath, `${boundaryEvents.map((event) => JSON.stringify(event)).join('\n')}\n`, { mode: 0o600 })
    await machineEvidenceTestOnly.reseal(boundaryRoot)
    await expect(validateOpenDesignM1MachineEvidence(boundaryRoot, authority)).rejects.toThrow('exact blackout boundaries')

    const timeRoot = await fixture()
    const timePath = join(timeRoot, 'events/new/D02.jsonl')
    const timeEvents = (await readFile(timePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    timeEvents[3].at = new Date(Date.parse(timeEvents[2].at) - 1).toISOString()
    await writeFile(timePath, `${timeEvents.map((event) => JSON.stringify(event)).join('\n')}\n`, { mode: 0o600 })
    await machineEvidenceTestOnly.reseal(timeRoot)
    await expect(validateOpenDesignM1MachineEvidence(timeRoot, authority)).rejects.toThrow('timestamps are not monotonic')
  })

  it('rejects a missing new-stack heartbeat and non-contiguous sequence', async () => {
    const root = await fixture()
    const path = join(root, 'events/new/D02.jsonl')
    const events = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    events.splice(3, 1)
    await writeFile(path, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, { mode: 0o600 })
    await machineEvidenceTestOnly.reseal(root)
    await expect(validateOpenDesignM1MachineEvidence(root, authority)).rejects.toThrow('sequence')
  })

  it('rejects reordered old/new records even after references and hashes are resealed', async () => {
    const root = await fixture()
    await machineEvidenceTestOnly.replaceCanonicalJson(root, 'machine-manifest.json', (manifest) => {
      const records = manifest.records as unknown[]
      ;[records[0], records[20]] = [records[20], records[0]]
    })
    await machineEvidenceTestOnly.refreshSums(root)
    await expect(validateOpenDesignM1MachineEvidence(root, authority)).rejects.toThrow('$.records[0]')
  })

  it('rejects an extra file, a symlink, and a hard-linked artifact member', async () => {
    const extraRoot = await fixture()
    await writeFile(join(extraRoot, 'extra.json'), '{}\n', { mode: 0o600 })
    await expect(validateOpenDesignM1MachineEvidence(extraRoot, authority)).rejects.toThrow('artifact inventory')

    const symlinkRoot = await fixture()
    await rm(join(symlinkRoot, 'records/old/D03.json'))
    await symlink('D04.json', join(symlinkRoot, 'records/old/D03.json'))
    await expect(validateOpenDesignM1MachineEvidence(symlinkRoot, authority)).rejects.toThrow('symlink')

    const hardlinkRoot = await fixture()
    const { link } = await import('node:fs/promises')
    await rm(join(hardlinkRoot, 'records/old/D03.json'))
    await link(join(hardlinkRoot, 'records/old/D04.json'), join(hardlinkRoot, 'records/old/D03.json'))
    await expect(validateOpenDesignM1MachineEvidence(hardlinkRoot, authority)).rejects.toThrow('non-regular')
  })

  it('rejects an unexpected empty directory', async () => {
    const root = await fixture()
    await mkdir(join(root, 'unexpected-empty-directory'))
    await expect(validateOpenDesignM1MachineEvidence(root, authority)).rejects.toThrow('directory inventory')
  })

  it('rejects oversize class members before parsing and a checksum mutation', async () => {
    const largeRoot = await fixture()
    await writeFile(join(largeRoot, 'records/old/D01.json'), Buffer.alloc(32 * 1024 + 1, 0x20), { mode: 0o600 })
    await expect(validateOpenDesignM1MachineEvidence(largeRoot, authority)).rejects.toThrow('file constraints')

    const changedRoot = await fixture()
    await writeFile(join(changedRoot, 'previews/new/D01.png'), Buffer.concat([
      await readFile(join(changedRoot, 'previews/new/D01.png')),
      Buffer.from('changed'),
    ]), { mode: 0o600 })
    await expect(validateOpenDesignM1MachineEvidence(changedRoot, authority)).rejects.toThrow('SHA256SUMS')
  })

  it('fails rather than accepting an incomplete fixture directory', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'open-design-m1-machine-empty-'))
    roots.push(parent)
    const root = join(parent, 'artifact')
    await mkdir(root, { mode: 0o700 })
    await expect(validateOpenDesignM1MachineEvidence(root, authority)).rejects.toThrow('artifact directory inventory')
  })

  it('stops the fixed batch at the first failure without invoking later paid Turns', async () => {
    const invoked: number[] = []
    await expect(runFixedFailStopBatch([0, 1, 2, 3], async (value) => {
      invoked.push(value)
      if (value === 1) throw new Error('paid Turn failed')
    })).rejects.toThrow('paid Turn failed')
    expect(invoked).toEqual([0, 1])
  })

  it('blocks the complete paid batch when global Session residue exists at baseline', async () => {
    const invoked: number[] = []
    const hiddenCdp = {
      async evaluate(): Promise<unknown> {
        return {
          schemaVersion: 1,
          v1: { activeRuns: 0, moduleSessions: 0 },
          v2: { activeRuns: 0, moduleSessions: 0 },
          sessions: { hiddenSessions: 1, transientSessions: 1, quarantinedSessions: 0 },
        }
      },
    }
    await expect(runFixedPaidTurnBatch([0, 1], hiddenCdp, async (value) => {
      invoked.push(value)
    })).rejects.toThrow('before paid Turn batch')
    expect(invoked).toEqual([])

    const activeLaneCdp = {
      async evaluate(): Promise<unknown> {
        return {
          schemaVersion: 1,
          v1: { activeRuns: 1, moduleSessions: 0 },
          v2: { activeRuns: 0, moduleSessions: 0 },
          sessions: { hiddenSessions: 0, transientSessions: 0, quarantinedSessions: 0 },
        }
      },
    }
    await expect(runFixedPaidTurnBatch([0], activeLaneCdp, async (value) => {
      invoked.push(value)
    })).rejects.toThrow('before paid Turn batch')
    expect(invoked).toEqual([])

    const cleanCdp = {
      async evaluate(): Promise<unknown> {
        return {
          schemaVersion: 1,
          v1: { activeRuns: 0, moduleSessions: 0 },
          v2: { activeRuns: 0, moduleSessions: 0 },
          sessions: { hiddenSessions: 0, transientSessions: 0, quarantinedSessions: 0 },
        }
      },
    }
    await expect(runFixedPaidTurnBatch([0, 1], cleanCdp, async (value) => {
      invoked.push(value)
    })).resolves.toBe(2)
    expect(invoked).toEqual([0, 1])
  })

  it('cancels the Preview HTTP response body after proving status 200', async () => {
    let cancelled = false
    const response = new Response(new ReadableStream({
      cancel() { cancelled = true },
    }), { status: 200 })
    await requirePreviewHttp200('http://127.0.0.1:45001/', async () => response)
    expect(cancelled).toBe(true)

    let failedBodyCancelled = false
    const failedResponse = new Response(new ReadableStream({
      cancel() { failedBodyCancelled = true },
    }), { status: 503 })
    await expect(requirePreviewHttp200('http://127.0.0.1:45001/', async () => failedResponse))
      .rejects.toThrow('HTTP 200')
    expect(failedBodyCancelled).toBe(true)
  })

  it('captures the actual loopback Preview target and closes the temporary CDP page', async () => {
    const previewUrl = 'http://127.0.0.1:45001/'
    const cdpOrigin = 'http://127.0.0.1:9347'
    const requests: Array<{ url: string; method?: string }> = []
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
    let connected = false
    let closed = false
    const screenshot = await capturePreviewUrlScreenshot(previewUrl, {
      cdpOrigin,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        requests.push({ url, method: init?.method })
        if (url.includes('/json/new?')) {
          return new Response(JSON.stringify({
            id: 'preview-target-1',
            type: 'page',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9347/devtools/page/preview-target-1',
          }), { status: 200 })
        }
        if (url.endsWith('/json/close/preview-target-1')) return new Response('Target is closing', { status: 200 })
        return new Response('unexpected', { status: 404 })
      }) as typeof fetch,
      createClient: (webSocketDebuggerUrl) => {
        expect(webSocketDebuggerUrl).toBe('ws://127.0.0.1:9347/devtools/page/preview-target-1')
        return {
          async connect() { connected = true },
          async evaluate() { return { href: previewUrl, readyState: 'complete' } },
          async screenshot() { return png },
          close() { closed = true },
        }
      },
    })
    expect(screenshot).toEqual(png)
    expect(connected).toBe(true)
    expect(closed).toBe(true)
    expect(requests).toEqual([
      { url: `${cdpOrigin}/json/new?${encodeURIComponent(previewUrl)}`, method: 'PUT' },
      { url: `${cdpOrigin}/json/close/preview-target-1`, method: undefined },
    ])
  })

  it('still closes the temporary Preview target when screenshot capture fails', async () => {
    const requests: string[] = []
    let closed = false
    await expect(capturePreviewUrlScreenshot('http://127.0.0.1:45001/', {
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input)
        requests.push(url)
        if (url.includes('/json/new?')) {
          return new Response(JSON.stringify({
            id: 'preview-target-2',
            type: 'page',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9347/devtools/page/preview-target-2',
          }), { status: 200 })
        }
        return new Response('Target is closing', { status: 200 })
      }) as typeof fetch,
      createClient: () => ({
        async connect() {},
        async evaluate() { return { href: 'http://127.0.0.1:45001/', readyState: 'complete' } },
        async screenshot() { throw new Error('capture failed') },
        close() { closed = true },
      }),
    })).rejects.toThrow('capture failed')
    expect(closed).toBe(true)
    expect(requests.at(-1)).toBe('http://127.0.0.1:9347/json/close/preview-target-2')
  })

  it('preflights the exact external blackout proxy child protocol without a paid Turn', async () => {
    const staging = await mkdtemp(join(tmpdir(), 'open-design-m1-proxy-preflight-'))
    roots.push(staging)
    await preflightExternalBlackoutProxyChild({
      bunPath: await realpath(process.execPath),
      scriptPath: await realpath(join(process.cwd(), 'scripts/qa/run-host-agent-blackout-proxy.ts')),
    }, await realpath(staging))
    await expect(Bun.file(join(staging, 'blackout-proxy-preflight.token')).exists()).resolves.toBe(false)
  })

  it('pins the packaged acceptance descriptor byte-for-byte to Host authority', () => {
    expect(OPEN_DESIGN_M1_MACHINE_ACCEPTANCE_DESCRIPTOR_CANONICAL_JSON)
      .toBe(OPEN_DESIGN_ACCEPTANCE_DESCRIPTOR_CANONICAL_JSON)
  })

  it('accepts a successful Required CI rerun while keeping the producer on attempt one', async () => {
    const root = await fixture()
    await machineEvidenceTestOnly.replaceCanonicalJson(root, 'required-ci.json', (requiredCi) => {
      ;((requiredCi.runs as Array<Record<string, unknown>>)[1]!).runAttempt = 2
    })
    await machineEvidenceTestOnly.reseal(root)
    const result = await validateOpenDesignM1MachineEvidence(root, authority)
    expect(result.fileCount).toBe(150)
  })
})
