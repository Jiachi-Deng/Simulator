import { afterEach, describe, expect, it } from 'bun:test'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpenDesignAcceptanceRuntimeBindingReader } from '../open-design-acceptance-runtime-binding'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('OpenDesign acceptance runtime binding', () => {
  it('compares only App-owned process authority and returns no paths or lock contents', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'open-design-runtime-binding-')))
    roots.push(root)
    await chmod(root, 0o700)
    const config = join(root, 'config')
    const profile = join(root, 'profile')
    await mkdir(config, { mode: 0o700 })
    await mkdir(profile, { mode: 0o700 })
    await writeFile(join(config, '.server.lock'), JSON.stringify({ pid: 42_001, startedAt: 1_721_252_815_000 }), { mode: 0o600 })
    const read = createOpenDesignAcceptanceRuntimeBindingReader({
      configRoot: config,
      userDataRoot: profile,
      mainPid: 42_001,
      runtimeInstanceDigest: 'a'.repeat(64),
    })
    const result = read({
      profileRealpath: profile,
      configRealpath: config,
      mainPid: 42_001,
      serverPid: 42_001,
      serverLockStartedAt: 1_721_252_815_000,
    })
    expect(result).toEqual({
      schemaVersion: 1,
      configRootMatches: true,
      userDataRootMatches: true,
      mainPidMatches: true,
      serverIdentityMatches: true,
      runtimeInstanceDigest: 'a'.repeat(64),
    })
    const source = JSON.stringify(result)
    expect(source).not.toContain(root)
    expect(source).not.toContain('startedAt')
    expect(source).not.toContain('42001')
  })

  it('rejects an alternate owner-only config even when its copied lock matches the caller record', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'open-design-runtime-binding-alt-')))
    roots.push(root)
    await chmod(root, 0o700)
    const config = join(root, 'actual-config')
    const alternate = join(root, 'alternate-config')
    const profile = join(root, 'profile')
    for (const directory of [config, alternate, profile]) await mkdir(directory, { mode: 0o700 })
    const lock = JSON.stringify({ pid: 44_001, startedAt: 1_721_252_815_000 })
    await writeFile(join(config, '.server.lock'), lock, { mode: 0o600 })
    await writeFile(join(alternate, '.server.lock'), lock, { mode: 0o600 })
    const read = createOpenDesignAcceptanceRuntimeBindingReader({
      configRoot: config,
      userDataRoot: profile,
      mainPid: 44_001,
      runtimeInstanceDigest: 'b'.repeat(64),
    })
    expect(read({
      profileRealpath: profile,
      configRealpath: alternate,
      mainPid: 44_001,
      serverPid: 44_001,
      serverLockStartedAt: 1_721_252_815_000,
    })).toEqual(expect.objectContaining({
      configRootMatches: false,
      userDataRootMatches: true,
      mainPidMatches: true,
      serverIdentityMatches: true,
    }))
  })
})
