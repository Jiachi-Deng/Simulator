import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderHostAgentV2Fixtures } from '../src/fixtures.ts'
import { renderHostAgentV2JsonSchema } from '../src/schema.ts'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = [
  { path: join(packageRoot, 'schema', 'host-agent-v2.schema.json'), contents: renderHostAgentV2JsonSchema() },
  { path: join(packageRoot, 'fixtures', 'host-agent-v2-fixtures.json'), contents: renderHostAgentV2Fixtures() },
]
const check = process.argv.includes('--check')

for (const artifact of artifacts) {
  if (check) {
    let actual: string
    try {
      actual = await readFile(artifact.path, 'utf8')
    } catch {
      throw new Error(`Generated artifact is missing: ${artifact.path}`)
    }
    if (actual !== artifact.contents) throw new Error(`Generated artifact is stale: ${artifact.path}`)
  } else {
    await mkdir(dirname(artifact.path), { recursive: true })
    await writeFile(artifact.path, artifact.contents, 'utf8')
  }
}

console.log(check ? 'Host Agent contract artifacts are current.' : 'Host Agent contract artifacts generated.')
