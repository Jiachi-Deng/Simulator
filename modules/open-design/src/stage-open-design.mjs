#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAtomicStagingTarget, sealAndPublish, writeExclusiveCanonicalJson } from "./atomic-publisher.mjs";
import { inspectNativeRuntime } from "./native-inventory.mjs";
import { materializeBuildOutput } from "./materialize-build-output.mjs";
import { createHermeticBuildEnvironment, createPrivateBuildWorkspace, verifyPostBuildWorkspace } from "./private-build-workspace.mjs";
import { produceInventory } from "./produce-inventory.mjs";
import { copyStagingInputs } from "./staging-copier.mjs";
import { smokeStagedRuntime } from "./staged-runtime-smoke.mjs";
import { stagingAssert, stagingFail } from "./staging-error.mjs";
import { digestCanonicalJson } from "./validate-artifact.mjs";
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

export function createBuildPlan({ workspace, stagingRoot, nodeBin, pnpmBin, provenance } = {}) {
  stagingAssert(path.isAbsolute(workspace?.checkoutRoot ?? ""), "BUILD_WORKSPACE_INVALID", "private checkout is required");
  stagingAssert(path.isAbsolute(stagingRoot ?? ""), "STAGING_ROOT_INVALID", "staging root must be absolute");
  stagingAssert(path.isAbsolute(nodeBin ?? "") && path.isAbsolute(pnpmBin ?? ""), "TOOLCHAIN_PATH_INVALID", "exact Node and pnpm executable paths are required");
  const environment = createHermeticBuildEnvironment({ workspace, nodeBin, provenance });
  const invokePnpm = (args, extraEnv = {}) => command(nodeBin, [pnpmBin, ...args], workspace.checkoutRoot, { ...environment, ...extraEnv });
  const commands = [
    invokePnpm(["install", "--frozen-lockfile"]),
    ...BUILD_PACKAGES.map((packageName) => invokePnpm(["--filter", packageName, "build"])),
    invokePnpm(["--filter", "@open-design/web", "build"], { OD_WEB_OUTPUT_MODE: "standalone" }),
    invokePnpm(["--filter", "@open-design/web", "build:sidecar"]),
    invokePnpm(["--offline", "--frozen-lockfile", "--ignore-scripts", "--filter", "@open-design/daemon", "deploy", "--prod", "--legacy", workspace.daemonDeployRoot]),
    invokePnpm(["--offline", "--frozen-lockfile", "--ignore-scripts", "--filter", "@open-design/web", "deploy", "--prod", "--legacy", workspace.webDeployRoot]),
  ];
  return { stagingRoot, workspace, nodeBin, pnpmBin, environment, commands };
}

export async function prepareProductionStaging({
  sourceRoot,
  stagingRoot,
  workParent,
  sbomPath,
  metadataPath,
  targetPath,
  nodeBin,
  pnpmBin,
  dryRun = false,
  run,
  runCommand = defaultCommandRunner,
} = {}) {
  const [provenanceInput, policyInput, decisionsInput, metadataInput, targetInput, sbomInput] = await Promise.all([
    readJsonInput(path.join(moduleRoot, "provenance.json"), "PROVENANCE_INVALID"),
    readJsonInput(path.join(moduleRoot, "artifact-policy.json"), "STAGING_POLICY_INVALID"),
    readJsonInput(path.join(moduleRoot, "resource-decisions.json"), "RESOURCE_DECISIONS_INVALID"),
    readJsonInput(metadataPath, "METADATA_INPUT_INVALID"),
    readJsonInput(targetPath, "TARGET_INPUT_INVALID"),
    readJsonInput(sbomPath, "SBOM_INPUT_INVALID"),
  ]);
  const provenance = provenanceInput.value;
  const policy = policyInput.value;
  const decisions = decisionsInput.value;
  const metadata = metadataInput.value;
  const target = targetInput.value;
  validateSbom(sbomInput.value);
  const verification = await verifyUpstream({ sourceRoot, provenance, nodeBin, pnpmBin, run });
  const atomicTarget = await createAtomicStagingTarget(stagingRoot);
  let workspace;
  try {
    workspace = await createPrivateBuildWorkspace({ sourceRoot: verification.sourceRoot, workParent, provenance, run });
    const plan = createBuildPlan({ workspace, stagingRoot: atomicTarget.tempRoot, nodeBin: verification.toolchain.nodeExecutable, pnpmBin: verification.toolchain.pnpmExecutable, provenance });
    if (dryRun) return { dryRun: true, verification, plan: publicPlan(plan), patch: workspace.appliedPatch };

    const buildStartedAtMs = Date.now();
    const commandEvidence = await runBuildPlan(plan, runCommand, verification.toolchain.nodeExecutableSha256);
    const normalization = await materializeBuildOutputs({ workspace, buildStartedAtMs });
    const postBuild = await verifyPostBuildWorkspace({ workspace, provenance, buildStartedAtMs, run });
    const copied = await copyStagingInputs({
      stagingRoot: plan.stagingRoot,
      policy,
      inputs: [
        { label: "next-standalone", source: normalization.standalone.root, destination: "web/standalone" },
        { label: "next-static", source: path.join(workspace.checkoutRoot, "apps/web/.next/static"), destination: "web/standalone/apps/web/.next/static" },
        { label: "next-public", source: path.join(workspace.checkoutRoot, "apps/web/public"), destination: "web/standalone/apps/web/public" },
        { label: "daemon-production-closure", source: normalization.daemon.root, destination: "runtime/daemon" },
        { label: "web-sidecar-dist", source: path.join(normalization.web.root, "dist"), destination: "runtime/packages/web-sidecar/dist" },
        { label: "web-sidecar-node-modules", source: path.join(normalization.web.root, "node_modules"), destination: "runtime/packages/web-sidecar/node_modules" },
        { label: "web-sidecar-manifest", source: path.join(normalization.web.root, "package.json"), destination: "runtime/packages/web-sidecar/package.json" },
        { label: "license", source: path.join(workspace.checkoutRoot, provenance.license.sourceFile), destination: "legal/LICENSE" },
        { label: "sbom", source: sbomPath, destination: "legal/SBOM.spdx.json" },
        { label: "provenance", source: path.join(moduleRoot, "provenance.json"), destination: "provenance.json" },
      ],
    });
    const nativeInventory = await inspectNativeRuntime({
      artifactRoot: copied.root,
      metadata,
      target,
      nodeBin: verification.toolchain.nodeExecutable,
      runtime: { platform: verification.toolchain.platform, arch: verification.toolchain.arch, nodeAbi: verification.toolchain.nodeAbi },
      buildEvidence: { buildStartedAtMs, copied: copied.copied },
    });
    const smoke = await smokeStagedRuntime({ artifactRoot: copied.root, nodeBin: verification.toolchain.nodeExecutable });
    const buildFinishedAt = new Date().toISOString();
    const attestation = createBuildAttestation({
      provenance,
      verification,
      environment: plan.environment,
      commandEvidence,
      postBuild,
      normalization,
      buildStartedAtMs,
      buildFinishedAt,
      nativeInventory,
      smoke,
      externalInputs: [
        ...verification.inputs.map((input) => ({ name: input.path, sha256: input.sha256 })),
        { name: "legal/SBOM.spdx.json", sha256: sbomInput.sha256 },
        { name: "resource-metadata.json", sha256: metadataInput.sha256 },
        { name: "target.json", sha256: targetInput.sha256 },
        { name: "provenance.json", sha256: provenanceInput.sha256 },
        { name: "artifact-policy.json", sha256: policyInput.sha256 },
        { name: "resource-decisions.json", sha256: decisionsInput.sha256 },
      ],
    });
    await writeExclusiveCanonicalJson(path.join(copied.root, "build-attestation.json"), attestation);
    const produced = await produceInventory({ stagingRoot: copied.root, metadata, provenance, policy, decisions, attestation, target });
    await writeArtifactManifest(copied.root, produced);
    const publish = await sealAndPublish({ target: atomicTarget, inventory: produced.inventory });
    return { dryRun: false, verification, plan: publicPlan(plan), copied, nativeInventory, attestation, inventory: produced.inventory, publish };
  } finally {
    await workspace?.cleanup().catch((error) => {
      if (!atomicTarget.published) throw error;
    });
    await atomicTarget.cleanup();
  }
}

export async function runBuildPlan(plan, runCommand = defaultCommandRunner, executableSha256 = "") {
  const evidence = [];
  const environmentSha256 = digestCanonicalJson(plan.environment);
  for (const [ordinal, entry] of plan.commands.entries()) {
    const startedAt = new Date().toISOString();
    await runCommand(entry.command, entry.args, { cwd: entry.cwd, env: entry.env });
    evidence.push({
      ordinal,
      executable: entry.command,
      executableSha256,
      args: [...entry.args],
      cwdRole: "private-detached-checkout",
      environmentSha256,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
  }
  return evidence;
}

export function createBuildAttestation({ provenance, verification, environment, commandEvidence, postBuild, normalization, buildStartedAtMs, buildFinishedAt, nativeInventory, smoke, externalInputs }) {
  const toolchain = verification.toolchain;
  return {
    schemaVersion: 1,
    sourceCommit: provenance.source.commit,
    createdAt: buildFinishedAt,
    patch: {
      path: provenance.simulatorPatch.path,
      sha256: provenance.simulatorPatch.sha256,
      postimageSha256: provenance.simulatorPatch.postimageSha256,
      changedPaths: [...provenance.simulatorPatch.changedPaths],
    },
    toolchain: {
      nodeVersion: toolchain.nodeVersion.replace(/^v/u, ""),
      nodeAbi: toolchain.nodeAbi,
      platform: toolchain.platform,
      arch: toolchain.arch,
      nodeExecutableSha256: toolchain.nodeExecutableSha256,
      pnpmVersion: toolchain.pnpmVersion,
      pnpmExecutableSha256: toolchain.pnpmExecutableSha256,
    },
    host: { platform: os.platform(), arch: os.arch(), release: os.release(), type: os.type() },
    environment: { ...environment },
    inputs: [...externalInputs].sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name))),
    commands: commandEvidence,
    build: {
      startedAt: new Date(buildStartedAtMs).toISOString(),
      finishedAt: buildFinishedAt,
      privateDetachedCheckout: true,
      postBuildVerified: true,
      freshOutputs: postBuild.requiredOutputs.map((entry) => path.basename(entry) === "standalone" || path.basename(entry) === "static" ? `apps/web/.next/${path.basename(entry)}` : path.basename(entry)),
      normalization: publicNormalizationEvidence(normalization),
    },
    native: nativeInventory,
    smoke,
  };
}

export async function materializeBuildOutputs({ workspace, buildStartedAtMs } = {}) {
  stagingAssert(path.isAbsolute(workspace?.normalizedRoot ?? ""), "MATERIALIZE_ROOT_INVALID", "private normalization root is required");
  await mkdir(workspace.normalizedRoot, { mode: 0o700 });
  const definitions = [
    { role: "next-standalone", prefix: "web/standalone", source: path.join(workspace.checkoutRoot, "apps/web/.next/standalone"), destination: path.join(workspace.normalizedRoot, "next-standalone") },
    { role: "daemon-production-closure", prefix: "runtime/daemon", source: workspace.daemonDeployRoot, destination: path.join(workspace.normalizedRoot, "daemon") },
    { role: "web-sidecar-closure", prefix: "runtime/packages/web-sidecar", source: workspace.webDeployRoot, destination: path.join(workspace.normalizedRoot, "web-sidecar") },
  ];
  const results = [];
  for (const definition of definitions) {
    const result = await materializeBuildOutput({ sourceRoot: definition.source, destinationRoot: definition.destination, buildStartedAtMs });
    results.push({ ...definition, ...result });
  }
  return Object.assign({ outputs: results }, Object.fromEntries(results.map((entry) => [entry.role === "next-standalone" ? "standalone" : entry.role === "daemon-production-closure" ? "daemon" : "web", entry])));
}

function publicNormalizationEvidence(normalization) {
  const outputs = normalization.outputs.map((entry) => ({ role: entry.role, symlinksMaterialized: entry.symlinksMaterialized }));
  const nativeOrigins = normalization.outputs.flatMap((entry) => entry.nativeOrigins.map((origin) => ({
    path: `${entry.prefix}/${origin.path}`,
    sha256: origin.sha256,
    sourceCtime: origin.sourceCtime,
  }))).sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return { method: "contained-symlink-materialization-v1", artifactSymlinksForbidden: true, outputs, nativeOrigins };
}

export async function writeArtifactManifest(stagingRoot, produced) {
  stagingAssert(produced?.inventory?.files && typeof produced.json === "string", "MANIFEST_INVALID", "producer result is invalid");
  const manifest = produced.inventory.files.find((file) => file.path === "artifact-manifest.json");
  stagingAssert(manifest != null && manifest.bytes === Buffer.byteLength(produced.json), "MANIFEST_INVALID", "manifest bytes do not bind the producer JSON output");
  const outputPath = path.join(stagingRoot, "artifact-manifest.json");
  const handle = await open(outputPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600).catch((error) => stagingFail("MANIFEST_WRITE_FAILED", error.message));
  try {
    const payload = Buffer.from(produced.json, "utf8");
    let offset = 0;
    while (offset < payload.length) {
      const result = await handle.write(payload, offset, payload.length - offset, offset);
      stagingAssert(result.bytesWritten > 0, "MANIFEST_WRITE_FAILED", "manifest write made no progress");
      offset += result.bytesWritten;
    }
    const stat = await handle.stat();
    stagingAssert(stat.isFile() && stat.nlink === 1 && stat.uid === currentUid() && stat.size === payload.length, "MANIFEST_WRITE_FAILED", "manifest output did not remain an owner-built unlinked regular file");
    await handle.sync().catch((error) => stagingFail("PUBLISH_DURABILITY_UNSUPPORTED", error.message));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function command(commandName, args, cwd, env) {
  return Object.freeze({ command: commandName, args: Object.freeze([...args]), cwd, env: Object.freeze({ ...env }) });
}

function publicPlan(plan) {
  return {
    stagingRoot: plan.stagingRoot,
    checkoutRoot: plan.workspace.checkoutRoot,
    commands: plan.commands.map((entry) => ({ command: entry.command, args: [...entry.args], cwd: entry.cwd, env: { ...entry.env } })),
  };
}

function validateSbom(sbom) {
  stagingAssert(isPlainObject(sbom), "SBOM_INPUT_INVALID", "SBOM must be a JSON object");
  stagingAssert(sbom.spdxVersion === "SPDX-2.3", "SBOM_INPUT_INVALID", "SBOM must declare SPDX-2.3");
  for (const key of ["SPDXID", "name", "documentNamespace"]) stagingAssert(typeof sbom[key] === "string" && sbom[key].length > 0, "SBOM_INPUT_INVALID", `SBOM ${key} is required`);
}

async function readJsonInput(filename, code) {
  stagingAssert(typeof filename === "string" && path.isAbsolute(filename), code, "input path must be absolute");
  const stat = await lstat(filename).catch((error) => stagingFail(code, error.message));
  stagingAssert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === currentUid(), code, "input must be an owner-built unlinked regular file");
  const bytes = await readFile(filename).catch((error) => stagingFail(code, error.message));
  try {
    return { value: JSON.parse(bytes), sha256: createHash("sha256").update(bytes).digest("hex") };
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
    stagingAssert(["source", "staging-root", "work-parent", "sbom", "metadata", "target", "node-bin", "pnpm-bin"].includes(name), "ARGUMENT_UNKNOWN", `unknown argument: ${token}`);
    stagingAssert(options[name] === undefined, "ARGUMENT_DUPLICATE", `duplicate argument: ${token}`);
    const value = argv[index + 1];
    stagingAssert(typeof value === "string" && value.length > 0 && !value.startsWith("--"), "ARGUMENT_MISSING", `missing value for ${token}`);
    options[name] = value;
    index += 1;
  }
  for (const name of ["source", "staging-root", "work-parent", "sbom", "metadata", "target", "node-bin", "pnpm-bin"]) stagingAssert(options[name] !== undefined, "ARGUMENT_MISSING", `required argument: --${name}`);
  return options;
}

async function main(argv) {
  const options = parseArguments(argv);
  const result = await prepareProductionStaging({
    sourceRoot: path.resolve(options.source),
    stagingRoot: path.resolve(options["staging-root"]),
    workParent: path.resolve(options["work-parent"]),
    sbomPath: path.resolve(options.sbom),
    metadataPath: path.resolve(options.metadata),
    targetPath: path.resolve(options.target),
    nodeBin: path.resolve(options["node-bin"]),
    pnpmBin: path.resolve(options["pnpm-bin"]),
    dryRun: options.dryRun === true,
  });
  const output = result.dryRun
    ? { dryRun: true, verification: result.verification, patch: { path: result.patch.path, sha256: result.patch.sha256 }, commands: result.plan.commands }
    : { dryRun: false, stagingRoot: result.publish.root, files: result.inventory.files.length, nativeEntries: result.nativeInventory.length, smoke: result.attestation.smoke.ok, publish: result.publish };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function currentUid() {
  stagingAssert(typeof process.getuid === "function", "OWNER_CHECK_UNSUPPORTED", "current platform cannot verify filesystem ownership");
  return process.getuid();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
