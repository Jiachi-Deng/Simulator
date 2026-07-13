import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { invokeVerifier } from "./cli.js"
import { stageOpenScience } from "./staging.js"
import type { BuildBindings, RuntimeBindings, TrustedProvenanceVerifier, TrustedRuntimeConformanceVerifier } from "./types.js"

interface StageConfig {
  releaseRoot: string
  modelsSnapshotPath?: string
  legalEvidenceDirectory: string
  buildAttestationPath: string
  runtimeConformancePath: string
  bunExecutable?: string
  provenanceVerifier: string
  runtimeVerifier: string
}

function configRecord(value: unknown): StageConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("staging config must be an object")
  const config = value as Record<string, unknown>
  const allowed = ["releaseRoot", "modelsSnapshotPath", "legalEvidenceDirectory", "buildAttestationPath", "runtimeConformancePath", "bunExecutable", "provenanceVerifier", "runtimeVerifier"]
  if (Object.getOwnPropertySymbols(config).length !== 0 || Object.keys(config).some((key) => !allowed.includes(key))) throw new Error("staging config has unknown fields")
  for (const key of ["releaseRoot", "legalEvidenceDirectory", "buildAttestationPath", "runtimeConformancePath", "provenanceVerifier", "runtimeVerifier"]) {
    if (typeof config[key] !== "string" || config[key] === "") throw new Error(`staging config ${key} must be a non-empty string`)
  }
  for (const key of ["modelsSnapshotPath", "bunExecutable"]) {
    if (config[key] !== undefined && (typeof config[key] !== "string" || config[key] === "")) throw new Error(`staging config ${key} must be a non-empty string when present`)
  }
  return config as unknown as StageConfig
}

function fromConfigDirectory(configPath: string, value: string | undefined): string | undefined {
  return value === undefined ? undefined : path.resolve(path.dirname(configPath), value)
}

export async function main(args: string[]): Promise<void> {
  const [configPath] = args
  if (!configPath || args.length !== 1) throw new Error("usage: stage-open-science <staging-config.json>")
  const absoluteConfig = path.resolve(configPath)
  const config = configRecord(JSON.parse(await readFile(absoluteConfig, "utf8")))
  const provenanceExecutable = fromConfigDirectory(absoluteConfig, config.provenanceVerifier)!
  const runtimeExecutable = fromConfigDirectory(absoluteConfig, config.runtimeVerifier)!
  const provenanceVerifier: TrustedProvenanceVerifier = {
    verifierKind: `external:${provenanceExecutable}`,
    verify: (evidence: unknown, expected: BuildBindings) => invokeVerifier(provenanceExecutable, evidence, expected),
  }
  const runtimeVerifier: TrustedRuntimeConformanceVerifier = {
    verifierKind: `external:${runtimeExecutable}`,
    verify: (evidence: unknown, expected: RuntimeBindings) => invokeVerifier(runtimeExecutable, evidence, expected),
  }
  const result = await stageOpenScience({
    releaseRoot: fromConfigDirectory(absoluteConfig, config.releaseRoot)!,
    legalEvidenceDirectory: fromConfigDirectory(absoluteConfig, config.legalEvidenceDirectory)!,
    buildAttestationPath: fromConfigDirectory(absoluteConfig, config.buildAttestationPath)!,
    runtimeConformancePath: fromConfigDirectory(absoluteConfig, config.runtimeConformancePath)!,
    validation: { provenanceVerifier, runtimeVerifier },
    ...(config.modelsSnapshotPath === undefined ? {} : { modelsSnapshotPath: fromConfigDirectory(absoluteConfig, config.modelsSnapshotPath)! }),
    ...(config.bunExecutable === undefined ? {} : { bunExecutable: config.bunExecutable }),
  })
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
