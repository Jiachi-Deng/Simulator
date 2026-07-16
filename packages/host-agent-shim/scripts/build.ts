import { chmod, mkdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(packageRoot, '../..')
const outputDirectory = join(repositoryRoot, 'apps/electron/resources/host-agent')
const outputPath = join(outputDirectory, 'simulator-host-agent.mjs')

await mkdir(outputDirectory, { recursive: true, mode: 0o755 })
const result = await Bun.build({
  entrypoints: [join(packageRoot, 'src/main.ts')],
  outdir: outputDirectory,
  naming: 'simulator-host-agent.mjs',
  target: 'node',
  format: 'esm',
  minify: false,
  sourcemap: 'none',
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
await chmod(outputPath, 0o755)
const digest = createHash('sha256').update(await readFile(outputPath)).digest('hex')
console.log(`simulator-host-agent.mjs sha256=${digest}`)
