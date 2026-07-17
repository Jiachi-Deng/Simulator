import { afterEach, describe, expect, it } from 'bun:test'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  createOpenDesignM1H1ConnectionEvidence,
  validateOpenDesignM1H1ConnectionEvidence,
  type H1ConnectionAuthority,
  type H1ConnectionInstance,
  type H1ConnectionProbeDependencies,
} from './open-design-m1-h1-connection-evidence'
import { sha256 } from './open-design-m1-local-evidence'

const roots: string[] = []

const authority: H1ConnectionAuthority = Object.freeze({
  sourceSha: '1234567890abcdef1234567890abcdef12345678',
  hostBuildRunId: 8_001,
  hostArtifactSha256: 'a'.repeat(64),
})

interface Fixture {
  readonly parent: string
  readonly outputRoot: string
  readonly appBundle: string
  readonly executable: string
  readonly profile: string
  readonly instance: H1ConnectionInstance
  readonly dependencies: H1ConnectionProbeDependencies
}

async function fixture(): Promise<Fixture> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'open-design-m1-h1-test-')))
  roots.push(parent)
  await chmod(parent, 0o700)
  const appBundle = join(parent, 'Simulator H1.app')
  const executable = join(appBundle, 'Contents', 'MacOS', 'Simulator')
  const resources = join(appBundle, 'Contents', 'Resources', 'app.asar', 'dist', 'renderer')
  const profile = join(parent, 'profile')
  await mkdir(join(appBundle, 'Contents', 'MacOS'), { recursive: true, mode: 0o700 })
  await mkdir(resources, { recursive: true, mode: 0o700 })
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await chmod(executable, 0o755)
  await mkdir(profile, { mode: 0o700 })
  await chmod(profile, 0o700)
  const instance: H1ConnectionInstance = {
    appBundleRealpath: appBundle,
    executableRealpath: executable,
    mainPid: 42_001,
    profileRealpath: profile,
    cdpPort: 9_451,
  }
  const rendererUrl = pathToFileURL(join(resources, 'index.html'))
  rendererUrl.searchParams.set('workspaceId', '221fe607-bb99-a236-3308-f2e0ced471f5')
  const target = {
    id: 'craft-renderer',
    type: 'page',
    url: rendererUrl.href,
    webSocketDebuggerUrl: `ws://127.0.0.1:${instance.cdpPort}/devtools/page/craft-renderer`,
  }
  const dependencies: H1ConnectionProbeDependencies = {
    inspectProcess: async () => ({
      pid: instance.mainPid,
      uid: typeof process.getuid === 'function' ? process.getuid() : 501,
      parentPid: 1,
      executableRealpath: executable,
      commandLine: `${executable} --remote-debugging-port=${instance.cdpPort} --user-data-dir=${profile}`,
      loopbackListeningPorts: [instance.cdpPort],
    }),
    discoverTargets: async () => [target],
    readAuthenticatedConnectionsPresent: async () => true,
  }
  return {
    parent,
    outputRoot: join(parent, 'h1-evidence'),
    appBundle,
    executable,
    profile,
    instance,
    dependencies,
  }
}

async function produce(): Promise<Fixture> {
  const value = await fixture()
  await createOpenDesignM1H1ConnectionEvidence(
    value.outputRoot,
    authority,
    value.instance,
    value.dependencies,
  )
  return value
}

async function reseal(root: string): Promise<void> {
  const proof = await readFile(join(root, 'h1-connection.json'))
  await writeFile(join(root, 'SHA256SUMS'), `${sha256(proof)}  h1-connection.json\n`, { mode: 0o600 })
  await chmod(join(root, 'SHA256SUMS'), 0o600)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('OpenDesign M1 H1 dedicated connection evidence', () => {
  it('atomically seals only the exact authority, dedicated instance, and privacy-safe booleans', async () => {
    const value = await produce()
    const result = await validateOpenDesignM1H1ConnectionEvidence(value.outputRoot, authority, value.instance)
    expect(result).toEqual({
      objectPath: 'h1-connection.json',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      observedAt: expect.stringMatching(/Z$/),
      authenticatedConnectionsPresent: true,
      verifierDidNotSendTurn: true,
    })
    expect((await readdir(value.outputRoot)).sort()).toEqual(['SHA256SUMS', 'h1-connection.json'])
    const source = await readFile(join(value.outputRoot, 'h1-connection.json'), 'utf8')
    const proof = JSON.parse(source)
    expect(source).toBe(`${JSON.stringify(proof)}\n`)
    expect(Object.keys(proof.observation).sort()).toEqual([
      'authenticatedConnectionsPresent', 'observedAt', 'verifierDidNotSendTurn',
    ])
    expect(source).not.toContain('provider')
    expect(source).not.toContain('person@example.com')
    expect(source).not.toContain('connection-id')
    expect(source).not.toContain('secret-value')
  })

  it('does not publish a proof for a fake PID, wrong executable, profile, or CDP listener', async () => {
    const cases: Array<(value: Fixture) => H1ConnectionProbeDependencies> = [
      (value) => ({
        ...value.dependencies,
        inspectProcess: async () => ({
          ...(await value.dependencies.inspectProcess(value.instance.mainPid)),
          pid: value.instance.mainPid + 1,
        }),
      }),
      (value) => ({
        ...value.dependencies,
        inspectProcess: async () => ({
          ...(await value.dependencies.inspectProcess(value.instance.mainPid)),
          executableRealpath: join(value.appBundle, 'Contents', 'MacOS', 'Other'),
        }),
      }),
      (value) => ({
        ...value.dependencies,
        inspectProcess: async () => ({
          ...(await value.dependencies.inspectProcess(value.instance.mainPid)),
          commandLine: `${value.executable} --remote-debugging-port=${value.instance.cdpPort} --user-data-dir=/tmp/other`,
        }),
      }),
      (value) => ({
        ...value.dependencies,
        inspectProcess: async () => ({
          ...(await value.dependencies.inspectProcess(value.instance.mainPid)),
          loopbackListeningPorts: [],
        }),
      }),
      (value) => ({
        ...value.dependencies,
        inspectProcess: async () => ({
          ...(await value.dependencies.inspectProcess(value.instance.mainPid)),
          commandLine: `${value.executable} --remote-debugging-port=${value.instance.cdpPort} `
            + `--user-data-dir=${value.instance.profileRealpath}-suffix`,
        }),
      }),
      (value) => ({
        ...value.dependencies,
        inspectProcess: async () => ({
          ...(await value.dependencies.inspectProcess(value.instance.mainPid)),
          commandLine: `${value.executable} --remote-debugging-port=${value.instance.cdpPort} `
            + `--remote-debugging-port=${value.instance.cdpPort} --user-data-dir=${value.instance.profileRealpath}`,
        }),
      }),
    ]
    for (const mutate of cases) {
      const value = await fixture()
      await expect(createOpenDesignM1H1ConnectionEvidence(
        value.outputRoot,
        authority,
        value.instance,
        mutate(value),
      )).rejects.toThrow('dedicated process identity')
      expect(await readdir(value.parent)).not.toContain('h1-evidence')
      expect((await readdir(value.parent)).some((name) => name.includes('.tmp-'))).toBe(false)
    }
  })

  it('fails closed when CDP discovery, target identity, or connection evaluation fails', async () => {
    const noTarget = await fixture()
    await expect(createOpenDesignM1H1ConnectionEvidence(
      noTarget.outputRoot,
      authority,
      noTarget.instance,
      { ...noTarget.dependencies, discoverTargets: async () => [] },
    )).rejects.toThrow('dedicated Craft CDP target')
    expect(await readdir(noTarget.parent)).not.toContain('h1-evidence')

    const wrongSocket = await fixture()
    const wrongSocketRendererUrl = pathToFileURL(join(
      wrongSocket.appBundle, 'Contents', 'Resources', 'app.asar', 'dist', 'renderer', 'index.html',
    ))
    wrongSocketRendererUrl.searchParams.set('workspaceId', 'ws_fixture')
    await expect(createOpenDesignM1H1ConnectionEvidence(
      wrongSocket.outputRoot,
      authority,
      wrongSocket.instance,
      {
        ...wrongSocket.dependencies,
        discoverTargets: async () => [{
          id: 'craft-renderer',
          type: 'page',
          url: wrongSocketRendererUrl.href,
          webSocketDebuggerUrl: 'ws://127.0.0.1:9999/devtools/page/craft-renderer',
        }],
      },
    )).rejects.toThrow('dedicated Craft CDP target')

    const falseConnection = await fixture()
    await expect(createOpenDesignM1H1ConnectionEvidence(
      falseConnection.outputRoot,
      authority,
      falseConnection.instance,
      { ...falseConnection.dependencies, readAuthenticatedConnectionsPresent: async () => false },
    )).rejects.toThrow('authenticatedConnectionsPresent')
    expect(await readdir(falseConnection.parent)).not.toContain('h1-evidence')

    const cdpFailure = await fixture()
    await expect(createOpenDesignM1H1ConnectionEvidence(
      cdpFailure.outputRoot,
      authority,
      cdpFailure.instance,
      { ...cdpFailure.dependencies, readAuthenticatedConnectionsPresent: async () => { throw new Error('offline') } },
    )).rejects.toThrow('offline')
    expect(await readdir(cdpFailure.parent)).not.toContain('h1-evidence')
  })

  it('requires the packaged renderer canonical single workspaceId query', async () => {
    const invalidQueries = [
      '',
      '?workspace=ws_fixture',
      '?workspaceId=',
      '?workspaceId=ws_fixture&debug=1',
      '?workspaceId=ws_fixture&workspaceId=ws_other',
      '?workspaceId=../outside',
      '?workspaceId=ws_fixture#fragment',
    ]
    for (const suffix of invalidQueries) {
      const value = await fixture()
      const rendererPath = pathToFileURL(join(
        value.appBundle, 'Contents', 'Resources', 'app.asar', 'dist', 'renderer', 'index.html',
      )).href
      await expect(createOpenDesignM1H1ConnectionEvidence(
        value.outputRoot,
        authority,
        value.instance,
        {
          ...value.dependencies,
          discoverTargets: async () => [{
            id: 'craft-renderer',
            type: 'page',
            url: `${rendererPath}${suffix}`,
            webSocketDebuggerUrl: `ws://127.0.0.1:${value.instance.cdpPort}/devtools/page/craft-renderer`,
          }],
        },
      )).rejects.toThrow('dedicated Craft CDP target')
      expect(await readdir(value.parent)).not.toContain('h1-evidence')
    }
  })

  it('rejects wrong app, executable, profile, source, build, artifact, PID, and port authorities', async () => {
    const value = await produce()
    const otherApp = join(value.parent, 'Other.app')
    const otherExecutable = join(otherApp, 'Contents', 'MacOS', 'Other')
    await mkdir(join(otherApp, 'Contents', 'MacOS'), { recursive: true, mode: 0o700 })
    await writeFile(otherExecutable, '#!/bin/sh\n', { mode: 0o755 })
    await chmod(otherExecutable, 0o755)
    const otherProfile = join(value.parent, 'other-profile')
    await mkdir(otherProfile, { mode: 0o700 })

    const attempts: Array<[H1ConnectionAuthority, H1ConnectionInstance]> = [
      [{ ...authority, sourceSha: '9'.repeat(40) }, value.instance],
      [{ ...authority, hostBuildRunId: authority.hostBuildRunId + 1 }, value.instance],
      [{ ...authority, hostArtifactSha256: 'b'.repeat(64) }, value.instance],
      [authority, { ...value.instance, appBundleRealpath: otherApp, executableRealpath: otherExecutable }],
      [authority, { ...value.instance, executableRealpath: otherExecutable }],
      [authority, { ...value.instance, profileRealpath: otherProfile }],
      [authority, { ...value.instance, mainPid: value.instance.mainPid + 1 }],
      [authority, { ...value.instance, cdpPort: value.instance.cdpPort + 1 }],
    ]
    for (const [expectedAuthority, expectedInstance] of attempts) {
      await expect(validateOpenDesignM1H1ConnectionEvidence(
        value.outputRoot,
        expectedAuthority,
        expectedInstance,
      )).rejects.toThrow()
    }
  })

  it('rejects symlinks, widened permissions, partial writes, and resealed tampering', async () => {
    const linked = await produce()
    await unlink(join(linked.outputRoot, 'SHA256SUMS'))
    await symlink('h1-connection.json', join(linked.outputRoot, 'SHA256SUMS'))
    await expect(validateOpenDesignM1H1ConnectionEvidence(linked.outputRoot, authority, linked.instance))
      .rejects.toThrow('owner-only regular file')

    const permissive = await produce()
    await chmod(join(permissive.outputRoot, 'h1-connection.json'), 0o644)
    await expect(validateOpenDesignM1H1ConnectionEvidence(permissive.outputRoot, authority, permissive.instance))
      .rejects.toThrow('owner-only regular file')

    const partial = await produce()
    await writeFile(join(partial.outputRoot, 'h1-connection.json'), '{"schemaVersion":1', { mode: 0o600 })
    await expect(validateOpenDesignM1H1ConnectionEvidence(partial.outputRoot, authority, partial.instance))
      .rejects.toThrow('is not JSON')

    const tampered = await produce()
    const proofPath = join(tampered.outputRoot, 'h1-connection.json')
    const proof = JSON.parse(await readFile(proofPath, 'utf8'))
    proof.observation.verifierDidNotSendTurn = false
    await writeFile(proofPath, `${JSON.stringify(proof)}\n`, { mode: 0o600 })
    await reseal(tampered.outputRoot)
    await expect(validateOpenDesignM1H1ConnectionEvidence(tampered.outputRoot, authority, tampered.instance))
      .rejects.toThrow('observation')

    const future = await produce()
    const futureProofPath = join(future.outputRoot, 'h1-connection.json')
    const futureProof = JSON.parse(await readFile(futureProofPath, 'utf8'))
    futureProof.observation.observedAt = '2999-01-01T00:00:00.000Z'
    await writeFile(futureProofPath, `${JSON.stringify(futureProof)}\n`, { mode: 0o600 })
    await reseal(future.outputRoot)
    await expect(validateOpenDesignM1H1ConnectionEvidence(future.outputRoot, authority, future.instance))
      .rejects.toThrow('must not be in the future')
  })
})
