import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import type { ModuleId, ModuleSha256, ModuleVersion } from '@simulator/module-contract'
import { ModuleInstaller } from '../installer.ts'
import { ModuleInstallerError, SimulatedInstallerCrash, type InstallLimits, type InstallerFaultPoint } from '../types.ts'
import {
  buildTarGz,
  descriptor,
  sha256,
  VALID_ENTRIES,
  writeArtifact,
  type TarFixtureEntry,
} from './archive-fixture.ts'

const roots: string[] = []
const MODULE_ID = 'org.simulator.fixture' as ModuleId

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'simulator-module-installer-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function artifactAt(root: string, entries: readonly TarFixtureEntry[] = VALID_ENTRIES): Promise<{ path: string; archive: Buffer }> {
  const path = join(root, 'fixture.tar.gz')
  return { path, archive: await writeArtifact(path, entries) }
}

describe('ModuleInstaller production tar.gz path', () => {
  it('installs a deterministic verified artifact and reports monotonic progress', async () => {
    const root = await tempRoot()
    const source = await artifactAt(root)
    const progress: number[] = []
    const installer = new ModuleInstaller(join(root, 'modules-root'))
    const result = await installer.install({
      descriptor: descriptor(source.archive, VALID_ENTRIES),
      archivePath: source.path,
      onProgress: (event) => progress.push(event.completed),
    })

    expect(result.activeVersion).toBe('1.0.0' as ModuleVersion)
    expect(result.lastKnownGoodVersion).toBeNull()
    expect(await readFile(join(result.installedPath, 'data.txt'), 'utf8')).toBe('deterministic fixture\n')
    expect(progress[0]).toBe(0)
    expect(progress.at(-1)).toBe(100)
    expect(progress.every((value, index) => index === 0 || value >= progress[index - 1]!)).toBe(true)
    expect(await installer.getState(MODULE_ID)).toEqual({
      moduleId: MODULE_ID,
      activeVersion: '1.0.0' as ModuleVersion,
      lastKnownGoodVersion: null,
    })
  })

  it('uses one global UTF-8 path order for extracted manifest hashing', async () => {
    const root = await tempRoot()
    const entries = [
      ...VALID_ENTRIES,
      { path: 'module/a', type: '5', mode: 0o755 },
      { path: 'module/a/child', content: 'child' },
      { path: 'module/a.txt', content: 'sibling' },
    ] as const satisfies readonly TarFixtureEntry[]
    const source = await artifactAt(root, entries)
    const result = await new ModuleInstaller(join(root, 'modules-root')).install({
      descriptor: descriptor(source.archive, entries),
      archivePath: source.path,
    })
    expect(result.extractedManifestSha256).toBe(descriptor(source.archive, entries).extractedManifestSha256)
  })

  it('retains LKG, rolls back atomically, and protects active/LKG/in-use versions from uninstall', async () => {
    const root = await tempRoot()
    const installer = new ModuleInstaller(join(root, 'modules-root'))
    const source = await artifactAt(root)

    await installer.install({ descriptor: descriptor(source.archive, VALID_ENTRIES, '1.0.0'), archivePath: source.path })
    await installer.install({ descriptor: descriptor(source.archive, VALID_ENTRIES, '2.0.0'), archivePath: source.path })
    expect(await installer.getState(MODULE_ID)).toMatchObject({ activeVersion: '2.0.0', lastKnownGoodVersion: '1.0.0' })
    await expect(installer.uninstall({ moduleId: MODULE_ID, version: '1.0.0' as ModuleVersion })).rejects.toMatchObject({ code: 'PROTECTED_VERSION' })

    const rolledBack = await installer.rollback(MODULE_ID)
    expect(rolledBack).toMatchObject({ activeVersion: '1.0.0', lastKnownGoodVersion: '2.0.0' })
    await installer.install({ descriptor: descriptor(source.archive, VALID_ENTRIES, '3.0.0'), archivePath: source.path })
    await expect(installer.uninstall({
      moduleId: MODULE_ID,
      version: '2.0.0' as ModuleVersion,
      inUseVersions: new Set(['2.0.0']),
    })).rejects.toMatchObject({ code: 'PROTECTED_VERSION' })
    await installer.uninstall({ moduleId: MODULE_ID, version: '2.0.0' as ModuleVersion })
  })

  it('rejects archive and extracted-manifest hash mismatches without changing active state', async () => {
    const root = await tempRoot()
    const source = await artifactAt(root)
    const installer = new ModuleInstaller(join(root, 'modules-root'))
    const valid = descriptor(source.archive, VALID_ENTRIES)
    const badArchive = {
      ...valid,
      manifest: {
        ...valid.manifest,
        artifacts: [{ ...valid.artifact, sha256: '0'.repeat(64) as ModuleSha256 }],
      },
      artifact: { ...valid.artifact, sha256: '0'.repeat(64) as ModuleSha256 },
    }
    await expect(installer.install({ descriptor: badArchive, archivePath: source.path })).rejects.toMatchObject({ code: 'ARCHIVE_HASH_MISMATCH' })
    expect((await installer.getState(MODULE_ID)).activeVersion).toBeNull()

    const badTree = { ...valid, extractedManifestSha256: 'f'.repeat(64) as ModuleSha256 }
    await expect(installer.install({ descriptor: badTree, archivePath: source.path })).rejects.toMatchObject({ code: 'TREE_HASH_MISMATCH' })
    expect((await installer.getState(MODULE_ID)).activeVersion).toBeNull()
  })

  it('cancels during extraction without publishing or activating a version', async () => {
    const root = await tempRoot()
    const source = await artifactAt(root)
    const controller = new AbortController()
    const installer = new ModuleInstaller(join(root, 'modules-root'))
    await expect(installer.install({
      descriptor: descriptor(source.archive, VALID_ENTRIES),
      archivePath: source.path,
      signal: controller.signal,
      onProgress(event) {
        if (event.phase === 'extracting') controller.abort()
      },
    })).rejects.toMatchObject({ code: 'ABORTED' })
    expect((await installer.getState(MODULE_ID)).activeVersion).toBeNull()
  })
})

describe('malicious archive matrix', () => {
  const malicious: ReadonlyArray<{ name: string; entries: readonly TarFixtureEntry[] }> = [
    { name: 'traversal', entries: [{ path: 'module/../escape', content: 'x' }] },
    { name: 'absolute path', entries: [{ path: '/module/bin/module', mode: 0o755, content: 'x' }] },
    { name: 'Windows drive path', entries: [{ path: 'C:/module/bin/module', mode: 0o755, content: 'x' }] },
    { name: 'Windows backslash', entries: [{ path: 'module\\bin\\module', mode: 0o755, content: 'x' }] },
    { name: 'unexpected top-level layout', entries: [{ path: 'payload/bin/module', mode: 0o755, content: 'x' }] },
    { name: 'duplicate path', entries: [...VALID_ENTRIES, { path: 'module/data.txt', content: 'again' }] },
    { name: 'case-fold collision', entries: [...VALID_ENTRIES, { path: 'module/DATA.txt', content: 'again' }] },
    { name: 'Unicode normalization collision', entries: [...VALID_ENTRIES, { path: 'module/d\u0061\u0301ta', content: 'a' }, { path: 'module/d\u00e1ta', content: 'b' }] },
    { name: 'symbolic link', entries: [...VALID_ENTRIES, { path: 'module/link', type: '2', linkpath: '../../escape' }] },
    { name: 'hard link', entries: [...VALID_ENTRIES, { path: 'module/link', type: '1', linkpath: '../../escape' }] },
    { name: 'character device', entries: [...VALID_ENTRIES, { path: 'module/device', type: '3' }] },
    { name: 'block device', entries: [...VALID_ENTRIES, { path: 'module/device', type: '4' }] },
    { name: 'FIFO', entries: [...VALID_ENTRIES, { path: 'module/fifo', type: '6' }] },
    { name: 'contiguous/special file', entries: [...VALID_ENTRIES, { path: 'module/special', type: '7' }] },
    { name: 'extra executable', entries: [...VALID_ENTRIES, { path: 'module/helper', mode: 0o755, content: 'x' }] },
  ]

  for (const fixture of malicious) {
    it(`rejects ${fixture.name}`, async () => {
      const root = await tempRoot()
      const source = await artifactAt(root, fixture.entries)
      const installer = new ModuleInstaller(join(root, 'modules-root'))
      await expect(installer.install({
        descriptor: descriptor(source.archive, fixture.entries),
        archivePath: source.path,
      })).rejects.toBeInstanceOf(ModuleInstallerError)
      expect((await installer.getState(MODULE_ID)).activeVersion).toBeNull()
    })
  }

  it('rejects zip input as an unsupported production format before parsing', async () => {
    const root = await tempRoot()
    const path = join(root, 'fixture.zip')
    const zip = Buffer.from('504b030414000000000000000000000000000000000000000000000000', 'hex')
    await writeFile(path, zip)
    const valid = descriptor(zip, VALID_ENTRIES)
    const installer = new ModuleInstaller(join(root, 'modules-root'))
    await expect(installer.install({ descriptor: valid, archivePath: path })).rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' })
  })

  it('rejects malformed headers and truncated gzip streams', async () => {
    const root = await tempRoot()
    const validTar = gunzipSync(buildTarGz(VALID_ENTRIES))
    validTar[0] = validTar[0]! ^ 0xff
    const malformed = gzipSync(validTar)
    const malformedPath = join(root, 'malformed.tar.gz')
    await writeFile(malformedPath, malformed)
    const installer = new ModuleInstaller(join(root, 'modules-root'))
    await expect(installer.install({ descriptor: descriptor(malformed, VALID_ENTRIES), archivePath: malformedPath })).rejects.toMatchObject({ code: 'ARCHIVE_INVALID' })

    const truncated = buildTarGz(VALID_ENTRIES).subarray(0, 24)
    const truncatedPath = join(root, 'truncated.tar.gz')
    await writeFile(truncatedPath, truncated)
    await expect(installer.install({ descriptor: descriptor(truncated, VALID_ENTRIES), archivePath: truncatedPath })).rejects.toMatchObject({ code: 'ARCHIVE_INVALID' })
  })

  it('enforces compressed size, entry count, file size, total bytes, path and depth limits', async () => {
    const cases: ReadonlyArray<{ limits: Partial<InstallLimits>; entries: readonly TarFixtureEntry[] }> = [
      { limits: { maxArchiveBytes: 8 }, entries: VALID_ENTRIES },
      { limits: { maxEntries: 2 }, entries: VALID_ENTRIES },
      { limits: { maxFileBytes: 4 }, entries: VALID_ENTRIES },
      { limits: { maxTotalBytes: 10 }, entries: VALID_ENTRIES },
      { limits: { maxPathBytes: 12 }, entries: VALID_ENTRIES },
      { limits: { maxDepth: 1 }, entries: VALID_ENTRIES },
    ]
    for (const [index, fixture] of cases.entries()) {
      const root = await tempRoot()
      const source = await artifactAt(root, fixture.entries)
      const installer = new ModuleInstaller(join(root, `modules-root-${index}`), { limits: fixture.limits })
      await expect(installer.install({ descriptor: descriptor(source.archive, fixture.entries), archivePath: source.path })).rejects.toMatchObject({ code: 'ARCHIVE_LIMIT_EXCEEDED' })
    }
  })

  it('rejects a high-ratio gzip tar bomb before extraction', async () => {
    const root = await tempRoot()
    const entries = [
      ...VALID_ENTRIES,
      { path: 'module/repetitive.bin', content: '0'.repeat(1024 * 1024) },
    ] as const satisfies readonly TarFixtureEntry[]
    const source = await artifactAt(root, entries)
    const installer = new ModuleInstaller(join(root, 'modules-root'), {
      limits: { maxDecompressionRatio: 2, maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024 },
    })
    await expect(installer.install({ descriptor: descriptor(source.archive, entries), archivePath: source.path })).rejects.toMatchObject({ code: 'ARCHIVE_INVALID' })
  })
})

describe('transaction fault injection and recovery', () => {
  it('uses an exclusive filesystem journal across installer instances', async () => {
    const root = await tempRoot()
    const source = await artifactAt(root)
    const moduleRoot = join(root, 'modules-root')
    let release!: () => void
    let journalClaimed!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const claimed = new Promise<void>((resolve) => { journalClaimed = resolve })
    const first = new ModuleInstaller(moduleRoot, {
      async faultInjector(point) {
        if (point === 'after-journal-prepared') {
          journalClaimed()
          await gate
        }
      },
    })
    const firstInstall = first.install({ descriptor: descriptor(source.archive, VALID_ENTRIES, '1.0.0'), archivePath: source.path })
    await claimed
    const second = new ModuleInstaller(moduleRoot)
    try {
      await expect(second.install({ descriptor: descriptor(source.archive, VALID_ENTRIES, '2.0.0'), archivePath: source.path })).rejects.toMatchObject({ code: 'BUSY' })
    } finally {
      release()
    }
    await firstInstall
  })

  for (const point of ['before-content-fsync', 'before-publish-rename', 'before-state-rename'] as const) {
    it(`${point} failure preserves the previous active version`, async () => {
      const root = await tempRoot()
      const source = await artifactAt(root)
      const moduleRoot = join(root, 'modules-root')
      await new ModuleInstaller(moduleRoot).install({ descriptor: descriptor(source.archive, VALID_ENTRIES, '1.0.0'), archivePath: source.path })
      let fired = false
      const installer = new ModuleInstaller(moduleRoot, {
        faultInjector(candidate) {
          if (!fired && candidate === point) {
            fired = true
            const error = new Error(`Injected ${point}`) as NodeJS.ErrnoException
            error.code = point === 'before-content-fsync' ? 'ENOSPC' : 'EIO'
            throw error
          }
        },
      })
      await expect(installer.install({ descriptor: descriptor(source.archive, VALID_ENTRIES, '2.0.0'), archivePath: source.path })).rejects.toMatchObject({ code: 'FILESYSTEM_ERROR' })
      expect(await new ModuleInstaller(moduleRoot).getState(MODULE_ID)).toMatchObject({ activeVersion: '1.0.0', lastKnownGoodVersion: null })
    })
  }

  const crashCases: ReadonlyArray<{ point: InstallerFaultPoint; activeAfterRecovery: string | null }> = [
    { point: 'after-journal-prepared', activeAfterRecovery: null },
    { point: 'after-version-published', activeAfterRecovery: null },
    { point: 'after-state-activated', activeAfterRecovery: '1.0.0' },
  ]

  for (const fixture of crashCases) {
    it(`recovers deterministically after crash at ${fixture.point}`, async () => {
      const root = await tempRoot()
      const source = await artifactAt(root)
      const moduleRoot = join(root, 'modules-root')
      const crashing = new ModuleInstaller(moduleRoot, {
        faultInjector(point) {
          if (point === fixture.point) throw new SimulatedInstallerCrash(point)
        },
      })
      await expect(crashing.install({ descriptor: descriptor(source.archive, VALID_ENTRIES), archivePath: source.path })).rejects.toBeInstanceOf(SimulatedInstallerCrash)

      const recovered = new ModuleInstaller(moduleRoot)
      await recovered.recover(MODULE_ID)
      expect((await recovered.getState(MODULE_ID)).activeVersion as string | null).toBe(fixture.activeAfterRecovery)
      expect(await Bun.file(join(moduleRoot, 'modules', MODULE_ID, 'transaction.json')).exists()).toBe(false)
    })
  }

  it('treats a durable state switch as committed when cleanup is interrupted', async () => {
    const root = await tempRoot()
    const source = await artifactAt(root)
    const moduleRoot = join(root, 'modules-root')
    let fired = false
    const installer = new ModuleInstaller(moduleRoot, {
      faultInjector(point) {
        if (!fired && point === 'after-state-activated') {
          fired = true
          throw new Error('cleanup interruption')
        }
      },
    })
    const result = await installer.install({ descriptor: descriptor(source.archive, VALID_ENTRIES), archivePath: source.path })
    expect(result.activeVersion).toBe('1.0.0' as ModuleVersion)
    expect(await Bun.file(join(moduleRoot, 'modules', MODULE_ID, 'transaction.json')).exists()).toBe(false)
    expect(await Bun.file(join(moduleRoot, 'modules', MODULE_ID, 'transaction.recovering.json')).exists()).toBe(false)
  })

  it('rejects concurrent recovery and explicitly resumes an interrupted recovery owner', async () => {
    const root = await tempRoot()
    const source = await artifactAt(root)
    const moduleRoot = join(root, 'modules-root')
    const crashingInstall = new ModuleInstaller(moduleRoot, {
      faultInjector(point) {
        if (point === 'after-journal-prepared') throw new SimulatedInstallerCrash(point)
      },
    })
    await expect(crashingInstall.install({ descriptor: descriptor(source.archive, VALID_ENTRIES), archivePath: source.path })).rejects.toBeInstanceOf(SimulatedInstallerCrash)

    const crashingRecovery = new ModuleInstaller(moduleRoot, {
      faultInjector(point) {
        if (point === 'after-recovery-claimed') throw new SimulatedInstallerCrash(point)
      },
    })
    await expect(crashingRecovery.recover(MODULE_ID)).rejects.toBeInstanceOf(SimulatedInstallerCrash)
    const nextOwner = new ModuleInstaller(moduleRoot)
    await expect(nextOwner.recover(MODULE_ID)).rejects.toMatchObject({ code: 'BUSY' })
    await nextOwner.recoverInterrupted(MODULE_ID)
    expect((await nextOwner.getState(MODULE_ID)).activeVersion).toBeNull()
  })

  it('quarantines malformed journal state instead of following untrusted paths', async () => {
    const root = await tempRoot()
    const moduleRoot = join(root, 'modules-root')
    const installer = new ModuleInstaller(moduleRoot)
    const moduleDirectory = join(moduleRoot, 'modules', MODULE_ID)
    await mkdir(moduleDirectory, { recursive: true })
    await writeFile(join(moduleDirectory, 'transaction.json'), JSON.stringify({ transactionId: '../../escape' }))
    await expect(installer.recover(MODULE_ID)).rejects.toMatchObject({ code: 'JOURNAL_INVALID' })
  })
})

describe('descriptor and root validation', () => {
  it('rejects unverified descriptors and symlink archive sources', async () => {
    const root = await tempRoot()
    const source = await artifactAt(root)
    const valid = descriptor(source.archive, VALID_ENTRIES)
    const installer = new ModuleInstaller(join(root, 'modules-root'))
    await expect(installer.install({ descriptor: { ...valid, verified: false } as never, archivePath: source.path })).rejects.toMatchObject({ code: 'DESCRIPTOR_INVALID' })
    const linkedArchive = join(root, 'linked.tar.gz')
    await symlink(source.path, linkedArchive)
    await expect(installer.install({ descriptor: valid, archivePath: linkedArchive })).rejects.toMatchObject({ code: 'ARCHIVE_INVALID' })
  })

  it('computes fixture hashes deterministically', () => {
    expect(sha256('same')).toBe(sha256('same'))
  })
})
