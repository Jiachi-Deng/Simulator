import { readFileSync } from "node:fs"
import { TextDecoder } from "node:util"
import { encodeCanonicalCatalog } from "@simulator/module-release-trust"

function canonicalBytes(path: string, label: string): Buffer {
  const bytes = readFileSync(path)
  let source: string
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${label} is not valid UTF-8`)
  }
  if (!bytes.equals(Buffer.from(source, "utf8"))) throw new Error(`${label} is not canonical UTF-8`)
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error(`${label} is not JSON`)
  }
  const canonical = Buffer.from(encodeCanonicalCatalog(value))
  if (!bytes.equals(canonical)) throw new Error(`${label} is not canonical publisher bytes`)
  return bytes
}

export function verifyOpenDesignOfficialChannelByteIdentity(sourcePath: string, generatedPath: string): void {
  const source = canonicalBytes(sourcePath, "Signed Host official channel source")
  const generated = canonicalBytes(generatedPath, "Generated stable official channel")
  if (!source.equals(generated)) {
    throw new Error("Signed Host official channel differs byte-for-byte from the stable publication config")
  }
}

if (import.meta.main) {
  const [sourcePath, generatedPath] = process.argv.slice(2)
  if (!sourcePath || !generatedPath || process.argv.length !== 4) {
    throw new Error("Usage: open-design-official-channel-bytes.ts SOURCE_CONFIG GENERATED_CONFIG")
  }
  verifyOpenDesignOfficialChannelByteIdentity(sourcePath, generatedPath)
  console.log(JSON.stringify({ ok: true }))
}
