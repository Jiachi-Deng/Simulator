import { afterEach, describe, expect, it } from 'bun:test'
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OwnerOnlyHostAgentTokenStore } from '../token-store'

const temporaryRoots: string[] = []

async function fixture(): Promise<{ root: string; directory: string }> {
  const root = await mkdtemp(join(tmpdir(), 'simulator-host-agent-token-store-'))
  temporaryRoots.push(root)
  const directory = join(root, 'tokens')
  await mkdir(directory, { mode: 0o700 })
  return { root, directory }
}

async function writeStale(directory: string, name: string, mode = 0o600): Promise<string> {
  const path = join(directory, name)
  await writeFile(path, 'stale-token-material', { mode })
  if (process.platform !== 'win32') await chmod(path, mode)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('OwnerOnlyHostAgentTokenStore startup cleanup', () => {
  it('removes only validated stale tokens before concurrent creates', async () => {
    const { directory } = await fixture()
    await writeStale(directory, 'v1-stale_epoch_001.token')
    await writeStale(directory, 'v2-stale_epoch_002.token')
    const store = new OwnerOnlyHostAgentTokenStore(directory)

    const [v1, v2] = await Promise.all([
      store.create('v1', 'fresh_epoch_001', 'a'.repeat(32)),
      store.create('v2', 'fresh_epoch_002', 'b'.repeat(32)),
    ])

    expect((await readdir(directory)).sort()).toEqual([
      'v1-fresh_epoch_001.token',
      'v2-fresh_epoch_002.token',
    ])
    expect(await readFile(v1, 'utf8')).toBe('a'.repeat(32))
    expect(await readFile(v2, 'utf8')).toBe('b'.repeat(32))
    if (process.platform !== 'win32') {
      expect((await lstat(directory)).mode & 0o777).toBe(0o700)
      expect((await lstat(v1)).mode & 0o777).toBe(0o600)
      expect((await lstat(v2)).mode & 0o777).toBe(0o600)
    }
  })

  it('fails without partial deletion when any directory entry has an unexpected name', async () => {
    const { directory } = await fixture()
    const valid = await writeStale(directory, 'v1-stale_epoch_003.token')
    const anomaly = await writeStale(directory, 'notes.txt')
    const store = new OwnerOnlyHostAgentTokenStore(directory)

    await expect(store.create('v1', 'fresh_epoch_003', 'c'.repeat(32))).rejects.toThrow(
      'Unexpected Host Agent token directory entry',
    )
    expect(await readFile(valid, 'utf8')).toBe('stale-token-material')
    expect(await readFile(anomaly, 'utf8')).toBe('stale-token-material')
  })

  it('rejects symlink and hardlink evidence instead of deleting outside data', async () => {
    if (process.platform === 'win32') return
    const symlinkFixture = await fixture()
    const outside = join(symlinkFixture.root, 'outside-token')
    await writeFile(outside, 'outside-evidence', { mode: 0o600 })
    await symlink(outside, join(symlinkFixture.directory, 'v1-stale_epoch_004.token'))
    const symlinkStore = new OwnerOnlyHostAgentTokenStore(symlinkFixture.directory)
    await expect(symlinkStore.create('v1', 'fresh_epoch_004', 'd'.repeat(32))).rejects.toThrow(
      'must be a unique regular file',
    )
    expect(await readFile(outside, 'utf8')).toBe('outside-evidence')

    const hardlinkFixture = await fixture()
    const hardlinkOutside = join(hardlinkFixture.root, 'hardlink-evidence')
    await writeFile(hardlinkOutside, 'hardlink-evidence', { mode: 0o600 })
    await link(hardlinkOutside, join(hardlinkFixture.directory, 'v2-stale_epoch_005.token'))
    const hardlinkStore = new OwnerOnlyHostAgentTokenStore(hardlinkFixture.directory)
    await expect(hardlinkStore.create('v2', 'fresh_epoch_005', 'e'.repeat(32))).rejects.toThrow(
      'must be a unique regular file',
    )
    expect(await readFile(hardlinkOutside, 'utf8')).toBe('hardlink-evidence')
  })

  it('rejects stale tokens that are not mode 0600', async () => {
    if (process.platform === 'win32') return
    const { directory } = await fixture()
    await writeStale(directory, 'v1-stale_epoch_006.token', 0o644)
    const store = new OwnerOnlyHostAgentTokenStore(directory)
    await expect(store.create('v1', 'fresh_epoch_006', 'f'.repeat(32))).rejects.toThrow('mode 0600')
  })

  it('rejects a symlinked token directory and removal outside its canonical root', async () => {
    if (process.platform === 'win32') return
    const { root, directory } = await fixture()
    const alias = join(root, 'token-alias')
    await symlink(directory, alias)
    const aliasedStore = new OwnerOnlyHostAgentTokenStore(alias)
    await expect(aliasedStore.create('v1', 'fresh_epoch_007', 'g'.repeat(32))).rejects.toThrow(
      'must be a real directory',
    )

    const store = new OwnerOnlyHostAgentTokenStore(directory)
    await expect(store.remove(join(root, 'v1-fresh_epoch_007.token'))).rejects.toThrow(
      'must stay inside its token directory',
    )
  })
})
