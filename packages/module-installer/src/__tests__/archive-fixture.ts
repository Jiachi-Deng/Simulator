import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { parseModuleManifest, type ModuleSha256 } from '@simulator/module-contract'
import type { VerifiedArtifactDescriptor } from '../types.ts'

export interface TarFixtureEntry {
  readonly path: string
  readonly type?: '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | 'S' | 'g' | 'x' | 'X' | 'L' | 'K' | 'N'
  readonly mode?: number
  readonly content?: string | Uint8Array
  readonly linkpath?: string
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, '0')
  buffer.write(text, offset, length - 1, 'ascii')
  buffer[offset + length - 1] = 0
}

function tarHeader(entry: TarFixtureEntry, content: Buffer): Buffer {
  const header = Buffer.alloc(512)
  const pathBytes = Buffer.from(entry.path)
  if (pathBytes.length > 100) throw new Error('Test fixture path is too long')
  pathBytes.copy(header, 0)
  writeOctal(header, 100, 8, entry.mode ?? (entry.type === '5' ? 0o755 : 0o644))
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, content.length)
  writeOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  header.write(entry.type ?? '0', 156, 1, 'ascii')
  if (entry.linkpath) header.write(entry.linkpath, 157, 100, 'utf8')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
  header[154] = 0
  header[155] = 0x20
  return header
}

export function buildTarGz(entries: readonly TarFixtureEntry[]): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? '')
    parts.push(tarHeader(entry, content), content)
    const padding = (512 - (content.length % 512)) % 512
    if (padding > 0) parts.push(Buffer.alloc(padding))
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts), { level: 9 })
}

export function sha256(value: Uint8Array | string): ModuleSha256 {
  return createHash('sha256').update(value).digest('hex') as ModuleSha256
}

export function expectedTreeHash(entries: readonly TarFixtureEntry[]): ModuleSha256 {
  const directories = new Set<string>()
  const files: Array<{ path: string; content: Buffer; executable: boolean }> = []
  for (const entry of entries) {
    const type = entry.type ?? '0'
    if (!entry.path.startsWith('module/')) continue
    const path = entry.path.slice('module/'.length).replace(/\/$/, '')
    if (!path) continue
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join('/'))
    if (type === '5') directories.add(path)
    if (type === '0') {
      files.push({ path, content: Buffer.from(entry.content ?? ''), executable: ((entry.mode ?? 0o644) & 0o111) !== 0 })
    }
  }
  const records = [
    ...[...directories].map((path) => ({ path, record: `D\t${JSON.stringify(path)}` })),
    ...files.map(({ path, content, executable }) => ({
      path,
      record: `F\t${JSON.stringify(path)}\t${content.length}\t${executable ? 1 : 0}\t${sha256(content)}`,
    })),
  ].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)))
  return sha256(`${records.map((item) => item.record).join('\n')}\n`)
}

export async function writeArtifact(path: string, entries: readonly TarFixtureEntry[]): Promise<Buffer> {
  const archive = buildTarGz(entries)
  await writeFile(path, archive)
  return archive
}

export function descriptor(
  archive: Uint8Array,
  entries: readonly TarFixtureEntry[],
  version = '1.0.0',
): VerifiedArtifactDescriptor {
  const input = {
    schemaVersion: 1,
    id: 'org.simulator.fixture',
    version,
    artifacts: [{
      platform: 'darwin-arm64',
      entrypoint: 'bin/module',
      url: `https://modules.example.test/org.simulator.fixture/${version}/darwin-arm64.tar.gz`,
      sha256: sha256(archive),
    }],
    capabilities: ['workspace.read'],
  }
  const parsed = parseModuleManifest(input)
  if (!parsed.ok) throw new Error(`Fixture manifest is invalid: ${JSON.stringify(parsed.errors)}`)
  return {
    verified: true,
    manifest: parsed.value,
    artifact: parsed.value.artifacts[0]!,
    extractedManifestSha256: expectedTreeHash(entries),
    format: 'tar.gz',
  }
}

export const VALID_ENTRIES = Object.freeze([
  { path: 'module', type: '5', mode: 0o755 },
  { path: 'module/bin', type: '5', mode: 0o755 },
  { path: 'module/bin/module', type: '0', mode: 0o755, content: '#!/bin/sh\nexit 0\n' },
  { path: 'module/data.txt', type: '0', mode: 0o644, content: 'deterministic fixture\n' },
] satisfies readonly TarFixtureEntry[])
