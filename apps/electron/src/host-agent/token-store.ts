import { constants as fsConstants, realpathSync } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type { HostAgentProtocolPath } from './protocol'

export interface HostAgentTokenStore {
  create(protocol: HostAgentProtocolPath, epoch: string, token: string): Promise<string>
  remove(path: string): Promise<void>
}

function safeEpoch(epoch: string): string {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(epoch)) throw new TypeError('Host Agent worker epoch is invalid')
  return epoch
}

const TOKEN_FILE_NAME = /^(?:v1|v2)-[A-Za-z0-9_-]{8,128}\.token$/

function assertTokenFileName(name: string): void {
  if (!TOKEN_FILE_NAME.test(name)) {
    throw new TypeError(`Unexpected Host Agent token directory entry: ${name}`)
  }
}

function assertCurrentOwner(uid: number, label: string): void {
  if (typeof process.getuid === 'function' && uid !== process.getuid()) {
    throw new TypeError(`${label} must be owned by the current user`)
  }
}

function isSameCanonicalPath(left: string, right: string): boolean {
  return process.platform === 'win32' ? relative(left, right) === '' : left === right
}

/** Stores only owner-readable token files outside the packaged application. */
export class OwnerOnlyHostAgentTokenStore implements HostAgentTokenStore {
  readonly #directory: string
  #initialization?: Promise<void>

  constructor(directory: string) {
    const normalized = resolve(directory)
    if (normalized !== directory) {
      throw new TypeError('Host Agent token directory must be a normalized absolute path')
    }
    this.#directory = join(realpathSync(dirname(normalized)), basename(normalized))
  }

  async #initialize(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    let directoryMetadata = await lstat(this.#directory)
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
      throw new TypeError('Host Agent token directory must be a real directory')
    }
    assertCurrentOwner(directoryMetadata.uid, 'Host Agent token directory')
    const canonicalDirectory = await realpath(this.#directory)
    if (!isSameCanonicalPath(canonicalDirectory, this.#directory)) {
      throw new TypeError('Host Agent token directory must not traverse symbolic links')
    }
    if (process.platform !== 'win32') {
      await chmod(this.#directory, 0o700)
      directoryMetadata = await lstat(this.#directory)
      if ((directoryMetadata.mode & 0o777) !== 0o700) {
        throw new TypeError('Host Agent token directory permission verification failed')
      }
    }

    const entries = (await readdir(this.#directory)).sort()
    const stalePaths: string[] = []
    for (const name of entries) {
      assertTokenFileName(name)
      const path = join(this.#directory, name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
        throw new TypeError(`Stale Host Agent token must be a unique regular file: ${name}`)
      }
      assertCurrentOwner(metadata.uid, `Stale Host Agent token ${name}`)
      if (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600) {
        throw new TypeError(`Stale Host Agent token must use mode 0600: ${name}`)
      }
      stalePaths.push(path)
    }

    // Validate the complete directory before deleting anything. An anomalous
    // entry fails closed without partially erasing the available evidence.
    for (const path of stalePaths) await rm(path)
  }

  #ready(): Promise<void> {
    this.#initialization ??= this.#initialize()
    return this.#initialization
  }

  async create(protocol: HostAgentProtocolPath, epoch: string, token: string): Promise<string> {
    if (token.length < 32) throw new TypeError('Host Agent worker token is too short')
    await this.#ready()

    const path = join(this.#directory, `${protocol}-${safeEpoch(epoch)}.token`)
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
    const handle = await open(
      path,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
      0o600,
    )
    try {
      try {
        await handle.writeFile(token, { encoding: 'utf8' })
        await handle.sync()
        if (process.platform !== 'win32') await handle.chmod(0o600)
        const metadata = await handle.stat()
        if (!metadata.isFile() || metadata.nlink !== 1) {
          throw new Error('Host Agent token file must be a unique regular file')
        }
        assertCurrentOwner(metadata.uid, 'Host Agent token file')
        if (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600) {
          throw new Error('Host Agent token file permission verification failed')
        }
      } finally {
        await handle.close()
      }
    } catch (error) {
      await rm(path, { force: true })
      throw error
    }
    return path
  }

  async remove(path: string): Promise<void> {
    const normalized = resolve(path)
    if (normalized !== path || dirname(normalized) !== this.#directory) {
      throw new TypeError('Host Agent token removal must stay inside its token directory')
    }
    assertTokenFileName(basename(normalized))
    await rm(path, { force: true })
  }
}
