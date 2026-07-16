import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, parse, resolve } from 'node:path'
import {
  OPEN_DESIGN_M1_CASES,
  createOpenDesignM1SeedArchive,
  renderOpenDesignM1CaseManifest,
} from './open-design-m1-cases'

const outputArgument = process.argv[2]
if (!outputArgument || !isAbsolute(outputArgument)) {
  throw new TypeError('Usage: generate-open-design-m1-case-artifacts.ts /absolute/new-output-directory')
}
const outputRoot = resolve(outputArgument)
if (outputRoot === parse(outputRoot).root) throw new TypeError('Refusing to use a filesystem root as output')
await mkdir(outputRoot, { recursive: false, mode: 0o700 })
await mkdir(join(outputRoot, 'seeds'), { recursive: true, mode: 0o700 })
const actual: Record<string, string> = {}
for (const testCase of OPEN_DESIGN_M1_CASES) {
  actual[testCase.id] = await createOpenDesignM1SeedArchive(testCase, join(outputRoot, 'seeds', `${testCase.id}.tar.gz`))
  await chmod(join(outputRoot, 'seeds', `${testCase.id}.tar.gz`), 0o600)
  if (actual[testCase.id] !== testCase.seedArchiveSha256) {
    throw new Error(`${testCase.id} seed hash mismatch: expected ${testCase.seedArchiveSha256}, got ${actual[testCase.id]}`)
  }
}
await writeFile(join(outputRoot, 'open-design-m1-cases.json'), renderOpenDesignM1CaseManifest(), { mode: 0o600 })
await writeFile(join(outputRoot, 'SHA256SUMS.json'), `${JSON.stringify(actual, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`${JSON.stringify({ status: 'ready', outputRoot, cases: OPEN_DESIGN_M1_CASES.length })}\n`)
