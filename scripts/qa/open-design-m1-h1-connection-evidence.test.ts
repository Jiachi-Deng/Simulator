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
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import {
  captureOpenDesignM1H1LaunchEvidence,
  createOpenDesignM1H1ConnectionEvidence,
  createOpenDesignM1H1PreflightEvidence,
  inspectOpenDesignM1H1GitHubRunAttempt,
  inspectOpenDesignM1H1ReleaseAuthority,
  inspectOpenDesignM1H1StagedApp,
  normalizeOpenDesignM1H1StagedInventory,
  validateOpenDesignM1H1ConnectionEvidence,
  validateOpenDesignM1H1PreflightEvidence,
  type H1ConnectionAuthority,
  type H1ConnectionInstance,
  type H1ConnectionProbeDependencies,
  type H1CommandRunner,
  type H1ReleaseGithubCliFixtureIo,
  type ProcessObservation,
} from './open-design-m1-h1-connection-evidence'
import { canonicalJson, sha256 } from './open-design-m1-local-evidence'

const roots: string[] = []
const NOW = Date.parse('2026-07-17T22:00:20.000Z')
const START_IDENTITY = 'Fri Jul 17 15:00:00 2026'

interface Fixture {
  readonly parent: string
  readonly preflightRoot: string
  readonly outputRoot: string
  readonly appBundle: string
  readonly executable: string
  readonly profile: string
  readonly config: string
  readonly launchEvidence: string
  readonly authorityKey: string
  readonly authority: H1ConnectionAuthority
  readonly instance: H1ConnectionInstance
  readonly mainProcess: ProcessObservation
  readonly dependencies: H1ConnectionProbeDependencies
}

function releaseAuthority(authority: H1ConnectionAuthority): Record<string, unknown> {
  return {
    sourceSha: authority.sourceSha,
    verifierRepositoryHeadSha: authority.sourceSha,
    hostBuildRunId: authority.hostBuildRunId,
    hostBuildRunAttempt: 1,
    hostArtifactId: authority.hostArtifactId,
    hostArtifactName: `simulator-${authority.rcLabel}-macos-arm64-unsigned`,
    hostArtifactDigest: authority.hostArtifactDigest,
    hostArtifactArchive: {
      realpath: authority.artifactArchiveRealpath,
      bytes: 123_456,
      sha256: authority.hostArtifactDigest.slice('sha256:'.length),
    },
    rcLabel: authority.rcLabel,
    productVersion: authority.productVersion,
    inputArtifactId: 7_999,
    inputArtifactDigest: `sha256:${'b'.repeat(64)}`,
    bundleRootRealpath: authority.bundleRootRealpath,
    dmg: { bytes: 100_001, sha256: 'c'.repeat(64) },
    zip: { bytes: 100_002, sha256: 'd'.repeat(64) },
    bundleMetadataSha256: 'e'.repeat(64),
    appInventorySha256: '1'.repeat(64),
    packagedFilesSha256: '2'.repeat(64),
    packageVerificationCodeSha256: '3'.repeat(64),
    provenanceAttestationSha256: '4'.repeat(64),
    sbomAttestationSha256: '5'.repeat(64),
  }
}

async function fixture(): Promise<Fixture> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'open-design-m1-h1-v2-test-')))
  roots.push(parent)
  await chmod(parent, 0o700)
  const appBundle = join(parent, 'Simulator H1.app')
  const executable = join(appBundle, 'Contents', 'MacOS', 'Simulator')
  const resources = join(appBundle, 'Contents', 'Resources', 'app', 'dist', 'renderer')
  const profile = join(parent, 'profile')
  const config = join(parent, 'config')
  const launchEvidence = join(parent, 'launch.json')
  const authorityKey = join(parent, 'authority-key.bin')
  const archive = join(parent, 'engineering-rc-actions-artifact.zip')
  const bundleRoot = join(parent, 'final-bundle')
  await mkdir(join(appBundle, 'Contents', 'MacOS'), { recursive: true, mode: 0o700 })
  await mkdir(resources, { recursive: true, mode: 0o700 })
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await chmod(executable, 0o755)
  await mkdir(profile, { mode: 0o700 })
  await mkdir(config, { mode: 0o700 })
  await mkdir(bundleRoot, { mode: 0o700 })
  await chmod(profile, 0o700)
  await chmod(config, 0o700)
  await chmod(bundleRoot, 0o700)
  await writeFile(archive, 'fixture archive', { mode: 0o600 })
  await chmod(archive, 0o600)
  await writeFile(authorityKey, Buffer.alloc(32, 0x42), { mode: 0o600 })
  await chmod(authorityKey, 0o600)
  const authority: H1ConnectionAuthority = Object.freeze({
    sourceSha: '1234567890abcdef1234567890abcdef12345678',
    hostBuildRunId: 8_001,
    hostArtifactId: 8_002,
    hostArtifactDigest: `sha256:${'a'.repeat(64)}`,
    rcLabel: '0.12.0-rc.5',
    productVersion: '0.12.0',
    artifactArchiveRealpath: archive,
    bundleRootRealpath: bundleRoot,
  })
  const mainPid = 42_001
  const cdpPort = 9_451
  const mainProcess: ProcessObservation = Object.freeze({
    pid: mainPid,
    uid: typeof process.getuid === 'function' ? process.getuid() : 501,
    parentPid: 1,
    executableRealpath: executable,
    commandLine: `${executable} --remote-debugging-port=${cdpPort} --user-data-dir=${profile}`,
    startIdentity: START_IDENTITY,
    startedAtMs: NOW - 20_000,
    loopbackListeningPorts: Object.freeze([cdpPort]),
  })
  await writeFile(join(config, '.server.lock'), JSON.stringify({ pid: mainPid, startedAt: NOW - 15_000 }), { mode: 0o600 })
  await chmod(join(config, '.server.lock'), 0o600)
  await writeFile(launchEvidence, canonicalJson({
    schemaVersion: 1,
    kind: 'open-design-m1-h1-launch-evidence',
    capturedAt: new Date(NOW - 10_000).toISOString(),
    appBundleRealpath: appBundle,
    executableRealpath: executable,
    mainPid,
    processStartIdentity: START_IDENTITY,
    profileRealpath: profile,
    configRealpath: config,
    cdpPort,
  }), { mode: 0o600 })
  await chmod(launchEvidence, 0o600)
  const instance: H1ConnectionInstance = Object.freeze({
    appBundleRealpath: appBundle,
    executableRealpath: executable,
    mainPid,
    profileRealpath: profile,
    configRealpath: config,
    cdpPort,
    launchEvidenceRealpath: launchEvidence,
  })
  const rendererUrl = pathToFileURL(join(resources, 'index.html'))
  rendererUrl.searchParams.set('workspaceId', '221fe607-bb99-a236-3308-f2e0ced471f5')
  const target = Object.freeze({
    id: 'craft-renderer',
    type: 'page',
    url: rendererUrl.href,
    webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/craft-renderer`,
  })
  const dependencies: H1ConnectionProbeDependencies = {
    inspectProcess: async () => mainProcess,
    listProcesses: async () => [mainProcess],
    discoverTargets: async () => [target],
    readEffectiveConnectionAuthority: async (_target, keyBase64) => {
      expect(keyBase64).toBe(Buffer.alloc(32, 0x42).toString('base64'))
      return {
        schemaVersion: 1,
        authenticated: true,
        authorityHmacSha256: '8'.repeat(64),
      }
    },
    readRuntimeBinding: async () => ({
      schemaVersion: 1,
      configRootMatches: true,
      userDataRootMatches: true,
      mainPidMatches: true,
      serverIdentityMatches: true,
      runtimeInstanceDigest: '7'.repeat(64),
    }),
    inspectReleaseAuthority: async (value) => ({
      authority: releaseAuthority(value),
      bundleFiles: {},
    }),
    inspectStagedApp: async () => ({
      appInventorySha256: '1'.repeat(64),
      rawAppInventorySha256: '1'.repeat(64),
      macOSLaunchServicesProvenanceSha256: null,
      packagedFilesSha256: '2'.repeat(64),
      packageVerificationCodeSha256: '3'.repeat(64),
      packagedFileCount: 1_998,
      codesignStrictVerified: true,
    }),
    now: () => NOW,
  }
  return {
    parent,
    preflightRoot: join(parent, 'h1-preflight'),
    outputRoot: join(parent, 'h1-connection'),
    appBundle,
    executable,
    profile,
    config,
    launchEvidence,
    authorityKey,
    authority,
    instance,
    mainProcess,
    dependencies,
  }
}

async function producePreflight(value: Fixture): Promise<void> {
  await createOpenDesignM1H1PreflightEvidence(
    value.preflightRoot, value.authority, value.instance, value.dependencies,
  )
}

async function produce(): Promise<Fixture> {
  const value = await fixture()
  await producePreflight(value)
  await createOpenDesignM1H1ConnectionEvidence(
    value.outputRoot, value.preflightRoot, value.authority, value.instance,
    value.authorityKey, value.dependencies,
  )
  return value
}

async function reseal(root: string, objectPath: string): Promise<void> {
  const proof = await readFile(join(root, objectPath))
  await writeFile(join(root, 'SHA256SUMS'), `${sha256(proof)}  ${objectPath}\n`, { mode: 0o600 })
  await chmod(join(root, 'SHA256SUMS'), 0o600)
}

interface ReleaseGlueFixture {
  readonly value: Fixture
  readonly authority: H1ConnectionAuthority
  readonly inputArtifactId: number
  readonly inputArtifactDigest: string
  readonly archiveBytes: Buffer
  readonly contents: Map<string, string>
  readonly provenanceStatement: Record<string, any>
  readonly sbom: Record<string, any>
}

async function writeReleaseContents(root: string, contents: ReadonlyMap<string, string>): Promise<void> {
  for (const [path, source] of contents) {
    const output = join(root, path)
    await mkdir(dirname(output), { recursive: true, mode: 0o700 })
    await writeFile(output, source, { mode: 0o600 })
  }
}

function releaseProvenance(
  authority: H1ConnectionAuthority,
  attempt: number,
  dmgSha256: string,
  zipSha256: string,
): Record<string, any> {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [
      { name: 'Simulator-arm64.dmg', digest: { sha256: dmgSha256 } },
      { name: 'Simulator-arm64.zip', digest: { sha256: zipSha256 } },
    ],
    predicate: {
      buildDefinition: {
        buildType: 'https://actions.github.io/buildtypes/workflow/v1',
        externalParameters: { workflow: {
          ref: 'refs/heads/main',
          repository: 'https://github.com/Jiachi-Deng/Simulator',
          path: '.github/workflows/engineering-rc.yml',
        } },
        internalParameters: { github: {
          event_name: 'workflow_dispatch',
          repository_id: '1298254148',
          runner_environment: 'github-hosted',
        } },
        resolvedDependencies: [{
          uri: 'git+https://github.com/Jiachi-Deng/Simulator@refs/heads/main',
          digest: { gitCommit: authority.sourceSha },
        }],
      },
      runDetails: {
        builder: { id: 'https://github.com/Jiachi-Deng/Simulator/.github/workflows/engineering-rc.yml@refs/heads/main' },
        metadata: { invocationId: `https://github.com/Jiachi-Deng/Simulator/actions/runs/${authority.hostBuildRunId}/attempts/${attempt}` },
      },
    },
  }
}

async function createReleaseGlueFixture(): Promise<ReleaseGlueFixture> {
  const value = await fixture()
  const inputArtifactId = 7_999
  const inputArtifactDigest = 'b'.repeat(64)
  const archiveBytes = Buffer.from('authenticated-actions-artifact-archive')
  await writeFile(value.authority.artifactArchiveRealpath, archiveBytes, { mode: 0o600 })
  const authority: H1ConnectionAuthority = Object.freeze({
    ...value.authority,
    hostArtifactDigest: `sha256:${sha256(archiveBytes)}`,
  })
  const dmg = 'dmg-bytes'
  const zip = 'zip-bytes'
  const verificationCode = 'c'.repeat(40)
  const packagedSha256 = 'd'.repeat(64)
  const packagedPath = 'Contents/MacOS/Simulator'
  const signatureObjects = [
    { path: '.', kind: 'adhoc', architectures: [], strictVerification: { required: true, exitCode: 0 } },
    ...Array.from({ length: 19 }, (_, index) => ({
      path: `Contents/Frameworks/helper-${index}.dylib`,
      kind: 'adhoc', architectures: ['arm64'], strictVerification: { required: true, exitCode: 0 },
    })),
    {
      path: packagedPath,
      kind: 'adhoc', architectures: ['arm64'], strictVerification: { required: true, exitCode: 0 },
    },
  ]
  const signatureEvidence = canonicalJson({
    ok: true,
    policy: 'unsigned-or-strictly-verified-adhoc',
    machOCount: 20,
    requiredArm64MachOPath: packagedPath,
    requiredArm64MachOFileType: 'EXECUTE',
    kinds: signatureObjects.map((entry) => entry.kind),
    objects: signatureObjects,
  })
  const sbom = {
    spdxVersion: 'SPDX-2.3',
    name: `Simulator-${authority.productVersion}`,
    packages: [{
      name: 'Simulator',
      SPDXID: 'SPDXRef-Package-Simulator',
      versionInfo: authority.productVersion,
      downloadLocation: `git+https://github.com/Jiachi-Deng/Simulator.git@${authority.sourceSha}`,
      filesAnalyzed: true,
      packageVerificationCode: { packageVerificationCodeValue: verificationCode },
      hasFiles: ['SPDXRef-File-1'],
    }],
    files: [{
      fileName: `./app/${packagedPath}`,
      SPDXID: 'SPDXRef-File-1',
      checksums: [{ algorithm: 'SHA256', checksumValue: packagedSha256 }],
    }],
    relationships: [{
      spdxElementId: 'SPDXRef-Package-Simulator',
      relationshipType: 'CONTAINS',
      relatedSpdxElement: 'SPDXRef-File-1',
    }],
  }
  const provenanceStatement = releaseProvenance(authority, 4, sha256(dmg), sha256(zip))
  const provenanceBundle = canonicalJson({
    dsseEnvelope: {
      payloadType: 'application/vnd.in-toto+json',
      payload: Buffer.from(JSON.stringify(provenanceStatement), 'utf8').toString('base64'),
    },
  })
  const contents = new Map<string, string>([
    ['RELEASE_NOTES.md', '# Simulator 0.12.0\n'],
    ['Simulator-arm64.dmg', dmg],
    ['Simulator-arm64.zip', zip],
    ['app-inventory.jsonl', '{"path":"."}\n'],
    ['attestations/provenance.sigstore.json', provenanceBundle],
    ['attestations/sbom.sigstore.json', '{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}\n'],
    ['bundle-metadata.json', canonicalJson({
      schemaVersion: 1,
      rcLabel: authority.rcLabel,
      productVersion: authority.productVersion,
      sourceSha: authority.sourceSha,
      inputArtifactId: String(inputArtifactId),
      inputArtifactDigest,
      signed: false,
      channel: 'engineering-rc',
    })],
    ['dmg-app-inventory.raw.jsonl', '{"path":"."}\n'],
    ['dmg-signatures.json', signatureEvidence],
    ['package-verification-code.txt', `${verificationCode}\n`],
    ['packaged-files.sha256', `${packagedSha256}  ${packagedPath}\n`],
    ['rc-validation.json', canonicalJson({
      schemaVersion: 1, ok: true, rcLabel: authority.rcLabel, productVersion: authority.productVersion,
      ref: authority.sourceSha, sourceSha: authority.sourceSha, mainSha: authority.sourceSha,
      checks: [{ id: 'repository.exact-main', ok: true, message: 'ok' }],
    })],
    ['sbom.spdx.json', canonicalJson(sbom)],
    ['transport-normalization-policy.json', '{"schemaVersion":1}\n'],
    ['verification-input.json', canonicalJson({
      schemaVersion: 1,
      files: [
        { name: 'Simulator-arm64.dmg', size: Buffer.byteLength(dmg), sha256: sha256(dmg) },
        { name: 'Simulator-arm64.zip', size: Buffer.byteLength(zip), sha256: sha256(zip) },
      ],
    })],
    ['zip-app-inventory.raw.jsonl', '{"path":"."}\n'],
    ['zip-signatures.json', signatureEvidence],
  ])
  const sums = [...contents.keys()].sort().map((path) => `${sha256(contents.get(path)!)}  ${path}`).join('\n')
  contents.set('SHA256SUMS', `${sums}\n`)
  await writeReleaseContents(authority.bundleRootRealpath, contents)
  return { value, authority, inputArtifactId, inputArtifactDigest, archiveBytes, contents, provenanceStatement, sbom }
}

async function rewriteReleaseContent(
  value: ReleaseGlueFixture,
  path: string,
  source: string,
): Promise<void> {
  value.contents.set(path, source)
  await writeFile(join(value.authority.bundleRootRealpath, path), source, { mode: 0o600 })
  const sums = [...value.contents.keys()]
    .filter((name) => name !== 'SHA256SUMS')
    .sort()
    .map((name) => `${sha256(value.contents.get(name)!)}  ${name}`)
    .join('\n')
  const sumsSource = `${sums}\n`
  value.contents.set('SHA256SUMS', sumsSource)
  await writeFile(join(value.authority.bundleRootRealpath, 'SHA256SUMS'), sumsSource, { mode: 0o600 })
}

interface ReleaseRunnerOptions {
  readonly mutateArtifact?: (artifact: Record<string, any>, artifactId: number) => void
  readonly mutateProvenance?: (statement: Record<string, any>, subject: string) => void
  readonly mutateSbom?: (statement: Record<string, any>) => void
  readonly mutateRunAttempt?: (run: Record<string, any>) => void
  readonly transformAttestationResponse?: (
    response: Array<{ verificationResult: { statement: Record<string, any> } }>,
    context: { readonly subject: string; readonly predicateType: string },
  ) => unknown
}

function createReleaseRunner(value: ReleaseGlueFixture, options: ReleaseRunnerOptions = {}): {
  readonly runCommand: H1CommandRunner
  readonly calls: Array<{ file: string; args: readonly string[]; label: string }>
} {
  const calls: Array<{ file: string; args: readonly string[]; label: string }> = []
  const runCommand: H1CommandRunner = async (file, args, _maximumBytes, label) => {
    calls.push({ file, args: [...args], label })
    if (file === '/usr/bin/git') return args.includes('rev-parse') ? value.authority.sourceSha : ''
    if (file === '/usr/bin/python3') {
      expect(args[1]).toBe('final')
      expect(args[2]).toBe(value.authority.artifactArchiveRealpath)
      await writeReleaseContents(args[3]!, value.contents)
      return ''
    }
    if (file !== '/opt/homebrew/bin/gh') throw new Error(`unexpected command: ${file}`)
    if (args[0] === '--version') return 'gh version 2.86.0 (2026-01-21)'
    if (args[0] === 'api') {
      expect(args.slice(0, 3)).toEqual(['api', '--hostname', 'github.com'])
      const endpoint = args[3]!
      const artifactMatch = /actions\/artifacts\/([1-9][0-9]*)$/.exec(endpoint)
      if (artifactMatch) {
        const artifactId = Number(artifactMatch[1])
        const host = artifactId === value.authority.hostArtifactId
        const artifact: Record<string, any> = {
          id: artifactId,
          name: host
            ? `simulator-${value.authority.rcLabel}-macos-arm64-unsigned`
            : `engineering-rc-input-${value.authority.rcLabel}-${value.authority.sourceSha}`,
          digest: host ? value.authority.hostArtifactDigest : `sha256:${value.inputArtifactDigest}`,
          expired: false,
          size_in_bytes: host ? value.archiveBytes.length : 123,
          workflow_run: {
            id: value.authority.hostBuildRunId,
            repository_id: 1_298_254_148,
            head_repository_id: 1_298_254_148,
            head_branch: 'main',
            head_sha: value.authority.sourceSha,
          },
        }
        options.mutateArtifact?.(artifact, artifactId)
        return JSON.stringify(artifact)
      }
      const run: Record<string, any> = {
        id: value.authority.hostBuildRunId,
        run_attempt: 4,
        event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
        head_branch: 'main', head_sha: value.authority.sourceSha,
        path: '.github/workflows/engineering-rc.yml',
        repository: { id: 1_298_254_148, full_name: 'Jiachi-Deng/Simulator' },
        head_repository: { id: 1_298_254_148, full_name: 'Jiachi-Deng/Simulator' },
      }
      options.mutateRunAttempt?.(run)
      return JSON.stringify(run)
    }
    if (args[0] === 'attestation') {
      expect(args.slice(0, 3)).toEqual(['attestation', 'verify', expect.any(String)])
      expect(args).toContain('--hostname')
      expect(args[args.indexOf('--hostname') + 1]).toBe('github.com')
      const subject = args[2]!
      const predicateType = args[args.indexOf('--predicate-type') + 1]
      let statement: Record<string, any>
      if (predicateType === 'https://slsa.dev/provenance/v1') {
        statement = structuredClone(value.provenanceStatement)
        options.mutateProvenance?.(statement, subject)
      } else {
        statement = {
          _type: 'https://in-toto.io/Statement/v1',
          predicateType: 'https://spdx.dev/Document/v2.3',
          subject: [{ name: 'Simulator-arm64.zip', digest: { sha256: sha256(value.contents.get('Simulator-arm64.zip')!) } }],
          predicate: structuredClone(value.sbom),
        }
        options.mutateSbom?.(statement)
      }
      const response = [{ verificationResult: { statement } }]
      return JSON.stringify(options.transformAttestationResponse?.(
        response,
        { subject, predicateType },
      ) ?? response)
    }
    throw new Error(`unexpected gh command: ${args.join(' ')}`)
  }
  return { runCommand, calls }
}

function githubCliFixtureIo(drift = false): H1ReleaseGithubCliFixtureIo {
  let snapshots = 0
  return {
    resolveRealpath: async (path) => {
      expect(path).toBe('/opt/homebrew/bin/gh')
      return '/fixture/homebrew/Cellar/gh/2.86.0/bin/gh'
    },
    snapshotRegularFile: async (path, maximumBytes, label) => {
      expect(path).toBe('/fixture/homebrew/Cellar/gh/2.86.0/bin/gh')
      expect(maximumBytes).toBe(128 * 1024 * 1024)
      expect(label).toBe('GitHub CLI authority')
      snapshots += 1
      return { bytes: 123_456, sha256: (drift && snapshots > 1 ? '7' : '6').repeat(64) }
    },
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('OpenDesign M1 H1 preflight v2 and Connection authority v3', () => {
  it('seals the exact release, staging, launch, and authenticated connection chain', async () => {
    const value = await produce()
    const preflightResult = await validateOpenDesignM1H1PreflightEvidence(
      value.preflightRoot, value.authority, value.instance, value.dependencies,
    )
    const connectionResult = await validateOpenDesignM1H1ConnectionEvidence(
      value.outputRoot, value.preflightRoot, value.authority, value.instance,
      value.authorityKey, value.dependencies,
    )
    expect(preflightResult).toEqual({
      objectPath: 'h1-preflight.json',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      observedAt: new Date(NOW).toISOString(),
      verifierDidNotSendTurn: true,
    })
    expect(connectionResult).toEqual({
      objectPath: 'h1-connection.json',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      observedAt: new Date(NOW).toISOString(),
      effectiveConnectionAuthenticated: true,
      authorityHmacSha256: '8'.repeat(64),
      authorityKeyCommitmentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      verifierDidNotSendTurn: true,
    })
    expect((await readdir(value.preflightRoot)).sort()).toEqual(['SHA256SUMS', 'h1-preflight.json'])
    expect((await readdir(value.outputRoot)).sort()).toEqual(['SHA256SUMS', 'h1-connection.json'])
    const preflightSource = await readFile(join(value.preflightRoot, 'h1-preflight.json'), 'utf8')
    const preflight = JSON.parse(preflightSource)
    const connectionSource = await readFile(join(value.outputRoot, 'h1-connection.json'), 'utf8')
    const connection = JSON.parse(connectionSource)
    expect(preflight.schemaVersion).toBe(2)
    expect(preflight.authority.hostArtifactDigest).toBe(value.authority.hostArtifactDigest)
    expect(preflight.authority.verifierRepositoryHeadSha).toBe(value.authority.sourceSha)
    expect(preflight.authority.dmg.sha256).toBe('c'.repeat(64))
    expect(preflight.staging.appInventorySha256).toBe(preflight.authority.appInventorySha256)
    expect(preflight.staging.rawAppInventorySha256).toBe('1'.repeat(64))
    expect(preflight.staging.macOSLaunchServicesProvenanceSha256).toBeNull()
    expect(preflight.launch.serverPid).toBe(value.instance.mainPid)
    expect(preflight.launch.workspaceId).toBe('221fe607-bb99-a236-3308-f2e0ced471f5')
    expect(connection.preflight.sha256).toBe(preflightResult.sha256)
    expect(connection.schemaVersion).toBe(3)
    expect(connection.connectionAuthority).toEqual({
      schemaVersion: 1,
      authenticated: true,
      authorityHmacSha256: '8'.repeat(64),
      authorityKeyCommitmentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(Object.keys(connection).sort()).toEqual([
      'connectionAuthority', 'kind', 'observation', 'preflight', 'schemaVersion',
    ])
    for (const forbidden of ['provider', 'person@example.com', 'connection-id', 'secret-value', 'accessToken']) {
      expect(preflightSource).not.toContain(forbidden)
      expect(connectionSource).not.toContain(forbidden)
    }
    expect(connectionSource).not.toContain(Buffer.alloc(32, 0x42).toString('base64'))
    expect(connectionSource).not.toContain(sha256(Buffer.alloc(32, 0x42)))
  })

  it('binds validation to possession of the exact owner-only authority key', async () => {
    const value = await produce()
    const wrongKey = join(value.parent, 'wrong-authority-key.bin')
    await writeFile(wrongKey, Buffer.alloc(32, 0x43), { mode: 0o600 })
    await chmod(wrongKey, 0o600)
    await expect(validateOpenDesignM1H1ConnectionEvidence(
      value.outputRoot, value.preflightRoot, value.authority, value.instance, wrongKey,
      {
        ...value.dependencies,
        readEffectiveConnectionAuthority: async () => ({
          schemaVersion: 1,
          authenticated: true,
          authorityHmacSha256: '8'.repeat(64),
        }),
      },
    )).rejects.toThrow('authenticated observation')
  })

  it('publishes nothing for process, server lock, target, or authentication failure', async () => {
    const wrongProcess = await fixture()
    await expect(createOpenDesignM1H1PreflightEvidence(
      wrongProcess.preflightRoot, wrongProcess.authority, wrongProcess.instance,
      { ...wrongProcess.dependencies, inspectProcess: async () => ({ ...wrongProcess.mainProcess, pid: 999 }) },
    )).rejects.toThrow('dedicated process identity')
    expect(await readdir(wrongProcess.parent)).not.toContain('h1-preflight')

    const wrongLock = await fixture()
    await writeFile(join(wrongLock.config, '.server.lock'), JSON.stringify({ pid: 99_999, startedAt: NOW - 1_000 }))
    await chmod(join(wrongLock.config, '.server.lock'), 0o600)
    await expect(createOpenDesignM1H1PreflightEvidence(
      wrongLock.preflightRoot, wrongLock.authority, wrongLock.instance, wrongLock.dependencies,
    )).rejects.toThrow('server lock')

    const noTarget = await fixture()
    await expect(createOpenDesignM1H1PreflightEvidence(
      noTarget.preflightRoot, noTarget.authority, noTarget.instance,
      { ...noTarget.dependencies, discoverTargets: async () => [] },
    )).rejects.toThrow('dedicated Craft CDP target')

    const noAuthentication = await fixture()
    await producePreflight(noAuthentication)
    await expect(createOpenDesignM1H1ConnectionEvidence(
      noAuthentication.outputRoot, noAuthentication.preflightRoot,
      noAuthentication.authority, noAuthentication.instance,
      noAuthentication.authorityKey,
      { ...noAuthentication.dependencies, readEffectiveConnectionAuthority: async () => {
        throw new TypeError('connection-authority RPC did not bind an authenticated effective Connection')
      } },
    )).rejects.toThrow('authenticated effective Connection')
    expect(await readdir(noAuthentication.parent)).not.toContain('h1-connection')

    const validationAuthentication = await produce()
    await expect(validateOpenDesignM1H1ConnectionEvidence(
      validationAuthentication.outputRoot, validationAuthentication.preflightRoot,
      validationAuthentication.authority, validationAuthentication.instance,
      validationAuthentication.authorityKey,
      { ...validationAuthentication.dependencies, readEffectiveConnectionAuthority: async () => ({
        schemaVersion: 1, authenticated: true, authorityHmacSha256: '9'.repeat(64),
      }) },
    )).rejects.toThrow('authenticated observation')

    const noRuntimeBinding = await fixture()
    await expect(createOpenDesignM1H1PreflightEvidence(
      noRuntimeBinding.preflightRoot, noRuntimeBinding.authority, noRuntimeBinding.instance,
      {
        ...noRuntimeBinding.dependencies,
        readRuntimeBinding: async () => ({
          schemaVersion: 1,
          configRootMatches: false,
          userDataRootMatches: true,
          mainPidMatches: true,
          serverIdentityMatches: true,
          runtimeInstanceDigest: '7'.repeat(64),
        } as any),
      },
    )).rejects.toThrow('runtime-binding RPC')
  })

  it('finishes release and staging authority before the final live process observation', async () => {
    const value = await fixture()
    const order: string[] = []
    let stagingFinished = false
    await expect(createOpenDesignM1H1PreflightEvidence(
      value.preflightRoot, value.authority, value.instance,
      {
        ...value.dependencies,
        inspectReleaseAuthority: async (authority) => {
          await new Promise<void>((resolvePromise) => queueMicrotask(resolvePromise))
          order.push('release')
          return { authority: releaseAuthority(authority), bundleFiles: {} }
        },
        inspectStagedApp: async () => {
          await new Promise<void>((resolvePromise) => queueMicrotask(resolvePromise))
          order.push('staging')
          stagingFinished = true
          return {
            appInventorySha256: '1'.repeat(64),
            rawAppInventorySha256: '1'.repeat(64),
            macOSLaunchServicesProvenanceSha256: null,
            packagedFilesSha256: '2'.repeat(64),
            packageVerificationCodeSha256: '3'.repeat(64),
            packagedFileCount: 1_998,
            codesignStrictVerified: true,
          }
        },
        inspectProcess: async () => {
          order.push('process')
          return stagingFinished
            ? { ...value.mainProcess, startIdentity: 'Fri Jul 17 14:59:59 2026' }
            : value.mainProcess
        },
      },
    )).rejects.toThrow('launch evidence')
    expect(order.slice(0, 3)).toEqual(['release', 'staging', 'process'])
  })

  it('rejects an alternate config with a copied lock and caller-matching launch record', async () => {
    const value = await fixture()
    const alternateConfig = join(value.parent, 'alternate-config')
    await mkdir(alternateConfig, { mode: 0o700 })
    await chmod(alternateConfig, 0o700)
    const lock = await readFile(join(value.config, '.server.lock'))
    await writeFile(join(alternateConfig, '.server.lock'), lock, { mode: 0o600 })
    const launch = JSON.parse(await readFile(value.launchEvidence, 'utf8'))
    launch.configRealpath = alternateConfig
    await writeFile(value.launchEvidence, canonicalJson(launch), { mode: 0o600 })
    await chmod(value.launchEvidence, 0o600)
    const alternateInstance = { ...value.instance, configRealpath: alternateConfig }
    await expect(createOpenDesignM1H1PreflightEvidence(
      value.preflightRoot, value.authority, alternateInstance,
      {
        ...value.dependencies,
        readRuntimeBinding: async (_target, request) => ({
          schemaVersion: 1,
          configRootMatches: request.configRealpath === value.config,
          userDataRootMatches: true,
          mainPidMatches: true,
          serverIdentityMatches: true,
          runtimeInstanceDigest: '7'.repeat(64),
        } as any),
      },
    )).rejects.toThrow('runtime-binding RPC')
  })

  it('binds the target path to the production unpacked renderer layout', async () => {
    const builder = parse(await readFile(join(
      import.meta.dir, '..', '..', 'apps', 'electron', 'electron-builder.yml',
    ), 'utf8')) as Record<string, unknown>
    expect(builder.asar).toBe(false)

    const value = await fixture()
    const asarRendererPath = pathToFileURL(join(
      value.appBundle, 'Contents', 'Resources', 'app.asar', 'dist', 'renderer', 'index.html',
    )).href
    await expect(createOpenDesignM1H1PreflightEvidence(
      value.preflightRoot, value.authority, value.instance,
      {
        ...value.dependencies,
        discoverTargets: async () => [{
          id: 'craft-renderer',
          type: 'page',
          url: `${asarRendererPath}?workspaceId=fixture`,
          webSocketDebuggerUrl: `ws://127.0.0.1:${value.instance.cdpPort}/devtools/page/craft-renderer`,
        }],
      },
    )).rejects.toThrow('dedicated Craft CDP target')
  })

  it('requires the unique packaged renderer and one canonical safe workspaceId', async () => {
    const invalidQueries = [
      '', '?workspace=fixture', '?workspaceId=', '?workspaceId=fixture&debug=1',
      '?workspaceId=fixture&workspaceId=other', '?workspaceId=../outside', '?workspaceId=fixture#fragment',
    ]
    for (const suffix of invalidQueries) {
      const value = await fixture()
      const rendererPath = pathToFileURL(join(
        value.appBundle, 'Contents', 'Resources', 'app', 'dist', 'renderer', 'index.html',
      )).href
      await expect(createOpenDesignM1H1PreflightEvidence(
        value.preflightRoot, value.authority, value.instance,
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
    }
  })

  it('rejects every changed release, staged inventory, launch, PID, profile, config, and port authority', async () => {
    const value = await produce()
    const otherProfile = join(value.parent, 'other-profile')
    const otherConfig = join(value.parent, 'other-config')
    await mkdir(otherProfile, { mode: 0o700 })
    await mkdir(otherConfig, { mode: 0o700 })
    await chmod(otherProfile, 0o700)
    await chmod(otherConfig, 0o700)
    const authorityAttempts: H1ConnectionAuthority[] = [
      { ...value.authority, sourceSha: '9'.repeat(40) },
      { ...value.authority, hostBuildRunId: value.authority.hostBuildRunId + 1 },
      { ...value.authority, hostArtifactId: value.authority.hostArtifactId + 1 },
      { ...value.authority, hostArtifactDigest: `sha256:${'8'.repeat(64)}` },
      { ...value.authority, rcLabel: '0.12.0-rc.6' },
      { ...value.authority, artifactArchiveRealpath: join(value.parent, 'other.zip') },
      { ...value.authority, bundleRootRealpath: join(value.parent, 'other-bundle') },
    ]
    for (const attempt of authorityAttempts) {
      await expect(validateOpenDesignM1H1PreflightEvidence(
        value.preflightRoot, attempt, value.instance, value.dependencies,
      )).rejects.toThrow()
    }
    const instanceAttempts: H1ConnectionInstance[] = [
      { ...value.instance, mainPid: value.instance.mainPid + 1 },
      { ...value.instance, profileRealpath: otherProfile },
      { ...value.instance, configRealpath: otherConfig },
      { ...value.instance, cdpPort: value.instance.cdpPort + 1 },
    ]
    for (const attempt of instanceAttempts) {
      await expect(validateOpenDesignM1H1PreflightEvidence(
        value.preflightRoot, value.authority, attempt, value.dependencies,
      )).rejects.toThrow()
    }
    await expect(validateOpenDesignM1H1PreflightEvidence(
      value.preflightRoot, value.authority, value.instance,
      {
        ...value.dependencies,
        inspectStagedApp: async () => ({
          appInventorySha256: '9'.repeat(64),
          rawAppInventorySha256: '9'.repeat(64),
          macOSLaunchServicesProvenanceSha256: null,
          packagedFilesSha256: '2'.repeat(64),
          packageVerificationCodeSha256: '3'.repeat(64),
          packagedFileCount: 1_998,
          codesignStrictVerified: true,
        }),
      },
    )).rejects.toThrow('staging authority')
  })

  it('rejects symlinks, widened permissions, partial writes, checksum drift, and resealed unknown fields', async () => {
    const linked = await produce()
    await unlink(join(linked.outputRoot, 'SHA256SUMS'))
    await symlink('h1-connection.json', join(linked.outputRoot, 'SHA256SUMS'))
    await expect(validateOpenDesignM1H1ConnectionEvidence(
      linked.outputRoot, linked.preflightRoot, linked.authority, linked.instance,
      linked.authorityKey, linked.dependencies,
    )).rejects.toThrow('owner-only regular file')

    const permissive = await produce()
    await chmod(join(permissive.preflightRoot, 'h1-preflight.json'), 0o644)
    await expect(validateOpenDesignM1H1PreflightEvidence(
      permissive.preflightRoot, permissive.authority, permissive.instance, permissive.dependencies,
    )).rejects.toThrow('owner-only regular file')

    const partial = await produce()
    await writeFile(join(partial.outputRoot, 'h1-connection.json'), '{"schemaVersion":2', { mode: 0o600 })
    await expect(validateOpenDesignM1H1ConnectionEvidence(
      partial.outputRoot, partial.preflightRoot, partial.authority, partial.instance,
      partial.authorityKey, partial.dependencies,
    )).rejects.toThrow('is not JSON')

    const tampered = await produce()
    const path = join(tampered.preflightRoot, 'h1-preflight.json')
    const proof = JSON.parse(await readFile(path, 'utf8'))
    proof.observation.secret = 'secret-value'
    await writeFile(path, canonicalJson(proof), { mode: 0o600 })
    await reseal(tampered.preflightRoot, 'h1-preflight.json')
    await expect(validateOpenDesignM1H1PreflightEvidence(
      tampered.preflightRoot, tampered.authority, tampered.instance, tampered.dependencies,
    )).rejects.toThrow('unknown, missing, or duplicate fields')

    const checksum = await produce()
    await writeFile(join(checksum.outputRoot, 'SHA256SUMS'), `${'0'.repeat(64)}  h1-connection.json\n`, { mode: 0o600 })
    await expect(validateOpenDesignM1H1ConnectionEvidence(
      checksum.outputRoot, checksum.preflightRoot, checksum.authority, checksum.instance,
      checksum.authorityKey, checksum.dependencies,
    )).rejects.toThrow('SHA256SUMS')

    const launchPermissions = await produce()
    await chmod(launchPermissions.launchEvidence, 0o644)
    await expect(validateOpenDesignM1H1PreflightEvidence(
      launchPermissions.preflightRoot, launchPermissions.authority,
      launchPermissions.instance, launchPermissions.dependencies,
    )).rejects.toThrow('canonical regular file')

    const launchTamper = await produce()
    const launch = JSON.parse(await readFile(launchTamper.launchEvidence, 'utf8'))
    launch.processStartIdentity = 'Fri Jul 17 14:59:59 2026'
    await writeFile(launchTamper.launchEvidence, canonicalJson(launch), { mode: 0o600 })
    await chmod(launchTamper.launchEvidence, 0o600)
    await expect(validateOpenDesignM1H1PreflightEvidence(
      launchTamper.preflightRoot, launchTamper.authority,
      launchTamper.instance, launchTamper.dependencies,
    )).rejects.toThrow('launch evidence')

    const timeOrder = await produce()
    const connectionPath = join(timeOrder.outputRoot, 'h1-connection.json')
    const connection = JSON.parse(await readFile(connectionPath, 'utf8'))
    connection.observation.observedAt = new Date(NOW - 1_000).toISOString()
    await writeFile(connectionPath, canonicalJson(connection), { mode: 0o600 })
    await reseal(timeOrder.outputRoot, 'h1-connection.json')
    await expect(validateOpenDesignM1H1ConnectionEvidence(
      timeOrder.outputRoot, timeOrder.preflightRoot,
      timeOrder.authority, timeOrder.instance, timeOrder.authorityKey, timeOrder.dependencies,
    )).rejects.toThrow('authenticated observation')
  })

  it('rejects launch, preflight, and connection timestamps even 1ms into the future', async () => {
    for (const offsetMs of [1, 60_000]) {
      const futureLaunch = await produce()
      const launch = JSON.parse(await readFile(futureLaunch.launchEvidence, 'utf8'))
      launch.capturedAt = new Date(NOW + offsetMs).toISOString()
      await writeFile(futureLaunch.launchEvidence, canonicalJson(launch), { mode: 0o600 })
      await chmod(futureLaunch.launchEvidence, 0o600)
      await expect(validateOpenDesignM1H1PreflightEvidence(
        futureLaunch.preflightRoot, futureLaunch.authority,
        futureLaunch.instance, futureLaunch.dependencies,
      )).rejects.toThrow('launch evidence')

      const futurePreflight = await produce()
      const preflightPath = join(futurePreflight.preflightRoot, 'h1-preflight.json')
      const preflight = JSON.parse(await readFile(preflightPath, 'utf8'))
      preflight.observation.observedAt = new Date(NOW + offsetMs).toISOString()
      await writeFile(preflightPath, canonicalJson(preflight), { mode: 0o600 })
      await reseal(futurePreflight.preflightRoot, 'h1-preflight.json')
      await expect(validateOpenDesignM1H1PreflightEvidence(
        futurePreflight.preflightRoot, futurePreflight.authority,
        futurePreflight.instance, futurePreflight.dependencies,
      )).rejects.toThrow('$.observation')

      const futureConnection = await produce()
      const connectionPath = join(futureConnection.outputRoot, 'h1-connection.json')
      const connection = JSON.parse(await readFile(connectionPath, 'utf8'))
      connection.observation.observedAt = new Date(NOW + offsetMs).toISOString()
      await writeFile(connectionPath, canonicalJson(connection), { mode: 0o600 })
      await reseal(futureConnection.outputRoot, 'h1-connection.json')
      await expect(validateOpenDesignM1H1ConnectionEvidence(
        futureConnection.outputRoot, futureConnection.preflightRoot,
        futureConnection.authority, futureConnection.instance,
        futureConnection.authorityKey, futureConnection.dependencies,
      )).rejects.toThrow('authenticated observation')
    }
  })

  it('captures a canonical owner-only launch record without process environment data', async () => {
    const value = await fixture()
    const output = join(value.parent, 'captured-launch.json')
    const result = await captureOpenDesignM1H1LaunchEvidence(output, {
      appBundleRealpath: value.appBundle,
      executableRealpath: value.executable,
      mainPid: value.instance.mainPid,
      profileRealpath: value.profile,
      configRealpath: value.config,
      cdpPort: value.instance.cdpPort,
    }, value.dependencies)
    const source = await readFile(output, 'utf8')
    expect(result.sha256).toBe(sha256(source))
    expect(source).toBe(canonicalJson(JSON.parse(source)))
    expect(source).not.toContain('environment')
    expect(source).not.toContain('token')
    await expect(captureOpenDesignM1H1LaunchEvidence(join(value.parent, 'bad-launch.json'), {
      appBundleRealpath: value.appBundle,
      executableRealpath: value.executable,
      mainPid: value.instance.mainPid,
      profileRealpath: value.profile,
      configRealpath: value.config,
      cdpPort: value.instance.cdpPort,
    }, { ...value.dependencies, inspectProcess: async () => ({ ...value.mainProcess, executableRealpath: '/tmp/fake' }) }))
      .rejects.toThrow('dedicated process identity')
  })

  it('normalizes only one uniform LaunchServices provenance xattr and rejects every other xattr drift', () => {
    const expected = [
      { flags: 0, gid: 20, mode: '0755', path: '.', type: 'directory', uid: 501, xattrs: [] },
      { flags: 0, gid: 20, mode: '0644', path: 'file', sha1: 'a'.repeat(40), sha256: 'b'.repeat(64), type: 'file', uid: 501, xattrs: [] },
    ]
    const provenance = { name: 'com.apple.provenance', sha256: 'c'.repeat(64) }
    const expectedSource = expected.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
    const stagedSource = expected.map((entry) => JSON.stringify({ ...entry, xattrs: [provenance] })).join('\n') + '\n'
    expect(normalizeOpenDesignM1H1StagedInventory(stagedSource, expectedSource)).toEqual({
      normalizedSha256: sha256(expectedSource),
      provenanceSha256: 'c'.repeat(64),
    })
    const mixed = [
      JSON.stringify({ ...expected[0], xattrs: [provenance] }),
      JSON.stringify(expected[1]),
    ].join('\n') + '\n'
    expect(() => normalizeOpenDesignM1H1StagedInventory(mixed, expectedSource)).toThrow('not uniform')
    const unexpected = expected.map((entry) => JSON.stringify({
      ...entry,
      xattrs: [{ name: 'com.example.untrusted', sha256: 'd'.repeat(64) }],
    })).join('\n') + '\n'
    expect(() => normalizeOpenDesignM1H1StagedInventory(unexpected, expectedSource))
      .toThrow('differs outside')
  })

  it('accepts a live server child only when it is an app descendant with a compatible start time', async () => {
    const value = await fixture()
    const serverPid = 42_002
    const server: ProcessObservation = {
      pid: serverPid,
      uid: value.mainProcess.uid,
      parentPid: value.instance.mainPid,
      executableRealpath: join(value.appBundle, 'Contents', 'Resources', 'runtime', 'bun'),
      commandLine: '',
      startIdentity: 'Fri Jul 17 15:00:02 2026',
      startedAtMs: NOW - 18_000,
      loopbackListeningPorts: [],
    }
    await writeFile(join(value.config, '.server.lock'), JSON.stringify({ pid: serverPid, startedAt: NOW - 17_000 }), { mode: 0o600 })
    await chmod(join(value.config, '.server.lock'), 0o600)
    await createOpenDesignM1H1PreflightEvidence(
      value.preflightRoot, value.authority, value.instance,
      { ...value.dependencies, listProcesses: async () => [value.mainProcess, server] },
    )
    const proof = JSON.parse(await readFile(join(value.preflightRoot, 'h1-preflight.json'), 'utf8'))
    expect(proof.launch.serverPid).toBe(serverPid)

    const invalid = await fixture()
    await writeFile(join(invalid.config, '.server.lock'), JSON.stringify({ pid: serverPid, startedAt: NOW - 30_000 }), { mode: 0o600 })
    await chmod(join(invalid.config, '.server.lock'), 0o600)
    await expect(createOpenDesignM1H1PreflightEvidence(
      invalid.preflightRoot, invalid.authority, invalid.instance,
      { ...invalid.dependencies, listProcesses: async () => [invalid.mainProcess, server] },
    )).rejects.toThrow('server lock')
  })

  it('runs the production release helpers with fixed github.com authority and exact attestation arguments', async () => {
    const value = await createReleaseGlueFixture()
    const runner = createReleaseRunner(value)
    const previousHost = process.env.GH_HOST
    process.env.GH_HOST = 'attacker.example.invalid'
    let result: Awaited<ReturnType<typeof inspectOpenDesignM1H1ReleaseAuthority>>
    try {
      result = await inspectOpenDesignM1H1ReleaseAuthority(value.authority, {
        runCommand: runner.runCommand,
        githubCliFixtureIo: githubCliFixtureIo(),
      })
    } finally {
      if (previousHost === undefined) delete process.env.GH_HOST
      else process.env.GH_HOST = previousHost
    }
    const ghNetworkCalls = runner.calls.filter(({ args }) => args[0] === 'api' || args[0] === 'attestation')
    expect(ghNetworkCalls).toHaveLength(6)
    for (const { args } of ghNetworkCalls) {
      expect(args).toContain('--hostname')
      expect(args[args.indexOf('--hostname') + 1]).toBe('github.com')
    }
    expect(runner.calls.filter(({ args }) => args[0] === 'api').map(({ args }) => args)).toEqual([
      ['api', '--hostname', 'github.com', `repos/Jiachi-Deng/Simulator/actions/artifacts/${value.authority.hostArtifactId}`],
      ['api', '--hostname', 'github.com', `repos/Jiachi-Deng/Simulator/actions/artifacts/${value.inputArtifactId}`],
      ['api', '--hostname', 'github.com', `repos/Jiachi-Deng/Simulator/actions/runs/${value.authority.hostBuildRunId}/attempts/4`],
    ])
    const attestationCalls = runner.calls.filter(({ args }) => args[0] === 'attestation').map(({ args }) => args)
    const attestationArgs = (subject: string, bundle: string, predicateType: string) => [
      'attestation', 'verify', subject,
      '--hostname', 'github.com',
      '--bundle', bundle,
      '--repo', 'Jiachi-Deng/Simulator',
      '--signer-workflow', 'Jiachi-Deng/Simulator/.github/workflows/engineering-rc.yml',
      '--source-ref', 'refs/heads/main',
      '--source-digest', value.authority.sourceSha,
      '--signer-digest', value.authority.sourceSha,
      '--deny-self-hosted-runners',
      '--cert-oidc-issuer', 'https://token.actions.githubusercontent.com',
      '--digest-alg', 'sha256',
      '--predicate-type', predicateType,
      '--format', 'json',
    ]
    expect(attestationCalls).toEqual([
      attestationArgs(
        join(value.authority.bundleRootRealpath, 'Simulator-arm64.dmg'),
        join(value.authority.bundleRootRealpath, 'attestations', 'provenance.sigstore.json'),
        'https://slsa.dev/provenance/v1',
      ),
      attestationArgs(
        join(value.authority.bundleRootRealpath, 'Simulator-arm64.zip'),
        join(value.authority.bundleRootRealpath, 'attestations', 'provenance.sigstore.json'),
        'https://slsa.dev/provenance/v1',
      ),
      attestationArgs(
        join(value.authority.bundleRootRealpath, 'Simulator-arm64.zip'),
        join(value.authority.bundleRootRealpath, 'attestations', 'sbom.sigstore.json'),
        'https://spdx.dev/Document/v2.3',
      ),
    ])
    expect(result.authority).toMatchObject({
      hostArtifactArchive: { bytes: value.archiveBytes.length, sha256: sha256(value.archiveBytes) },
      hostBuildRunAttempt: 4,
      githubCli: {
        invocationPath: '/opt/homebrew/bin/gh',
        executableRealpath: '/fixture/homebrew/Cellar/gh/2.86.0/bin/gh',
        version: '2.86.0',
        bytes: 123_456,
        sha256: '6'.repeat(64),
      },
    })
  })

  it('rejects every mutated Artifact authority field through the production helper', async () => {
    const value = await createReleaseGlueFixture()
    const cases: Array<{ target: 'host' | 'input'; mutate: (artifact: Record<string, any>) => void }> = [
      { target: 'host', mutate: (artifact) => { artifact.id += 1 } },
      { target: 'host', mutate: (artifact) => { artifact.name = 'wrong' } },
      { target: 'host', mutate: (artifact) => { artifact.digest = `sha256:${'0'.repeat(64)}` } },
      { target: 'host', mutate: (artifact) => { artifact.expired = true } },
      { target: 'host', mutate: (artifact) => { artifact.size_in_bytes += 1 } },
      { target: 'host', mutate: (artifact) => { artifact.workflow_run.id += 1 } },
      { target: 'host', mutate: (artifact) => { artifact.workflow_run.repository_id += 1 } },
      { target: 'host', mutate: (artifact) => { artifact.workflow_run.head_repository_id += 1 } },
      { target: 'host', mutate: (artifact) => { artifact.workflow_run.head_branch = 'release' } },
      { target: 'host', mutate: (artifact) => { artifact.workflow_run.head_sha = '0'.repeat(40) } },
      { target: 'input', mutate: (artifact) => { artifact.name = 'wrong-input' } },
      { target: 'input', mutate: (artifact) => { artifact.digest = `sha256:${'1'.repeat(64)}` } },
    ]
    for (const entry of cases) {
      const runner = createReleaseRunner(value, {
        mutateArtifact: (artifact, artifactId) => {
          const isHost = artifactId === value.authority.hostArtifactId
          if ((entry.target === 'host') === isHost) entry.mutate(artifact)
        },
      })
      await expect(inspectOpenDesignM1H1ReleaseAuthority(value.authority, {
        runCommand: runner.runCommand,
        githubCliFixtureIo: githubCliFixtureIo(),
      })).rejects.toThrow('GitHub Artifact authority')
    }
  })

  it('rejects malformed DSSE, provenance subject/source, and SBOM predicates through production helpers', async () => {
    const malformedDsse = await createReleaseGlueFixture()
    await rewriteReleaseContent(
      malformedDsse,
      'attestations/provenance.sigstore.json',
      '{"dsseEnvelope":{"payloadType":"application/vnd.in-toto+json","payload":"not-base64"}}\n',
    )
    await expect(inspectOpenDesignM1H1ReleaseAuthority(malformedDsse.authority, {
      runCommand: createReleaseRunner(malformedDsse).runCommand,
      githubCliFixtureIo: githubCliFixtureIo(),
    })).rejects.toThrow('dsseEnvelope.payload')

    const wrongSubject = await createReleaseGlueFixture()
    await expect(inspectOpenDesignM1H1ReleaseAuthority(wrongSubject.authority, {
      runCommand: createReleaseRunner(wrongSubject, {
        mutateProvenance: (statement) => { statement.subject[0].digest.sha256 = '0'.repeat(64) },
      }).runCommand,
      githubCliFixtureIo: githubCliFixtureIo(),
    })).rejects.toThrow('provenance.subject')

    const wrongSource = await createReleaseGlueFixture()
    await expect(inspectOpenDesignM1H1ReleaseAuthority(wrongSource.authority, {
      runCommand: createReleaseRunner(wrongSource, {
        mutateProvenance: (statement) => {
          statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = '0'.repeat(40)
        },
      }).runCommand,
      githubCliFixtureIo: githubCliFixtureIo(),
    })).rejects.toThrow('provenance statement')

    const wrongSbom = await createReleaseGlueFixture()
    await expect(inspectOpenDesignM1H1ReleaseAuthority(wrongSbom.authority, {
      runCommand: createReleaseRunner(wrongSbom, {
        mutateSbom: (statement) => { statement.predicate.name = 'Different-SBOM' },
      }).runCommand,
      githubCliFixtureIo: githubCliFixtureIo(),
    })).rejects.toThrow('SBOM attestation')
  })

  it('rejects empty, malformed, and internally inconsistent gh attestation result sets', async () => {
    const value = await createReleaseGlueFixture()
    for (const { response, expectedMessage } of [
      { response: [], expectedMessage: 'GitHub attestation verification' },
      { response: {}, expectedMessage: 'GitHub attestation verification' },
      { response: [{}], expectedMessage: '$verified[0].verificationResult' },
    ]) {
      await expect(inspectOpenDesignM1H1ReleaseAuthority(value.authority, {
        runCommand: createReleaseRunner(value, {
          transformAttestationResponse: () => response,
        }).runCommand,
        githubCliFixtureIo: githubCliFixtureIo(),
      })).rejects.toThrow(expectedMessage)
    }

    await expect(inspectOpenDesignM1H1ReleaseAuthority(value.authority, {
      runCommand: createReleaseRunner(value, {
        transformAttestationResponse: (response, context) => {
          if (context.predicateType !== 'https://slsa.dev/provenance/v1') return response
          const inconsistent = structuredClone(response[0]!)
          inconsistent.verificationResult.statement.predicate.runDetails.metadata.invocationId =
            `https://github.com/Jiachi-Deng/Simulator/actions/runs/${value.authority.hostBuildRunId}/attempts/5`
          return [...response, inconsistent]
        },
      }).runCommand,
      githubCliFixtureIo: githubCliFixtureIo(),
    })).rejects.toThrow('inconsistent workflow attempts')
  })

  it('rejects differing DMG/ZIP attempts and swapped provenance subject order', async () => {
    const differentAttempts = await createReleaseGlueFixture()
    await expect(inspectOpenDesignM1H1ReleaseAuthority(differentAttempts.authority, {
      runCommand: createReleaseRunner(differentAttempts, {
        mutateProvenance: (statement, subject) => {
          if (subject.endsWith('/Simulator-arm64.zip')) {
            statement.predicate.runDetails.metadata.invocationId =
              `https://github.com/Jiachi-Deng/Simulator/actions/runs/${differentAttempts.authority.hostBuildRunId}/attempts/5`
          }
        },
      }).runCommand,
      githubCliFixtureIo: githubCliFixtureIo(),
    })).rejects.toThrow('inconsistent workflow attempts')

    const swappedSubjects = await createReleaseGlueFixture()
    await expect(inspectOpenDesignM1H1ReleaseAuthority(swappedSubjects.authority, {
      runCommand: createReleaseRunner(swappedSubjects, {
        mutateProvenance: (statement) => { statement.subject.reverse() },
      }).runCommand,
      githubCliFixtureIo: githubCliFixtureIo(),
    })).rejects.toThrow('provenance.subject')
  })

  it('rejects every mutated provenance workflow and invocation authority field', async () => {
    const value = await createReleaseGlueFixture()
    const workflowCases: Array<(statement: Record<string, any>) => void> = [
      (statement) => { statement.predicate.buildDefinition.externalParameters.workflow.path = '.github/workflows/other.yml' },
      (statement) => { statement.predicate.buildDefinition.externalParameters.workflow.repository = 'https://github.com/other/repo' },
      (statement) => { statement.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/heads/release' },
      (statement) => { statement.predicate.runDetails.builder.id = 'https://github.com/other/repo/workflow.yml@refs/heads/main' },
    ]
    for (const mutate of workflowCases) {
      await expect(inspectOpenDesignM1H1ReleaseAuthority(value.authority, {
        runCommand: createReleaseRunner(value, { mutateProvenance: mutate }).runCommand,
        githubCliFixtureIo: githubCliFixtureIo(),
      })).rejects.toThrow('expected GitHub-hosted workflow')
    }

    await expect(inspectOpenDesignM1H1ReleaseAuthority(value.authority, {
      runCommand: createReleaseRunner(value, {
        mutateProvenance: (statement) => {
          statement.predicate.runDetails.metadata.invocationId =
            `https://github.com/Jiachi-Deng/Simulator/actions/runs/${value.authority.hostBuildRunId}/attempts/5`
        },
      }).runCommand,
      githubCliFixtureIo: githubCliFixtureIo(),
    })).rejects.toThrow('inconsistent workflow attempts')
  })

  it('records fixed gh path/realpath/version/hash and rejects CLI drift across verification', async () => {
    const value = await createReleaseGlueFixture()
    await expect(inspectOpenDesignM1H1ReleaseAuthority(value.authority, {
      runCommand: createReleaseRunner(value).runCommand,
      githubCliFixtureIo: githubCliFixtureIo(true),
    })).rejects.toThrow('changed across verification')
  })

  it('runs staged code-signature and inventory glue against the exact authenticated hashes', async () => {
    const value = await fixture()
    const inventorySource = `${JSON.stringify({
      flags: 0, gid: 20, mode: '0755', path: '.', type: 'directory', uid: 501, xattrs: [],
    })}\n`
    const packagedSource = `${'a'.repeat(64)}  Contents/MacOS/Simulator\n`
    const verificationSource = 'package-verification-code\n'
    await writeFile(join(value.authority.bundleRootRealpath, 'app-inventory.jsonl'), inventorySource, { mode: 0o600 })
    const commands: Array<{ file: string; args: readonly string[] }> = []
    const release = {
      authority: {
        bundleRootRealpath: value.authority.bundleRootRealpath,
        appInventorySha256: sha256(inventorySource),
        packagedFilesSha256: sha256(packagedSource),
        packageVerificationCodeSha256: sha256(verificationSource),
      },
      bundleFiles: {},
    } as any
    const result = await inspectOpenDesignM1H1StagedApp(value.instance, release, async (file, args) => {
      commands.push({ file, args })
      if (file === '/usr/bin/python3') {
        const filesIndex = args.indexOf('--spdx-files')
        const codeIndex = args.indexOf('--spdx-package-verification-code')
        await writeFile(args[2]!, inventorySource, { mode: 0o600 })
        await writeFile(args[filesIndex + 1]!, packagedSource, { mode: 0o600 })
        await writeFile(args[codeIndex + 1]!, verificationSource, { mode: 0o600 })
      }
      return ''
    })
    expect(commands[0]).toEqual({
      file: '/usr/bin/codesign',
      args: ['--verify', '--deep', '--strict', value.instance.appBundleRealpath],
    })
    expect(commands[1]?.file).toBe('/usr/bin/python3')
    expect(result).toEqual({
      appInventorySha256: sha256(inventorySource),
      rawAppInventorySha256: sha256(inventorySource),
      macOSLaunchServicesProvenanceSha256: null,
      packagedFilesSha256: sha256(packagedSource),
      packageVerificationCodeSha256: sha256(verificationSource),
      packagedFileCount: 1,
      codesignStrictVerified: true,
    })
  })

  it('keeps default authority verification explicit and avoids full-environment inspection', async () => {
    const source = await readFile(join(import.meta.dir, 'open-design-m1-h1-connection-evidence.ts'), 'utf8')
    for (const required of [
      'verifyEngineeringRcBundle',
      'githubArtifact(authority.hostArtifactId',
      'verifyAttestations(',
      'inspectOpenDesignM1H1GitHubRunAttempt(',
      'inspectGithubCliAuthority(runCommand, githubCliFixtureIo)',
      'actions/artifacts/${artifactId}',
      "'attestation', 'verify'",
      "'--hostname', 'github.com'",
      "'extract-engineering-rc-artifact.py'",
      "'write-app-inventory.py'",
      "'--verify', '--deep', '--strict'",
      "'status', '--porcelain=v1', '--untracked-files=all'",
      "join(configRoot, '.server.lock')",
    ]) expect(source).toContain(required)
    for (const forbidden of [
      'ps eww', "'-E'", 'process.env', 'launchctl procinfo', 'sysctl',
      'verifyArtifact:', 'verifyAttestations:', 'verifyRunAttempt:', 'inspectGithubCli:',
    ]) {
      expect(source).not.toContain(forbidden)
    }
  })

  it('queries the fixed gh run-attempt endpoint and rejects every non-success authority field', async () => {
    const sourceSha = '1234567890abcdef1234567890abcdef12345678'
    const runId = 8_001
    const runAttempt = 3
    const valid = {
      id: runId,
      run_attempt: runAttempt,
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
      head_branch: 'main',
      head_sha: sourceSha,
      path: '.github/workflows/engineering-rc.yml',
      repository: { id: 1_298_254_148, full_name: 'Jiachi-Deng/Simulator' },
      head_repository: { id: 1_298_254_148, full_name: 'Jiachi-Deng/Simulator' },
    }
    const calls: Array<{ file: string; args: readonly string[]; maximumBytes: number; label: string }> = []
    const runner = async (file: string, args: readonly string[], maximumBytes: number, label: string) => {
      calls.push({ file, args, maximumBytes, label })
      return JSON.stringify(valid)
    }
    expect(await inspectOpenDesignM1H1GitHubRunAttempt(runId, runAttempt, sourceSha, runner)).toEqual({
      runId,
      runAttempt,
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
      headBranch: 'main',
      headSha: sourceSha,
      workflowPath: '.github/workflows/engineering-rc.yml',
      repositoryId: 1_298_254_148,
      headRepositoryId: 1_298_254_148,
    })
    expect(calls).toEqual([{
      file: '/opt/homebrew/bin/gh',
      args: ['api', '--hostname', 'github.com', 'repos/Jiachi-Deng/Simulator/actions/runs/8001/attempts/3'],
      maximumBytes: 1024 * 1024,
      label: 'GitHub run-attempt authority',
    }])

    const mutations: Array<(value: any) => void> = [
      (value) => { value.id += 1 },
      (value) => { value.run_attempt += 1 },
      (value) => { value.event = 'push' },
      (value) => { value.status = 'in_progress' },
      (value) => { value.status = 'completed'; value.conclusion = 'failure' },
      (value) => { value.status = 'completed'; value.conclusion = 'cancelled' },
      (value) => { value.head_branch = 'release' },
      (value) => { value.head_sha = '9'.repeat(40) },
      (value) => { value.path = '.github/workflows/other.yml' },
      (value) => { value.repository.id += 1 },
      (value) => { value.repository.full_name = 'other/repo' },
      (value) => { value.head_repository.id += 1 },
      (value) => { value.head_repository.full_name = 'fork/repo' },
    ]
    for (const mutate of mutations) {
      const changed = structuredClone(valid)
      mutate(changed)
      await expect(inspectOpenDesignM1H1GitHubRunAttempt(
        runId, runAttempt, sourceSha, async () => JSON.stringify(changed),
      )).rejects.toThrow('GitHub run-attempt authority')
    }
  })
})
