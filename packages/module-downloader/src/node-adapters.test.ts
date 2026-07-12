import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer, type RequestListener, type Server } from 'node:http'
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFetchAdapter } from './node-fetch.ts'
import { NodeFilesystemModuleDownloaderCache, type NodeCacheFaultPoint } from './node-cache.ts'

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
    const lock = join(directory, 'leases', `${leaseName}.lock`)
    await writeFile(join(directory, '.keep'), '')
    const cache = new NodeFilesystemModuleDownloaderCache(directory, { staleLeaseMs: 1, leasePollMs: 5, maxStaleRecoveries: 1, now: () => 10_000 })
    await mkdir(lock, { recursive: true })
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ token: 'dead', pid: 999_999_999, acquiredAt: 0 }))
    const lease = await cache.acquireLease('catalog', new AbortController().signal)
    await lease.release()
    await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('recovers an ownerless lock left by a crash before owner metadata', async () => {
    const directory = await root(); const leaseName = createHash('sha256').update('catalog').digest('hex')
    const lock = join(directory, 'leases', `${leaseName}.lock`); await mkdir(lock, { recursive: true }); await utimes(lock, 0, 0)
    const cache = new NodeFilesystemModuleDownloaderCache(directory, { staleLeaseMs: 1, leasePollMs: 5, now: () => 10_000 })
    const lease = await cache.acquireLease('catalog', new AbortController().signal); await lease.release()
    await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not delete a replacement owner after a stale-read pathname ABA', async () => {
    const directory = await root(); const leaseName = createHash('sha256').update('catalog').digest('hex')
    const lock = join(directory, 'leases', `${leaseName}.lock`); await mkdir(lock, { recursive: true })
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ token: 'dead', pid: 999_999_999, acquiredAt: 0 }))
    const gate = join(directory, 'continue'); const fixture = join(import.meta.dir, 'testing', 'lease-aba-child.ts')
    const recoverer = child(fixture, directory, gate); await recoverer.until('before-stale-rename')
    await rm(lock, { recursive: true })
    const replacementFixture = join(import.meta.dir, 'testing', 'lease-child.ts')
    const replacement = child(replacementFixture, directory, 'catalog', '100'); await replacement.until('acquired:')
    const replacementOwner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'))
    await writeFile(gate, 'continue'); await replacement.done
    await recoverer.done
    expect(recoverer.output()).toContain('recoverer-acquired')
    expect(replacementOwner.pid).not.toBe(process.pid)
  })

  it('makes catalog compare-and-swap atomic without a caller-held lease', async () => {
    const directory = await root(); const left = new NodeFilesystemModuleDownloaderCache(directory); const right = new NodeFilesystemModuleDownloaderCache(directory)
    const first = catalogRecord(1, 1); const second = catalogRecord(1, 2)
    await Promise.all([left.stageCatalog(first), right.stageCatalog(second)])
    const results = await Promise.all([left.publishCatalog(undefined), right.publishCatalog(undefined)])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect((await left.readCatalog())?.trustState.highestSequence).toBe(1)
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

  it('keeps catalog envelope and trust state in one durable committed file', async () => {
    const directory = await root()
    const cache = new NodeFilesystemModuleDownloaderCache(directory)
    const record = { sourceUrl: 'https://example.test/catalog', responseBytes: new Uint8Array([1, 2]), expiresAt: '2030-01-01T00:00:00.000Z', trustState: { highestSequence: 1, latestIssuedAt: '2029-01-01T00:00:00.000Z' }, committedAt: 1 }
    await cache.stageCatalog(record)
    expect(await cache.publishCatalog(undefined)).toBe(true)
    const wire = JSON.parse(await readFile(join(directory, 'catalog', 'committed.json'), 'utf8'))
    expect(wire.responseBytesBase64).toBe('AQI=')
    expect(wire.trustState).toEqual(record.trustState)
    expect(await cache.readStagedCatalog()).toBeUndefined()
  })

  it('recovers old or complete new catalog state at every durable transaction crash point', async () => {
    for (const point of ['temp-write', 'file-sync', 'rename', 'directory-sync', 'cleanup'] as NodeCacheFaultPoint[]) {
      const directory = await root(); const baseline = new NodeFilesystemModuleDownloaderCache(directory); const first = catalogRecord(1, 1)
      await baseline.stageCatalog(first); expect(await baseline.publishCatalog(undefined)).toBe(true)
      let armed = false
      const faulted = new NodeFilesystemModuleDownloaderCache(directory, { faultInjector(candidate, path) { if (armed && candidate === point && (path.includes('committed.json') || (candidate === 'directory-sync' && path.endsWith('catalog')))) throw new Error(`crash:${point}`) } })
      const second = catalogRecord(2, 2); await faulted.stageCatalog(second); armed = true
      await expect(faulted.publishCatalog(first.trustState)).rejects.toThrow(`crash:${point}`)
      const recovered = await new NodeFilesystemModuleDownloaderCache(directory).readCatalog()
      if (!recovered) throw new Error('Catalog transaction disappeared')
      expect([1, 2]).toContain(recovered?.trustState.highestSequence)
      expect(recovered.responseBytes[0]).toBe(recovered.trustState.highestSequence)
    }
  })

  it('reports the platform durability protocol without claiming Windows directory fsync', async () => {
    const cache = new NodeFilesystemModuleDownloaderCache(await root())
    await cache.readCatalog()
    expect(cache.durability).toBe(process.platform === 'win32' ? 'file-fsync-and-recovery-marker' : 'file-and-directory-fsync')
  })

  it('bounds startup pruning of stale staging and orphan partial files', async () => {
    const directory = await root()
    const staging = join(directory, 'artifacts', '.dead.tmp')
    const orphan = join(directory, 'partials', '00000000-0000-4000-8000-000000000000.bin')
    await mkdir(staging, { recursive: true }); await mkdir(join(directory, 'partials'), { recursive: true }); await writeFile(orphan, 'x')
    await utimes(staging, 0, 0); await utimes(orphan, 0, 0)
    const cache = new NodeFilesystemModuleDownloaderCache(directory, { staleLeaseMs: 1, maxStartupPrunes: 1, now: () => 10_000 })
    await cache.listPartials()
    const survivors = await Promise.all([stat(staging).then(() => true, () => false), stat(orphan).then(() => true, () => false)])
    expect(survivors.filter(Boolean)).toHaveLength(1)
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
async function readdirNames(path: string): Promise<string[]> { return (await import('node:fs/promises')).readdir(path).then((names) => names.sort()) }
