import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, parse, resolve } from 'node:path'
import { createOpenDesignM1SeedArchive } from './open-design-m1-cases'
import {
  OPEN_DESIGN_M1_CASES_V2,
  OPEN_DESIGN_M1_CASE_MANIFEST_V2_SHA256,
  OPEN_DESIGN_M1_INTERACTION_VECTORS,
  OPEN_DESIGN_M1_INTERACTION_VECTORS_CANONICAL_SHA256,
  openDesignM1InteractionVectorSha256,
  renderOpenDesignM1CaseManifestV2,
} from './open-design-m1-interaction-vectors'

const outputArgument = process.argv[2]
if (!outputArgument || !isAbsolute(outputArgument) || process.argv.length !== 3) {
  throw new TypeError('Usage: generate-open-design-m1-case-artifacts-v2.ts /absolute/new-output-directory')
}
const outputRoot = resolve(outputArgument)
if (outputRoot === parse(outputRoot).root) throw new TypeError('Refusing to use a filesystem root as output')
await mkdir(outputRoot, { recursive: false, mode: 0o700 })
await mkdir(join(outputRoot, 'seeds'), { recursive: true, mode: 0o700 })
const seeds: Record<string, string> = {}
for (const testCase of OPEN_DESIGN_M1_CASES_V2) {
  const path = join(outputRoot, 'seeds', `${testCase.id}.tar.gz`)
  seeds[testCase.id] = await createOpenDesignM1SeedArchive(testCase, path)
  await chmod(path, 0o600)
  if (seeds[testCase.id] !== testCase.seedArchiveSha256) {
    throw new Error(`${testCase.id} seed hash mismatch`)
  }
}
const caseManifest = renderOpenDesignM1CaseManifestV2()
await writeFile(join(outputRoot, 'open-design-m1-cases-v2.json'), caseManifest, { mode: 0o600, flag: 'wx' })
await writeFile(join(outputRoot, 'open-design-m1-interaction-vectors-v2.json'), `${JSON.stringify({
  schemaVersion: 2,
  sha256: OPEN_DESIGN_M1_INTERACTION_VECTORS_CANONICAL_SHA256,
  vectors: OPEN_DESIGN_M1_INTERACTION_VECTORS,
}, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
await writeFile(join(outputRoot, 'authority.json'), `${JSON.stringify({
  schemaVersion: 2,
  caseManifestSha256: OPEN_DESIGN_M1_CASE_MANIFEST_V2_SHA256,
  interactionVectorsSha256: OPEN_DESIGN_M1_INTERACTION_VECTORS_CANONICAL_SHA256,
  cases: OPEN_DESIGN_M1_CASES_V2.map((testCase) => ({
    id: testCase.id,
    seedArchiveSha256: seeds[testCase.id],
    interactionVectorSha256: openDesignM1InteractionVectorSha256(
      OPEN_DESIGN_M1_INTERACTION_VECTORS.find((vector) => vector.caseId === testCase.id)!,
    ),
  })),
}, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
await chmod(outputRoot, 0o700)
process.stdout.write(`${JSON.stringify({
  status: 'ready',
  authorityVersion: 2,
  outputRoot,
  cases: OPEN_DESIGN_M1_CASES_V2.length,
  caseManifestSha256: OPEN_DESIGN_M1_CASE_MANIFEST_V2_SHA256,
  interactionVectorsSha256: OPEN_DESIGN_M1_INTERACTION_VECTORS_CANONICAL_SHA256,
})}\n`)
