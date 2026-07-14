import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer, type RequestListener, type Server } from 'node:http'
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFetchAdapter } from './node-fetch.ts'
import { NodeFilesystemModuleDownloaderCache, type NodeCacheFaultPoint } from './node-cache.ts'
import type { ModuleDownloaderCacheLease } from './types.ts'

const roots: string[] = []
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), 'module-node-cache-')); roots.push(value); return value }

describe('production filesystem cache', () => {
  it('requires an absolute root and rejects traversal-bearing identities', async () => {
    expect(() => new NodeFilesystemModuleDownloaderCache('relative')).toThrow()
    const cache = new NodeFilesystemModuleDownloaderCache(await root())
    await expect(cache.acquireLease('\0catalog', new AbortController().signal)).rejects.toThrow()
    await expect(cache.readArtifact('../bad')).rejects.toThrow()
    await expect(cache.readPartial('../bad')).rejects.toThrow()
  })

  it('defers initialization until an operation can observe its result', async () => {
    const directory = join(await root(), 'lazy-cache')
    const cache = new NodeFilesystemModuleDownloaderCache(directory)
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await cache.readCatalog()).toBeUndefined()
    expect((await lstat(directory)).isDirectory()).toBe(true)
  })

  it('contains nested cache directories by filesystem identity across path aliases', async () => {
    const directory = await root()
    const cache = new NodeFilesystemModuleDownloaderCache(directory)
    expect(await cache.readArtifact('0'.repeat(64))).toBeUndefined()
    expect((await lstat(join(directory, 'artifacts', 'owners'))).isDirectory()).toBe(true)
  })

  it('serializes leases across OS processes', async () => {
    const directory = await root()
    const fixture = join(import.meta.dir, 'testing', 'lease-child.ts')
    const first = child(fixture, directory, 'catalog', '150')
    await first.until('acquired:')
    const second = child(fixture, directory, 'catalog', '0')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(second.output()).not.toContain('acquired:')
    await first.done
    await second.done
    expect(second.output()).toContain('acquired:')
  })

  it.skipIf(process.platform !== 'win32')('defers transient released-marker cleanup without failing logical release', async () => {
    const directory = await root(); let cleanupFaults = 2
    const cache = new NodeFilesystemModuleDownloaderCache(directory, {
      leasePollMs: 5,
      faultInjector(point, path) {
        if (point === 'cleanup' && path.includes('.released-') && cleanupFaults > 0) {
          cleanupFaults -= 1
          throw Object.assign(new Error('transient Windows cleanup contention'), { code: 'EFAULT' })
        }
      },
    })
    const lease = await cache.acquireLease('deferred cleanup', new AbortController().signal)
    await expect(lease.release()).resolves.toBeUndefined()
    expect(cleanupFaults).toBe(0)
    expect((await readdir(join(directory, 'leases', 'claims'))).some((name) => name.includes('.released-'))).toBe(true)

    const replacement = new NodeFilesystemModuleDownloaderCache(directory, { leasePollMs: 5 })
    const next = await replacement.acquireLease('deferred cleanup', AbortSignal.timeout(5_000))
    await next.release()
    expect((await readdir(join(directory, 'leases', 'claims'))).some((name) => name.includes('.released-'))).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')('defers released-marker scans when Windows lstat is transiently blocked', async () => {
    const directory = await root(); let scanFaults = 1
    const setup = new NodeFilesystemModuleDownloaderCache(directory)
    await setup.readCatalog()
    const key = 'blocked released-marker scan'
    const base = createHash('sha256').update(key).digest('hex')
    const token = '00000000-0000-4000-8000-000000000000'
    const marker = join(directory, 'leases', 'claims', `${base}.released-${token}`)
    await writeFile(marker, token)

    const cache = new NodeFilesystemModuleDownloaderCache(directory, {
      leasePollMs: 1,
      faultInjector(point, path) {
        if (point === 'cleanup' && path === marker && scanFaults > 0) {
          scanFaults -= 1
          throw Object.assign(new Error('transient Windows marker lstat contention'), { code: 'EPERM' })
        }
      },
    })
    const lease = await cache.acquireLease(key, AbortSignal.timeout(5_000))
    await lease.release()
    expect(scanFaults).toBe(0)
    expect((await readdir(join(directory, 'leases', 'claims'))).some((name) => name.includes('.released-'))).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')('treats a released marker that vanishes after EEXIST as a completed release', async () => {
    const directory = await root()
    const cache = new NodeFilesystemModuleDownloaderCache(directory, {
      faultInjector(point, path) {
        if (point === 'temp-write' && path.includes('.released-')) {
          return rm(path, { force: true }).then(() => {
            throw Object.assign(new Error('simulated marker collision'), { code: 'EEXIST' })
          })
        }
      },
    })
    const lease = await cache.acquireLease('vanishing released marker', new AbortController().signal)
    await expect(lease.release()).resolves.toBeUndefined()
  })

  it.skipIf(process.platform !== 'win32')('completes release when cleanup removes a marker before publication chmod', async () => {
    const directory = await root(); let removed = false
    const cache = new NodeFilesystemModuleDownloaderCache(directory, {
      faultInjector(point, path) {
        if (point === 'before-chmod' && path.includes('.released-') && !removed) {
          removed = true
          return rm(path, { force: true })
        }
      },
    })
    const lease = await cache.acquireLease('marker publication race', new AbortController().signal)
    await expect(lease.release()).resolves.toBeUndefined()
    expect(removed).toBe(true)

    const replacement = new NodeFilesystemModuleDownloaderCache(directory, { leasePollMs: 1 })
    const next = await replacement.acquireLease('marker publication race', AbortSignal.timeout(5_000))
    await expect(next.release()).resolves.toBeUndefined()
  })

  for (const mode of ['eexist', 'before-chmod'] as const) {
    it.skipIf(process.platform !== 'win32')(`does not remove a replacement owner during ${mode} marker finalization`, async () => {
      const directory = await root(); const key = `replacement owner during ${mode}`
      let injected = false; let replacementLease: ModuleDownloaderCacheLease | undefined
      const original = new NodeFilesystemModuleDownloaderCache(directory, {
        leasePollMs: 1,
        faultInjector: async (point, path) => {
          const targetPoint = mode === 'before-chmod' ? 'before-chmod' : 'temp-write'
          if (injected || point !== targetPoint || !path.includes('.released-')) return
          injected = true
          const replacement = new NodeFilesystemModuleDownloaderCache(directory, { leasePollMs: 1 })
          replacementLease = await replacement.acquireLease(key, AbortSignal.timeout(2_000))
          if (mode === 'eexist') throw Object.assign(new Error('marker existed, then cleanup removed it'), { code: 'EEXIST' })
        },
      })

      try {
        const first = await original.acquireLease(key, AbortSignal.timeout(2_000))
        await expect(first.release()).resolves.toBeUndefined()
        expect(injected).toBe(true)
        expect(replacementLease).toBeDefined()

        const contenderAbort = new AbortController(); let overlappingOwnerGranted = false
        const contender = new NodeFilesystemModuleDownloaderCache(directory, { leasePollMs: 1 }).acquireLease(key, contenderAbort.signal).then((lease) => {
          overlappingOwnerGranted = true
          return lease
        })
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(overlappingOwnerGranted).toBe(false)
        contenderAbort.abort(new Error('replacement owner remains active'))
        await expect(contender).rejects.toMatchObject({ message: 'replacement owner remains active' })

        await replacementLease!.release()
        replacementLease = undefined
        const next = await new NodeFilesystemModuleDownloaderCache(directory, { leasePollMs: 1 }).acquireLease(key, AbortSignal.timeout(2_000))
        await expect(next.release()).resolves.toBeUndefined()
      } finally {
        if (replacementLease) await Promise.resolve(replacementLease.release()).catch(() => undefined)
      }
    })
  }

  for (const code of ['EFAULT', 'EBADF', 'EBUSY', 'EPERM'] as const) {
    it.skipIf(process.platform !== 'win32')(`fails finitely without granting a new owner when marker cleanup stays ${code}`, async () => {
      const directory = await root()
      const cache = new NodeFilesystemModuleDownloaderCache(directory, {
        leasePollMs: 1,
        maxStaleRecoveries: 2,
        faultInjector(point, path) {
          if (point === 'cleanup' && path.includes('.released-')) {
            throw Object.assign(new Error(`persistent ${code}`), { code })
          }
        },
      })
      const lease = await cache.acquireLease(`persistent cleanup ${code}`, new AbortController().signal)
      await expect(lease.release()).resolves.toBeUndefined()
      await expect(cache.acquireLease(`persistent cleanup ${code}`, AbortSignal.timeout(5_000))).rejects.toMatchObject({
        code: 'LEASE_CLEANUP_BLOCKED',
      })
    })
  }

  it.skipIf(process.platform !== 'win32')('prunes an orphan released marker during bounded startup recovery', async () => {
    const directory = await root()
    const setup = new NodeFilesystemModuleDownloaderCache(directory)
    await setup.readCatalog()
    const key = 'startup released marker'
    const base = createHash('sha256').update(key).digest('hex')
    const token = '00000000-0000-4000-8000-000000000000'
    const marker = join(directory, 'leases', 'claims', `${base}.released-${token}`)
    await writeFile(marker, token)

    const recovered = new NodeFilesystemModuleDownloaderCache(directory, { maxStartupPrunes: 1 })
    await recovered.readCatalog()
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('elects one cross-process artifact publisher and one verified reader', async () => {
    const directory = await root()
    const fixture = join(import.meta.dir, 'testing', 'artifact-child.ts')
    const first = child(fixture, directory, 'shared artifact', '100')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = child(fixture, directory, 'shared artifact', '0')
    await Promise.all([first.done, second.done])
    const output = first.output() + second.output()
    expect(output.match(/publisher:/g)).toHaveLength(1)
    expect(output.match(/verified-reader:/g)).toHaveLength(1)
  })

  it('recovers a bounded dead stale owner without deleting a replacement owner', async () => {
    const directory = await root()
    const leaseName = createHash('sha256').update('catalog').digest('hex')
    const lock = join(directory, 'leases', 'claims', `${leaseName}.lock`)
    await writeFile(join(directory, '.keep'), '')
    const cache = new NodeFilesystemModuleDownloaderCache(directory, { staleLeaseMs: 1, leasePollMs: 5, maxStaleRecoveries: 1, now: () => 10_000 })
    await cache.readCatalog()
    await mkdir(lock, { recursive: true })
    const token = '00000000-0000-4000-8000-000000000000'
    await writeFile(join(lock, 'claim.json'), JSON.stringify({ token }))
    await writeFile(join(directory, 'leases', 'owners', `${token}.json`), JSON.stringify({ token, pid: 999_999_999, acquiredAt: 0 }))
    const lease = await cache.acquireLease('catalog', new AbortController().signal)
    await lease.release()
    await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('recovers an ownerless lock left by a crash before owner metadata', async () => {
    const directory = await root(); const leaseName = createHash('sha256').update('catalog').digest('hex')
    const lock = join(directory, 'leases', 'claims', `${leaseName}.lock`); await mkdir(lock, { recursive: true }); await utimes(lock, 0, 0)
    const cache = new NodeFilesystemModuleDownloaderCache(directory, { staleLeaseMs: 1, leasePollMs: 5, now: () => 10_000 })
    const lease = await cache.acquireLease('catalog', new AbortController().signal); await lease.release()
    await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('re-observes state when another recoverer wins the stale-lock rename', async () => {
    const directory = await root(); const leaseName = createHash('sha256').update('catalog').digest('hex')
    const lock = join(directory, 'leases', 'claims', `${leaseName}.lock`); await mkdir(lock, { recursive: true }); await utimes(lock, 0, 0)
    let lostRecoveryRace = false
    const cache = new NodeFilesystemModuleDownloaderCache(directory, {
      staleLeaseMs: 1,
      leasePollMs: 1,
      now: () => 10_000,
      faultInjector(point, path) {
        if (point === 'rename' && path.includes('.recover-') && !lostRecoveryRace) {
          lostRecoveryRace = true
          throw Object.assign(new Error('another recoverer moved the lock'), { code: 'ENOENT' })
        }
      },
    })
    const lease = await cache.acquireLease('catalog', new AbortController().signal); await lease.release()
    expect(lostRecoveryRace).toBe(true)
    await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not delete a replacement owner after a stale-read pathname ABA', async () => {
    const directory = await root(); const leaseName = createHash('sha256').update('catalog').digest('hex')
    const setup = new NodeFilesystemModuleDownloaderCache(directory); await setup.readCatalog()
    const lock = join(directory, 'leases', 'claims', `${leaseName}.lock`); await mkdir(lock, { recursive: true })
    const dead = '00000000-0000-4000-8000-000000000000'
    await writeFile(join(lock, 'claim.json'), JSON.stringify({ token: dead }))
    await writeFile(join(directory, 'leases', 'owners', `${dead}.json`), JSON.stringify({ token: dead, pid: 999_999_999, acquiredAt: 0 }))
    const staleGate = join(directory, 'continue-stale'); const quarantineGate = join(directory, 'continue-quarantine'); const releaseGate = join(directory, 'release-replacement')
    const fixture = join(import.meta.dir, 'testing', 'lease-aba-child.ts')
    const recoverer = child(fixture, directory, staleGate, quarantineGate); await recoverer.until('before-stale-rename')
    await rm(lock, { recursive: true })
    const replacementFixture = join(import.meta.dir, 'testing', 'lease-release-child.ts')
    const replacement = child(replacementFixture, directory, releaseGate); await replacement.until('acquired:')
    const replacementClaim = JSON.parse(await readFile(join(lock, 'claim.json'), 'utf8'))
    const replacementOwner = JSON.parse(await readFile(join(directory, 'leases', 'owners', `${replacementClaim.token}.json`), 'utf8'))
    await writeFile(staleGate, 'continue'); await recoverer.until('replacement-quarantined')
    await writeFile(releaseGate, 'release'); await replacement.done
    await writeFile(quarantineGate, 'continue')
    await recoverer.done
    expect(recoverer.output()).toContain('recoverer-acquired')
    expect(replacementOwner.pid).not.toBe(process.pid)
  })

  it('recovers a stale PID-reused owner only when process start identity differs', async () => {
    const directory = await root(); const cache = new NodeFilesystemModuleDownloaderCache(directory, { staleLeaseMs: 1, leasePollMs: 5, now: () => 10_000, processIdentity: async () => 'current-start' })
    await cache.readCatalog(); const hash = createHash('sha256').update('catalog').digest('hex'); const token = '00000000-0000-4000-8000-000000000000'
    const claim = join(directory, 'leases', 'claims', `${hash}.lock`); await mkdir(claim)
    await writeFile(join(claim, 'claim.json'), JSON.stringify({ token }))
    await writeFile(join(directory, 'leases', 'owners', `${token}.json`), JSON.stringify({ token, pid: process.pid, processInstanceId: 'old-instance', processStartIdentity: 'old-start', acquiredAt: 0 }))
    const lease = await cache.acquireLease('catalog', new AbortController().signal); await lease.release()
    await expect(stat(claim)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('memoizes the current process identity while creating cache owners', async () => {
    const directory = await root(); let ownIdentityCalls = 0
    const cache = new NodeFilesystemModuleDownloaderCache(directory, {
      processIdentity: async (pid) => {
        if (pid === process.pid) ownIdentityCalls += 1
        return 'current-start'
      },
    })
    const bytes = Buffer.from('owner identity'); const sha256 = createHash('sha256').update(bytes).digest('hex')
    const first = await cache.createPartial({ sha256, sourceUrl: 'https://example.test/a', expectedSize: bytes.length, updatedAt: 1 }); await cache.appendPartial(first.id, bytes, 2)
    expect(await cache.publishPartial(first.id, { sha256, size: bytes.length, committedAt: 3 })).toBe('published')
    const second = await cache.createPartial({ sha256, sourceUrl: 'https://example.test/a', expectedSize: bytes.length, updatedAt: 4 }); await cache.appendPartial(second.id, bytes, 5)
    expect(await cache.publishPartial(second.id, { sha256, size: bytes.length, committedAt: 6 })).toBe('already-present')
    expect(ownIdentityCalls).toBe(1)
  })

  it('retries a transiently unavailable current process identity instead of memoizing absence', async () => {
    const directory = await root(); let ownIdentityCalls = 0
    const cache = new NodeFilesystemModuleDownloaderCache(directory, {
      processIdentity: async (pid) => {
        if (pid !== process.pid) return undefined
        ownIdentityCalls += 1
        return ownIdentityCalls === 1 ? undefined : 'current-start'
      },
    })
    const firstBytes = Buffer.from('first owner'); const firstSha = createHash('sha256').update(firstBytes).digest('hex')
    const secondBytes = Buffer.from('second owner'); const secondSha = createHash('sha256').update(secondBytes).digest('hex')
    await cache.createPartial({ sha256: firstSha, sourceUrl: 'https://example.test/first', expectedSize: firstBytes.length, updatedAt: 1 })
    await cache.createPartial({ sha256: secondSha, sourceUrl: 'https://example.test/second', expectedSize: secondBytes.length, updatedAt: 2 })
    expect(ownIdentityCalls).toBe(2)
  })

  it('makes catalog compare-and-swap atomic without a caller-held lease', async () => {
    const directory = await root(); const left = new NodeFilesystemModuleDownloaderCache(directory); const right = new NodeFilesystemModuleDownloaderCache(directory)
    const first = catalogRecord(1, 1); const second = catalogRecord(1, 2)
    await Promise.all([left.stageCatalog(first), right.stageCatalog(second)])
    const results = await Promise.all([left.publishCatalog(undefined), right.publishCatalog(undefined)])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect((await left.readCatalog())?.trustState.highestSequence).toBe(1)
  })

  it('adopts and publishes a staged catalog left by another process instance', async () => {
    const directory = await root(); const crashed = new NodeFilesystemModuleDownloaderCache(directory); const staged = catalogRecord(1, 1)
    await crashed.stageCatalog(staged)
    const recovery = new NodeFilesystemModuleDownloaderCache(directory)
    expect(await recovery.readStagedCatalog()).toEqual(staged)
    expect(await recovery.publishCatalog(undefined)).toBe(true)
    expect(await recovery.readCatalog()).toEqual(staged)
  })

  it('binds publish to the exact immutable staged transaction identity and digest', async () => {
    const directory = await root(); const cache = new NodeFilesystemModuleDownloaderCache(directory); await cache.stageCatalog(catalogRecord(1, 1))
    const stagedDirectory = join(directory, 'catalog', 'staged'); const [stageName] = await readdirNames(stagedDirectory); const stagePath = join(stagedDirectory, stageName!)
    const original = `${stagePath}.original`; await rename(stagePath, original); await writeFile(stagePath, JSON.stringify({ ...catalogRecord(1, 2), responseBytesBase64: 'Ag==' }))
    await expect(cache.publishCatalog(undefined)).rejects.toThrow('identity or digest changed')
    expect(await cache.readCatalog()).toBeUndefined()
  })

  it('fails closed when a cache top-level directory is a symlink', async () => {
    for (const name of ['catalog', 'artifacts', 'partials', 'leases']) {
      const directory = await root(); const outside = await root(); await writeFile(join(outside, 'sentinel'), 'safe'); await symlink(outside, join(directory, name), 'dir')
      const cache = new NodeFilesystemModuleDownloaderCache(directory)
      await expect(cache.readCatalog()).rejects.toThrow('Unsafe cache directory')
      expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('safe')
      expect(await readdirNames(outside)).toEqual(['sentinel'])
    }
  })

  it('publishes an immutable verified artifact and detects later corruption', async () => {
    const directory = await root()
    const cache = new NodeFilesystemModuleDownloaderCache(directory)
    const bytes = Buffer.from('content-addressed')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const partial = await cache.createPartial({ sha256, sourceUrl: 'https://example.test/a', expectedSize: bytes.length, updatedAt: 1 })
    await cache.appendPartial(partial.id, bytes, 2)
    const record = { sha256, size: bytes.length, committedAt: 3 }
    expect(await cache.publishPartial(partial.id, record)).toBe('published')
    expect(await cache.readArtifact(sha256)).toEqual(record)
    const artifactPath = join(directory, 'artifacts', sha256, 'artifact.bin')
    if (process.platform !== 'win32') expect((await stat(artifactPath)).mode & 0o777).toBe(0o600)
    await writeFile(artifactPath, 'corrupt')
    await expect(cache.readArtifact(sha256)).rejects.toThrow('verification')
  })

  it('never replaces a pre-existing empty artifact destination', async () => {
    const directory = await root(); const cache = new NodeFilesystemModuleDownloaderCache(directory); await cache.listPartials()
    const bytes = Buffer.from('immutable'); const sha256 = createHash('sha256').update(bytes).digest('hex'); const destination = join(directory, 'artifacts', sha256)
    await mkdir(destination); const before = await lstat(destination)
    const partial = await cache.createPartial({ sha256, sourceUrl: 'https://example.test/a', expectedSize: bytes.length, updatedAt: 1 }); await cache.appendPartial(partial.id, bytes, 2)
    await expect(cache.publishPartial(partial.id, { sha256, size: bytes.length, committedAt: 3 })).rejects.toThrow('destination exists')
    const after = await lstat(destination); expect(after.ino).toBe(before.ino); expect(await readdirNames(destination)).toEqual([])
  })

  it('does not reclaim an active artifact owner paused beyond stale age', async () => {
    const directory = await root(); let reached!: () => void; let resume!: () => void
    const atClaim = new Promise<void>((resolve) => { reached = resolve }); const gate = new Promise<void>((resolve) => { resume = resolve })
    const processIdentity = async () => 'active-owner-process-start'
    const first = new NodeFilesystemModuleDownloaderCache(directory, { staleLeaseMs: 1, leasePollMs: 1, processIdentity, checkpoint: async (point) => { if (point === 'artifact-claim-published') { reached(); await gate } } })
    const bytes = Buffer.from('active owner'); const sha256 = createHash('sha256').update(bytes).digest('hex')
    const firstPartial = await first.createPartial({ sha256, sourceUrl: 'https://example.test/a', expectedSize: bytes.length, updatedAt: 1 }); await first.appendPartial(firstPartial.id, bytes, 2)
    const publishing = first.publishPartial(firstPartial.id, { sha256, size: bytes.length, committedAt: 3 }); await atClaim
    try {
      const competitor = new NodeFilesystemModuleDownloaderCache(directory, { staleLeaseMs: 1, leasePollMs: 1, maxStaleRecoveries: 1, now: () => Date.now() + 1_000_000, processIdentity })
      const secondPartial = await competitor.createPartial({ sha256, sourceUrl: 'https://example.test/a', expectedSize: bytes.length, updatedAt: 4 }); await competitor.appendPartial(secondPartial.id, bytes, 5)
      await expect(competitor.publishPartial(secondPartial.id, { sha256, size: bytes.length, committedAt: 6 })).rejects.toThrow('live or unverifiable owner')
    } finally {
      resume(); await publishing
    }
    expect(await publishing).toBe('published')
  })

  it('fails closed for partial data and record leaf symlinks without touching targets', async () => {
    for (const leaf of ['data.bin', 'record.json']) {
      const directory = await root(); const outside = join(await root(), 'outside'); await writeFile(outside, 'safe')
      const cache = new NodeFilesystemModuleDownloaderCache(directory); const bytes = Buffer.from('leaf'); const sha256 = createHash('sha256').update(bytes).digest('hex')
      const partial = await cache.createPartial({ sha256, sourceUrl: 'https://example.test/a', expectedSize: bytes.length, updatedAt: 1 })
      const leafPath = join(directory, 'partials', partial.id, leaf); await unlink(leafPath); await symlink(outside, leafPath)
      await expect(cache.appendPartial(partial.id, bytes, 2)).rejects.toThrow()
      await cache.removePartial(partial.id)
      expect(await readFile(outside, 'utf8')).toBe('safe')
    }
  })

  it('keeps catalog envelope and trust state in one durable committed file', async () => {
    const directory = await root()
    const cache = new NodeFilesystemModuleDownloaderCache(directory)
    const record = { sourceUrl: 'https://example.test/catalog', responseBytes: new Uint8Array([1, 2]), expiresAt: '2030-01-01T00:00:00.000Z', trustState: { highestSequence: 1, latestIssuedAt: '2029-01-01T00:00:00.000Z' }, committedAt: 1 }
    await cache.stageCatalog(record)
    expect(await cache.publishCatalog(undefined)).toBe(true)
    const generations = await readdirNames(join(directory, 'catalog', 'generations'))
    expect(generations).toHaveLength(1)
    const wire = JSON.parse(await readFile(join(directory, 'catalog', 'generations', generations[0]!), 'utf8'))
    expect(wire.responseBytesBase64).toBe('AQI='); expect(wire.trustState).toEqual(record.trustState)
    expect(await cache.readStagedCatalog()).toBeUndefined()
  })

  it('recovers old or complete new catalog state at every durable transaction crash point', async () => {
    for (const point of ['temp-write', 'file-sync', 'rename', 'directory-sync', 'cleanup'] as NodeCacheFaultPoint[]) {
      const directory = await root(); const baseline = new NodeFilesystemModuleDownloaderCache(directory); const first = catalogRecord(1, 1)
      await baseline.stageCatalog(first); expect(await baseline.publishCatalog(undefined)).toBe(true)
      let armed = false
      const faulted = new NodeFilesystemModuleDownloaderCache(directory, { faultInjector(candidate, path) { if (armed && candidate === point && (hasPathSegments(path, 'catalog', 'generations') || path.endsWith('current.json') || (candidate === 'directory-sync' && path.endsWith('generations')))) throw new Error(`crash:${point}`) } })
      const second = catalogRecord(2, 2); await faulted.stageCatalog(second); armed = true
      await expect(faulted.publishCatalog(first.trustState)).rejects.toThrow(`crash:${point}`)
      const recovered = await new NodeFilesystemModuleDownloaderCache(directory).readCatalog()
      if (!recovered) throw new Error('Catalog transaction disappeared')
      expect([1, 2]).toContain(recovered?.trustState.highestSequence)
      expect(recovered.responseBytes[0]).toBe(recovered.trustState.highestSequence)
    }
  }, 20_000)

  it('reports the platform durability protocol without claiming Windows directory fsync', async () => {
    const cache = new NodeFilesystemModuleDownloaderCache(await root())
    await cache.readCatalog()
    expect(cache.durability).toBe('immutable-generation-scan')
  })

  it('bounds startup pruning of stale staging and orphan partial files', async () => {
    const directory = await root()
    const staging = join(directory, 'artifacts', `${'a'.repeat(64)}.recover-dead`)
    const orphan = join(directory, 'partials', '00000000-0000-4000-8000-000000000000')
    await mkdir(staging, { recursive: true }); await mkdir(orphan, { recursive: true }); await writeFile(join(orphan, 'data.bin'), 'x')
    await utimes(staging, 0, 0); await utimes(orphan, 0, 0)
    const cache = new NodeFilesystemModuleDownloaderCache(directory, { staleLeaseMs: 1, maxStartupPrunes: 1, now: () => 10_000 })
    await cache.listPartials()
    expect(await stat(staging).then(() => true, () => false)).toBe(false)
  })

  it('bounds startup pruning of stale unreferenced artifact owners', async () => {
    const directory = await root(); const initial = new NodeFilesystemModuleDownloaderCache(directory); await initial.readCatalog()
    const owners = join(directory, 'artifacts', 'owners')
    for (const token of ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']) {
      await writeFile(join(owners, `${token}.json`), JSON.stringify({ token, pid: 999_999_999, processInstanceId: token, acquiredAt: 0 }))
    }
    const cache = new NodeFilesystemModuleDownloaderCache(directory, { staleLeaseMs: 1, maxStartupPrunes: 1, now: () => 10_000 })
    await cache.readCatalog()
    expect(await readdirNames(owners)).toHaveLength(1)
  })

  it.skipIf(process.platform === 'win32')('does not spend POSIX startup recovery budget on released lease quarantine', async () => {
    const directory = await root()
    const initial = new NodeFilesystemModuleDownloaderCache(directory)
    await initial.readCatalog()
    const released = `${createHash('sha256').update('released quarantine').digest('hex')}.released-00000000-0000-4000-8000-000000000000`
    await mkdir(join(directory, 'leases', 'claims', released))
    const token = '00000000-0000-4000-8000-000000000001'
    const owner = join(directory, 'artifacts', 'owners', `${token}.json`)
    await writeFile(owner, JSON.stringify({ token, pid: 999_999_999, processInstanceId: token, acquiredAt: 0 }))

    const recovered = new NodeFilesystemModuleDownloaderCache(directory, {
      staleLeaseMs: 1,
      maxStartupPrunes: 1,
      now: () => 10_000,
    })
    await recovered.readCatalog()
    await expect(stat(owner)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed on artifact owner and claim leaf symlinks during startup', async () => {
    for (const leaf of ['owner', 'claim']) {
      const directory = await root(); const initial = new NodeFilesystemModuleDownloaderCache(directory); await initial.readCatalog()
      const outside = join(await root(), 'outside'); await writeFile(outside, '{}')
      const path = leaf === 'owner'
        ? join(directory, 'artifacts', 'owners', '00000000-0000-4000-8000-000000000000.json')
        : join(directory, 'artifacts', 'claims', `${'a'.repeat(64)}.claim`)
      await symlink(outside, path)
      await expect(new NodeFilesystemModuleDownloaderCache(directory).readCatalog()).rejects.toThrow(`Unsafe artifact ${leaf}`)
      expect(await readFile(outside, 'utf8')).toBe('{}')
    }
  })

  it('recovers after real child termination at lease, artifact, and catalog protocol checkpoints', async () => {
    const fixture = join(import.meta.dir, 'testing', 'crash-child.ts')
    for (const mode of ['lease-owner', 'lease-mkdir', 'lease-claim', 'lease-quarantine']) {
      const directory = await root(); await killAtCheckpoint(fixture, directory, mode)
      await new Promise((resolve) => setTimeout(resolve, 5))
      const cache = new NodeFilesystemModuleDownloaderCache(directory, { staleLeaseMs: 1, leasePollMs: 5 }); const lease = await cache.acquireLease('catalog', new AbortController().signal); await lease.release()
    }
    for (const mode of ['artifact-owner', 'artifact-claim', 'artifact']) {
      const directory = await root(); await killAtCheckpoint(fixture, directory, mode); await new Promise((resolve) => setTimeout(resolve, 5))
      const cache = new NodeFilesystemModuleDownloaderCache(directory, { staleLeaseMs: 1, leasePollMs: 5 }); const bytes = Buffer.from('crash artifact'); const sha256 = createHash('sha256').update(bytes).digest('hex')
      const partial = await cache.createPartial({ sha256, sourceUrl: 'https://example.test/a', expectedSize: bytes.length, updatedAt: 4 }); await cache.appendPartial(partial.id, bytes, 5)
      expect(await cache.publishPartial(partial.id, { sha256, size: bytes.length, committedAt: 6 })).toBe('published')
      expect(await readdirNames(join(directory, 'artifacts', 'owners'))).toEqual([])
    }
    {
      const directory = await root(); await killAtCheckpoint(fixture, directory, 'partial-data'); await new Promise((resolve) => setTimeout(resolve, 5))
      const cache = new NodeFilesystemModuleDownloaderCache(directory, { staleLeaseMs: 1 }); await cache.readCatalog()
      expect((await readdirNames(join(directory, 'partials'))).filter((name) => /^[a-f0-9-]{36}$/.test(name))).toEqual([])
    }
    {
      const directory = await root(); await killAtCheckpoint(fixture, directory, 'catalog-mid-write'); await new Promise((resolve) => setTimeout(resolve, 5))
      const cache = new NodeFilesystemModuleDownloaderCache(directory, { staleLeaseMs: 1 }); expect((await cache.readCatalog())?.trustState.highestSequence).toBe(1)
      expect((await readdirNames(join(directory, 'catalog', 'generations'))).filter((name) => name.startsWith('0000000000000002.'))).toEqual([])
      expect((await readdirNames(join(directory, 'catalog', 'generations'))).filter((name) => name.endsWith('.generation.tmp'))).toEqual([])
    }
    for (const mode of ['catalog-generation', 'catalog-rename']) {
      const directory = await root(); await killAtCheckpoint(fixture, directory, mode)
      expect((await new NodeFilesystemModuleDownloaderCache(directory).readCatalog())?.trustState.highestSequence).toBe(2)
    }
  }, process.platform === 'win32' ? 20_000 : 5_000)

  it('treats catalog generation hard-link EEXIST as success only for the same digest', async () => {
    for (const sameDigest of [true, false]) {
      const directory = await root(); let raced = false; const record = catalogRecord(1, 1)
      const { responseBytes, ...rest } = record
      const winnerBytes = Buffer.from(JSON.stringify({ ...rest, responseBytesBase64: Buffer.from(responseBytes).toString('base64') }))
      const cache = new NodeFilesystemModuleDownloaderCache(directory, { faultInjector: async (point, path) => {
        if (point !== 'rename' || !hasPathSegments(path, 'catalog', 'generations') || raced) return
        raced = true
        await writeFile(path, sameDigest ? winnerBytes : Buffer.from('different winner'))
      } })
      await cache.stageCatalog(record)
      if (sameDigest) expect(await cache.publishCatalog(undefined)).toBe(true)
      else await expect(cache.publishCatalog(undefined)).rejects.toMatchObject({ code: 'EEXIST' })
    }
  })

  it('does not accumulate artifact owner inodes on repeated already-present publication', async () => {
    const directory = await root(); const cache = new NodeFilesystemModuleDownloaderCache(directory)
    const bytes = Buffer.from('already present'); const sha256 = createHash('sha256').update(bytes).digest('hex'); const record = { sha256, size: bytes.length, committedAt: 3 }
    const first = await cache.createPartial({ sha256, sourceUrl: 'https://example.test/a', expectedSize: bytes.length, updatedAt: 1 }); await cache.appendPartial(first.id, bytes, 2)
    expect(await cache.publishPartial(first.id, record)).toBe('published')
    for (let index = 0; index < 3; index += 1) {
      const partial = await cache.createPartial({ sha256, sourceUrl: 'https://example.test/a', expectedSize: bytes.length, updatedAt: 4 + index }); await cache.appendPartial(partial.id, bytes, 5 + index)
      expect(await cache.publishPartial(partial.id, record)).toBe('already-present')
      expect(await readdirNames(join(directory, 'artifacts', 'owners'))).toEqual([])
    }
  })

})

describe('native fetch adapter', () => {
  it('supports manual redirects, chunked bodies, 304 and Range', async () => {
    const { url } = await loopback((request, response) => {
      if (request.url === '/redirect') { response.writeHead(302, { location: '/chunked' }); response.end(); return }
      if (request.url === '/not-modified') { response.writeHead(304); response.end(); return }
      if (request.url === '/range') { response.writeHead(206, { 'content-range': 'bytes 2-3/4' }); response.end('cd'); return }
      response.writeHead(200); response.write('ab'); response.end('cd')
    })
    const adapter = new NodeFetchAdapter()
    const redirect = await adapter.fetch(request(`${url}/redirect`))
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get('location')).toBe('/chunked')
    await redirect.dispose(); await redirect.dispose()
    const chunked = await adapter.fetch(request(`${url}/chunked`))
    expect(Buffer.concat(await chunks(chunked.body)).toString()).toBe('abcd')
    await chunked.dispose()
    const unchanged = await adapter.fetch(request(`${url}/not-modified`))
    expect(unchanged.status).toBe(304); await unchanged.dispose()
    const ranged = await adapter.fetch(request(`${url}/range`, { range: 'bytes=2-' }))
    expect(ranged.status).toBe(206); expect(ranged.headers.get('content-range')).toBe('bytes 2-3/4'); await ranged.dispose()
  })

  it('propagates cancellation and disconnect errors', async () => {
    const { url } = await loopback((request, response) => {
      if (request.url === '/hang') return
      response.writeHead(200); response.write('a'); response.destroy()
    })
    const adapter = new NodeFetchAdapter()
    const controller = new AbortController()
    const pending = adapter.fetch(request(`${url}/hang`, {}, controller.signal))
    controller.abort('cancelled')
    await expect(pending).rejects.toBeDefined()
    await expect(adapter.fetch(request(`${url}/hang`, {}, AbortSignal.timeout(10)))).rejects.toBeDefined()
    await expect((async () => {
      const response = await adapter.fetch(request(`${url}/disconnect`))
      try { await chunks(response.body) } finally { await response.dispose() }
    })()).rejects.toBeDefined()
  })

  it('cancels a reader-locked body exactly once on early disposal', async () => {
    let cancels = 0
    const stream = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => undefined) }, cancel() { cancels += 1 } })
    const native = new Response(stream, { status: 200 }); Object.defineProperty(native, 'url', { value: 'https://example.test/body' })
    const adapter = new NodeFetchAdapter(async () => native)
    const response = await adapter.fetch(request('https://example.test/body')); const pending = response.body![Symbol.asyncIterator]().next()
    await response.dispose(); await response.dispose(); expect(cancels).toBe(1); expect((await pending).done).toBe(true)
  })
})

function request(url: string, headers: Record<string, string> = {}, signal = new AbortController().signal) { return { url, headers, signal, redirect: 'manual' as const } }
async function chunks(body: AsyncIterable<Uint8Array> | null): Promise<Buffer[]> { const result: Buffer[] = []; if (body) for await (const chunk of body) result.push(Buffer.from(chunk)); return result }
async function loopback(handler: RequestListener): Promise<{ url: string }> { const server = createServer(handler); servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No server address'); return { url: `http://127.0.0.1:${address.port}` } }
function child(fixture: string, ...args: string[]) {
  const process = spawn('bun', [fixture, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; process.stdout.on('data', (data) => { output += String(data) }); process.stderr.on('data', (data) => { output += String(data) })
  const done = new Promise<void>((resolve, reject) => process.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${output}`))))
  return { done, output: () => output, until: async (text: string) => { while (!output.includes(text)) { if (process.exitCode !== null) await done; await new Promise((resolve) => setTimeout(resolve, 5)) } } }
}
function catalogRecord(sequence: number, marker: number) { return { sourceUrl: `https://example.test/catalog-${marker}`, responseBytes: new Uint8Array([marker]), expiresAt: '2030-01-01T00:00:00.000Z', trustState: { highestSequence: sequence, latestIssuedAt: '2029-01-01T00:00:00.000Z' }, committedAt: marker } }
function hasPathSegments(path: string, ...segments: string[]): boolean { const normalized = path.replaceAll('\\', '/'); const suffix = `/${segments.join('/')}`; return normalized.includes(`${suffix}/`) || normalized.endsWith(suffix) }
async function readdirNames(path: string): Promise<string[]> { return (await import('node:fs/promises')).readdir(path).then((names) => names.sort()) }
async function killAtCheckpoint(fixture: string, directory: string, mode: string): Promise<void> {
  const process = spawn('bun', [fixture, directory, mode], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''
  process.stdout.on('data', (data) => { output += String(data) }); process.stderr.on('data', (data) => { output += String(data) })
  while (!output.includes('checkpoint:')) { if (process.exitCode !== null) throw new Error(`crash child exited early: ${output}`); await new Promise((resolve) => setTimeout(resolve, 5)) }
  process.kill('SIGKILL'); await new Promise<void>((resolve) => process.on('exit', () => resolve()))
}
