import { afterEach, describe, expect, it } from 'bun:test'
import { chmod, link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertReplaceableGeneratedShim } from '../scripts/build'

const roots: string[] = []

async function fixture(mode = 0o755): Promise<{ root: string; artifact: string }> {
  const root = await mkdtemp(join(tmpdir(), 'host-agent-shim-build-integrity-'))
  roots.push(root)
  const artifact = join(root, 'simulator-host-agent.mjs')
  await writeFile(artifact, '#!/usr/bin/env node\nconsole.log("fixture")\n', { mode })
  if (process.platform !== 'win32') await chmod(artifact, mode)
  return { root, artifact }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Host Agent shim atomic build preflight', () => {
  it('accepts a missing first-build output and a unique executable generated file', async () => {
    const { root, artifact } = await fixture()
    await expect(assertReplaceableGeneratedShim(join(root, 'missing.mjs'))).resolves.toBeUndefined()
    await expect(assertReplaceableGeneratedShim(artifact)).resolves.toBeUndefined()
  })

  it('rejects a symlink or hardlink instead of overwriting an alias', async () => {
    if (process.platform === 'win32') return
    const symlinkFixture = await fixture()
    const symlinkPath = join(symlinkFixture.root, 'shim-link.mjs')
    await symlink(symlinkFixture.artifact, symlinkPath)
    await expect(assertReplaceableGeneratedShim(symlinkPath)).rejects.toThrow('not a symbolic link')

    const hardlinkFixture = await fixture()
    const hardlinkPath = join(hardlinkFixture.root, 'shim-hardlink.mjs')
    await link(hardlinkFixture.artifact, hardlinkPath)
    await expect(assertReplaceableGeneratedShim(hardlinkPath)).rejects.toThrow('must not be a hardlink')
  })

  it('rejects a generated output that lost executable mode', async () => {
    if (process.platform === 'win32') return
    const { artifact } = await fixture(0o644)
    await expect(assertReplaceableGeneratedShim(artifact)).rejects.toThrow('executable mode 0755')
  })
})
