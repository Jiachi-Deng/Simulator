#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertNativeBuildsAllowed, inspectNativeRuntime } from "./native-inventory.mjs";
import { produceInventory } from "./produce-inventory.mjs";
import { copyStagingInputs } from "./staging-copier.mjs";
import { stagingAssert, stagingFail } from "./staging-error.mjs";
import { verifyUpstream } from "./verify-upstream.mjs";

const moduleRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUILD_PACKAGES = Object.freeze([
  "@open-design/contracts",
  "@open-design/registry-protocol",
  "@open-design/sidecar-proto",
  "@open-design/launcher-proto",
  "@open-design/sidecar",
  "@open-design/platform",
  "@open-design/agui-adapter",
  "@open-design/plugin-runtime",
  "@open-design/download",
  "@open-design/host",
  "@open-design/diagnostics",
  "@open-design/components",
  "@open-design/daemon",
]);

export function createBuildPlan({ sourceRoot, stagingRoot, workRoot = defaultWorkRoot(stagingRoot), pnpmBin = "pnpm" } = {}) {
  stagingAssert(path.isAbsolute(sourceRoot ?? ""), "SOURCE_ROOT_INVALID", "source root must be an absolute path");
  stagingAssert(path.isAbsolute(stagingRoot ?? ""), "STAGING_ROOT_INVALID", "staging root must be an absolute path");
  stagingAssert(path.isAbsolute(workRoot ?? ""), "WORK_ROOT_INVALID", "work root must be an absolute path");
  stagingAssert(workRoot !== stagingRoot && !workRoot.startsWith(`${stagingRoot}${path.sep}`), "WORK_ROOT_INVALID", "work root must not be inside staging root");
  const daemonDeployRoot = path.join(workRoot, "daemon-deploy");
  const webDeployRoot = path.join(workRoot, "web-sidecar-deploy");
  const commands = [
    command(pnpmBin, ["install", "--frozen-lockfile"], sourceRoot),
    ...BUILD_PACKAGES.map((packageName) => command(pnpmBin, ["--filter", packageName, "build"], sourceRoot)),
    command(pnpmBin, ["--filter", "@open-design/web", "build"], sourceRoot, { OD_WEB_OUTPUT_MODE: "standalone" }),
    command(pnpmBin, ["--filter", "@open-design/web", "build:sidecar"], sourceRoot),
    command(pnpmBin, ["--filter", "@open-design/daemon", "deploy", "--prod", daemonDeployRoot], sourceRoot),
    command(pnpmBin, ["--filter", "@open-design/web", "deploy", "--prod", webDeployRoot], sourceRoot),
  ];
  return { sourceRoot, stagingRoot, workRoot, daemonDeployRoot, webDeployRoot, commands };
}

export async function prepareProductionStaging({
  sourceRoot,
  stagingRoot,
  sbomPath,
  metadataPath,
  targetPath,
  workRoot,
  pnpmBin = "pnpm",
  nodeVersion,
  pnpmVersion,
  dryRun = false,
  run,
  runCommand = defaultCommandRunner,
} = {}) {
  const [provenance, policy, decisions, metadata, target, sbom] = await Promise.all([
    readJsonRegular(path.join(moduleRoot, "provenance.json"), "PROVENANCE_INVALID"),
    readJsonRegular(path.join(moduleRoot, "artifact-policy.json"), "STAGING_POLICY_INVALID"),
    readJsonRegular(path.join(moduleRoot, "resource-decisions.json"), "RESOURCE_DECISIONS_INVALID"),
    readJsonRegular(metadataPath, "METADATA_INPUT_INVALID"),
    readJsonRegular(targetPath, "TARGET_INPUT_INVALID"),
    readJsonRegular(sbomPath, "SBOM_INPUT_INVALID"),
  ]);
  validateSbom(sbom);
  const verification = await verifyUpstream({ sourceRoot, provenance, nodeVersion, pnpmVersion, pnpmBin, run });
  assertNativeBuildsAllowed(verification.manifest);
  const plan = createBuildPlan({ sourceRoot: verification.sourceRoot, stagingRoot, workRoot, pnpmBin });
  if (dryRun) return { dryRun: true, verification, plan };

  await runBuildPlan(plan, runCommand);
  const copied = await copyStagingInputs({
    stagingRoot: plan.stagingRoot,
    policy,
    inputs: [
      { label: "next-standalone", source: path.join(plan.sourceRoot, "apps/web/.next/standalone"), destination: "web/standalone" },
      { label: "next-static", source: path.join(plan.sourceRoot, "apps/web/.next/static"), destination: "web/standalone/apps/web/.next/static" },
      { label: "next-public", source: path.join(plan.sourceRoot, "apps/web/public"), destination: "web/standalone/apps/web/public" },
      { label: "daemon-production-closure", source: plan.daemonDeployRoot, destination: "runtime/daemon" },
      { label: "web-sidecar-dist", source: path.join(plan.webDeployRoot, "dist"), destination: "runtime/packages/web-sidecar/dist" },
      { label: "web-sidecar-node-modules", source: path.join(plan.webDeployRoot, "node_modules"), destination: "runtime/packages/web-sidecar/node_modules" },
      { label: "web-sidecar-manifest", source: path.join(plan.webDeployRoot, "package.json"), destination: "runtime/packages/web-sidecar/package.json" },
      { label: "license", source: path.join(plan.sourceRoot, provenance.license.sourceFile), destination: "legal/LICENSE" },
      { label: "sbom", source: sbomPath, destination: "legal/SBOM.spdx.json" },
      { label: "provenance", source: path.join(moduleRoot, "provenance.json"), destination: "provenance.json" },
    ],
  });
  const nativeInventory = await inspectNativeRuntime({ artifactRoot: copied.root, metadata, target });
  const produced = await produceInventory({ stagingRoot: copied.root, metadata, provenance, policy, decisions, target });
  await writeArtifactManifest(copied.root, produced);
  return { dryRun: false, verification, plan, copied, nativeInventory, inventory: produced.inventory };
}

export async function runBuildPlan(plan, runCommand = defaultCommandRunner) {
  for (const entry of plan.commands) await runCommand(entry.command, entry.args, { cwd: entry.cwd, env: entry.env });
}

export async function writeArtifactManifest(stagingRoot, produced) {
  stagingAssert(produced?.inventory?.files && typeof produced.json === "string", "MANIFEST_INVALID", "producer result is invalid");
  const manifest = produced.inventory.files.find((file) => file.path === "artifact-manifest.json");
  stagingAssert(manifest != null && manifest.bytes === Buffer.byteLength(produced.json), "MANIFEST_INVALID", "manifest bytes do not bind the producer JSON output");
  const outputPath = path.join(stagingRoot, "artifact-manifest.json");
  const handle = await open(outputPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o644).catch((error) => stagingFail("MANIFEST_WRITE_FAILED", error.message));
  try {
    const payload = Buffer.from(produced.json, "utf8");
    let offset = 0;
    while (offset < payload.length) {
      const result = await handle.write(payload, offset, payload.length - offset, offset);
      stagingAssert(result.bytesWritten > 0, "MANIFEST_WRITE_FAILED", "manifest write made no progress");
      offset += result.bytesWritten;
    }
    const stat = await handle.stat();
    stagingAssert(stat.isFile() && stat.nlink === 1 && stat.size === payload.length, "MANIFEST_WRITE_FAILED", "manifest output did not remain an unlinked regular file");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function command(commandName, args, cwd, env = {}) {
  return Object.freeze({ command: commandName, args: Object.freeze([...args]), cwd, env: Object.freeze({ ...env }) });
}

function defaultWorkRoot(stagingRoot) {
  if (!path.isAbsolute(stagingRoot ?? "")) return "";
  return path.join(path.dirname(stagingRoot), `${path.basename(stagingRoot)}.build`);
}

function validateSbom(sbom) {
  stagingAssert(isPlainObject(sbom), "SBOM_INPUT_INVALID", "SBOM must be a JSON object");
  stagingAssert(sbom.spdxVersion === "SPDX-2.3", "SBOM_INPUT_INVALID", "SBOM must declare SPDX-2.3");
  for (const key of ["SPDXID", "name", "documentNamespace"]) stagingAssert(typeof sbom[key] === "string" && sbom[key].length > 0, "SBOM_INPUT_INVALID", `SBOM ${key} is required`);
}

async function readJsonRegular(filename, code) {
  stagingAssert(typeof filename === "string" && path.isAbsolute(filename), code, "input path must be absolute");
  const stat = await lstat(filename).catch((error) => stagingFail(code, error.message));
  stagingAssert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, code, "input must be an unlinked regular file");
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    stagingFail(code, `invalid JSON: ${error.message}`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function defaultCommandRunner(commandName, args, options) {
  await new Promise((resolve, reject) => {
    const child = spawn(commandName, args, { ...options, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${commandName} exited with ${signal ?? `code ${code}`}`)));
  });
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run") {
      stagingAssert(options.dryRun !== true, "ARGUMENT_DUPLICATE", "duplicate --dry-run");
      options.dryRun = true;
      continue;
    }
    stagingAssert(token?.startsWith("--"), "ARGUMENT_UNKNOWN", `unknown argument: ${token}`);
    const name = token.slice(2);
    stagingAssert(["source", "staging-root", "work-root", "sbom", "metadata", "target", "pnpm-bin"].includes(name), "ARGUMENT_UNKNOWN", `unknown argument: ${token}`);
    stagingAssert(options[name] === undefined, "ARGUMENT_DUPLICATE", `duplicate argument: ${token}`);
    const value = argv[index + 1];
    stagingAssert(typeof value === "string" && value.length > 0 && !value.startsWith("--"), "ARGUMENT_MISSING", `missing value for ${token}`);
    options[name] = value;
    index += 1;
  }
  for (const name of ["source", "staging-root", "sbom", "metadata", "target"]) stagingAssert(options[name] !== undefined, "ARGUMENT_MISSING", `required argument: --${name}`);
  return options;
}

async function main(argv) {
  const options = parseArguments(argv);
  const result = await prepareProductionStaging({
    sourceRoot: options.source,
    stagingRoot: options["staging-root"],
    workRoot: options["work-root"],
    sbomPath: options.sbom,
    metadataPath: options.metadata,
    targetPath: options.target,
    pnpmBin: options["pnpm-bin"],
    dryRun: options.dryRun === true,
  });
  const output = result.dryRun
    ? { dryRun: true, verification: result.verification, commands: result.plan.commands }
    : { dryRun: false, stagingRoot: result.copied.root, files: result.inventory.files.length, nativeEntries: result.nativeInventory.length };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
