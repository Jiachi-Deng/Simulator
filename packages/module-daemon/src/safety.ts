import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { ModuleArtifact, ModulePlatform } from '@simulator/module-contract'
import { ModuleDaemonError, type LoopbackEndpoint } from './types.ts'

export async function resolveActivatedEntrypoint(
  activatedRoot: string,
  artifact: ModuleArtifact,
): Promise<{ activatedRoot: string; executable: string }> {
  if (!isAbsolute(activatedRoot)) {
    throw new ModuleDaemonError('ENTRYPOINT_INVALID', 'Activated module root must be absolute')
  }

  let canonicalRoot: string
  let executable: string
  try {
    canonicalRoot = await realpath(activatedRoot)
    executable = await realpath(resolve(canonicalRoot, artifact.entrypoint))
  } catch (error) {
    throw new ModuleDaemonError('ENTRYPOINT_INVALID', 'Module entrypoint cannot be resolved', { cause: error })
  }

  const relativePath = relative(canonicalRoot, executable)
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativePath)) {
    throw new ModuleDaemonError(
      'ENTRYPOINT_OUTSIDE_ACTIVATED_ROOT',
      'Module entrypoint resolves outside its activated root',
    )
  }

  let entrypointStat
  try {
    entrypointStat = await stat(executable)
  } catch (error) {
    throw new ModuleDaemonError('ENTRYPOINT_INVALID', 'Module entrypoint metadata cannot be read', { cause: error })
  }
  if (!entrypointStat.isFile()) {
    throw new ModuleDaemonError('ENTRYPOINT_INVALID', 'Module entrypoint must be a regular file')
  }
  if (process.platform !== 'win32' && (entrypointStat.mode & 0o111) === 0) {
    throw new ModuleDaemonError('ENTRYPOINT_NOT_EXECUTABLE', 'Module entrypoint is not executable')
  }

  return { activatedRoot: canonicalRoot, executable }
}

export function selectArtifact(
  artifacts: readonly ModuleArtifact[],
  platform: ModulePlatform,
): ModuleArtifact {
  const artifact = artifacts.find((candidate) => candidate.platform === platform)
  if (!artifact) {
    throw new ModuleDaemonError('ARTIFACT_NOT_FOUND', `No module artifact declared for ${platform}`)
  }
  return artifact
}

export function assertLoopbackEndpoint(endpoint: LoopbackEndpoint): void {
  if ((endpoint.host !== '127.0.0.1' && endpoint.host !== '::1')
    || !Number.isSafeInteger(endpoint.port)
    || endpoint.port < 1
    || endpoint.port > 65_535) {
    throw new ModuleDaemonError('ENDPOINT_NOT_LOOPBACK', 'Health endpoint must be a valid loopback address')
  }
}

export function createMinimalEnvironment(
  baseEnvironment: Readonly<Record<string, string>>,
  values: {
    id: string
    version: string
    endpoint: LoopbackEndpoint
  },
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, value] of Object.entries(baseEnvironment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.includes('\0') || value.includes('\0')) {
      throw new ModuleDaemonError('SPAWN_FAILED', 'Base environment contains an invalid entry')
    }
    environment[key] = value
  }
  environment.SIMULATOR_MODULE_ID = values.id
  environment.SIMULATOR_MODULE_VERSION = values.version
  environment.SIMULATOR_MODULE_HEALTH_HOST = values.endpoint.host
  environment.SIMULATOR_MODULE_HEALTH_PORT = String(values.endpoint.port)
  return Object.freeze(environment)
}
