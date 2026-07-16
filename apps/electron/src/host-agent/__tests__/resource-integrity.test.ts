import { afterEach, describe, expect, it } from 'bun:test'
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  assertHostAgentArtifactsMatch,
  copyHostAgentShim,
  inspectHostAgentArtifact,
} from '../../../scripts/copy-assets'

const temporaryRoots: string[] = []

async function fixture(): Promise<{ root: string; source: string }> {
  const createdRoot = await mkdtemp(join(tmpdir(), 'simulator-host-agent-resource-'))
  temporaryRoots.push(createdRoot)
  const root = await realpath(createdRoot)
  const sourceDirectory = join(root, 'source')
  await mkdir(sourceDirectory)
  const source = join(sourceDirectory, 'simulator-host-agent.mjs')
  await writeFile(source, '#!/usr/bin/env node\nconsole.log("shim")\n', { mode: 0o755 })
  if (process.platform !== 'win32') await chmod(source, 0o755)
  return { root, source }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Host Agent executable resource integrity', () => {
  it('rebuilds the shim in every Electron build, dev, Windows, and package graph', async () => {
    const repositoryRoot = resolve(import.meta.dir, '../../../../..')
    const [mainBuild, devBuild, windowsBuild, packageManifest, macPackage] = await Promise.all([
      readFile(join(repositoryRoot, 'scripts/electron-build-main.ts'), 'utf8'),
      readFile(join(repositoryRoot, 'scripts/electron-dev.ts'), 'utf8'),
      readFile(join(repositoryRoot, 'scripts/build/win32.ts'), 'utf8'),
      readFile(join(repositoryRoot, 'apps/electron/package.json'), 'utf8'),
      readFile(join(repositoryRoot, 'apps/electron/scripts/build-dmg.sh'), 'utf8'),
    ])
    expect(mainBuild).toContain('rebuildAndCopyHostAgentShim(ROOT_DIR)')
    expect(devBuild).toContain('copyElectronAssets(ROOT_DIR)')
    expect(windowsBuild).toContain('rebuildAndCopyHostAgentShim(rootDir)')
    expect(windowsBuild).toContain('copyElectronAssets(rootDir)')
    expect(windowsBuild).toContain('validate-assets.ts --packaged-app')
    expect(JSON.parse(packageManifest).scripts['build:host-agent-shim']).toBe('bun scripts/copy-assets.ts')
    expect(macPackage).toContain('validate-assets.ts" --packaged-app "$APP_ROOT"')
  })

  it('copies source to dist as a unique file with identical hash, size, and mode', async () => {
    const { root, source } = await fixture()
    const destination = join(root, 'dist/host-agent/simulator-host-agent.mjs')
    const evidence = copyHostAgentShim(source, destination)

    expect(evidence.destination.sha256).toBe(evidence.source.sha256)
    expect(evidence.destination.mode).toBe(evidence.source.mode)
    expect(evidence.destination.size).toBe(evidence.source.size)
    expect(await readFile(destination, 'utf8')).toBe(await readFile(source, 'utf8'))
  })

  it('rejects a symlink, hardlink, or non-executable generated source before copy', async () => {
    if (process.platform === 'win32') return
    const symlinkFixture = await fixture()
    const symlinkPath = join(symlinkFixture.root, 'shim-link.mjs')
    await symlink(symlinkFixture.source, symlinkPath)
    expect(() => copyHostAgentShim(symlinkPath, join(symlinkFixture.root, 'dist/shim.mjs'))).toThrow(
      'regular file, not a symbolic link',
    )

    const hardlinkFixture = await fixture()
    const hardlinkPath = join(hardlinkFixture.root, 'shim-hardlink.mjs')
    await link(hardlinkFixture.source, hardlinkPath)
    expect(() => copyHostAgentShim(hardlinkPath, join(hardlinkFixture.root, 'dist/shim.mjs'))).toThrow(
      'must not be a hardlink',
    )

    const modeFixture = await fixture()
    await chmod(modeFixture.source, 0o644)
    expect(() => copyHostAgentShim(modeFixture.source, join(modeFixture.root, 'dist/shim.mjs'))).toThrow(
      'executable mode 0755',
    )

    const parentFixture = await fixture()
    const parentAlias = join(parentFixture.root, 'source-alias')
    await symlink(join(parentFixture.root, 'source'), parentAlias)
    expect(() => inspectHostAgentArtifact(
      join(parentAlias, 'simulator-host-agent.mjs'),
      'Aliased Host Agent shim',
      { executable: true },
    )).toThrow('must not traverse symbolic links')
  })

  it('detects packaged-copy content or mode drift from the generated source', async () => {
    const { root, source } = await fixture()
    const dist = join(root, 'dist/host-agent/simulator-host-agent.mjs')
    const packaged = join(root, 'Simulator.app/Contents/Resources/app/dist/resources/host-agent/simulator-host-agent.mjs')
    const copied = copyHostAgentShim(source, dist)
    const packagedCopy = copyHostAgentShim(source, packaged)
    assertHostAgentArtifactsMatch(copied.source, packagedCopy.destination, 'Packaged Host Agent shim')

    await writeFile(packaged, '#!/usr/bin/env node\nconsole.log("tampered")\n', { mode: 0o755 })
    if (process.platform !== 'win32') await chmod(packaged, 0o755)
    const changed = inspectHostAgentArtifact(packaged, 'Packaged Host Agent shim', {
      executable: true,
    })
    expect(() => assertHostAgentArtifactsMatch(copied.source, changed, 'Packaged Host Agent shim')).toThrow(
      'differs from its build source',
    )
  })
})
