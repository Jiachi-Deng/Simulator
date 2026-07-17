import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { verifyOpenDesignOfficialChannelByteIdentity } from "./open-design-official-channel-bytes"

const roots: string[] = []
const resource = join(import.meta.dir, "..", "..", "apps", "electron", "resources", "open-design-official-channel.json")

function fixture(source: Buffer | string, generated: Buffer | string = source): [string, string] {
  const root = mkdtempSync(join(tmpdir(), "simulator-official-channel-bytes-"))
  roots.push(root)
  chmodSync(root, 0o700)
  const sourcePath = join(root, "source.json")
  const generatedPath = join(root, "generated.json")
  writeFileSync(sourcePath, source, { mode: 0o600 })
  writeFileSync(generatedPath, generated, { mode: 0o600 })
  return [sourcePath, generatedPath]
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("OpenDesign official channel byte identity", () => {
  test("accepts the exact canonical checked-in publisher bytes", () => {
    const bytes = readFileSync(resource)
    expect(bytes.at(-1)).toBe("}".charCodeAt(0))
    const [source, generated] = fixture(bytes)
    expect(() => verifyOpenDesignOfficialChannelByteIdentity(source, generated)).not.toThrow()
  })

  test("rejects whitespace, a trailing newline, duplicate keys, and reordered source fields", () => {
    const canonical = readFileSync(resource, "utf8")
    const value = JSON.parse(canonical) as Record<string, unknown>
    const cases = [
      `${canonical}\n`,
      ` ${canonical}`,
      canonical.replace('{"catalogUrl":', '{"version":"0.14.6","catalogUrl":'),
      JSON.stringify({ version: value.version, ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== "version")) }),
    ]
    for (const candidate of cases) {
      const [source, generated] = fixture(candidate, canonical)
      expect(() => verifyOpenDesignOfficialChannelByteIdentity(source, generated)).toThrow("canonical publisher bytes")
    }
  })

  test("rejects a noncanonical generated file and canonical but different identity", () => {
    const canonical = readFileSync(resource, "utf8")
    const [source, generated] = fixture(canonical, `${canonical}\n`)
    expect(() => verifyOpenDesignOfficialChannelByteIdentity(source, generated)).toThrow("canonical publisher bytes")

    const value = JSON.parse(canonical) as Record<string, unknown>
    const changed = JSON.stringify(Object.fromEntries(Object.entries({ ...value, version: "0.14.7" }).sort(([left], [right]) => left.localeCompare(right))))
    const [sourceChanged, generatedChanged] = fixture(canonical, changed)
    expect(() => verifyOpenDesignOfficialChannelByteIdentity(sourceChanged, generatedChanged)).toThrow("differs byte-for-byte")
  })
})
