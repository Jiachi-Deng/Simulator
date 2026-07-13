#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAtomicStagingTarget, publishSealedCandidate, sealCandidate, verifySealedCandidate, writeExclusiveCanonicalJson } from "./atomic-publisher.mjs";
import { buildDaemonExternalClosure, DAEMON_BUNDLE_BANNER } from "./daemon-external-closure.mjs";
import { inspectNativeRuntime } from "./native-inventory.mjs";
import { hoistMaterializedPnpmAliases, materializeBuildOutput } from "./materialize-build-output.mjs";
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
    invokePnpm(["rebuild", "better-sqlite3", "node-pty"]),
    invokePnpm(["--filter", "@open-design/packaged", "exec", "esbuild", path.join(workspace.checkoutRoot, "apps/daemon/dist/sidecar/index.js"), "--bundle", "--platform=node", "--format=esm", "--target=node24", `--banner:js=${DAEMON_BUNDLE_BANNER}`, "--external:better-sqlite3", "--external:node-pty", "--external:blake3-wasm", `--outfile=${path.join(workspace.daemonBundleRoot, "dist/sidecar/index.js")}`, `--metafile=${path.join(workspace.daemonBundleRoot, "esbuild-meta.json")}`]),
    invokePnpm(["--filter", "@open-design/packaged", "exec", "esbuild", path.join(workspace.checkoutRoot, "apps/web/dist/sidecar/index.js"), "--bundle", "--platform=node", "--format=esm", "--target=node24", `--outfile=${path.join(workspace.webDeployRoot, "dist/sidecar/index.js")}`, `--metafile=${path.join(workspace.webDeployRoot, "esbuild-meta.json")}`]),
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
  const sbomEvidence = validateSbom({ sbom: sbomInput.value, sha256: sbomInput.sha256, provenance, policy });
  const verification = await verifyUpstream({ sourceRoot, provenance, nodeBin, pnpmBin, run });
  const atomicTarget = await createAtomicStagingTarget(stagingRoot);
  let workspace;
  let primaryError;
  try {
    workspace = await createPrivateBuildWorkspace({ sourceRoot: verification.sourceRoot, workParent, provenance, run });
    const plan = createBuildPlan({ workspace, stagingRoot: atomicTarget.tempRoot, nodeBin: verification.toolchain.nodeExecutable, pnpmBin: verification.toolchain.pnpmExecutable, provenance });
    if (dryRun) return { dryRun: true, verification, plan: publicPlan(plan), patch: workspace.appliedPatch };

    const buildStartedAtMs = Date.now();
    const commandEvidence = await runBuildPlan(plan, runCommand, verification.toolchain.nodeExecutableSha256);
    await writeExclusiveCanonicalJson(path.join(workspace.webDeployRoot, "package.json"), { name: "@open-design/web-sidecar-staging", private: true, type: "module" });
    const postBuild = await verifyPostBuildWorkspace({ workspace, provenance, buildStartedAtMs, run });
    const daemonClosure = await buildDaemonExternalClosure({
      checkoutRoot: workspace.checkoutRoot,
      bundlePath: path.join(workspace.daemonBundleRoot, "dist/sidecar/index.js"),
      metafilePath: path.join(workspace.daemonBundleRoot, "esbuild-meta.json"),
      destinationRoot: workspace.daemonClosureRoot,
      buildStartedAtMs,
      target,
    });
    const normalization = await materializeBuildOutputs({ workspace, buildStartedAtMs, daemonClosure });
    const copied = await copyStagingInputs({
      stagingRoot: plan.stagingRoot,
      policy,
      target,
      inputs: [
        { label: "next-standalone", source: normalization.standalone.root, destination: "web/standalone" },
        { label: "next-static", source: path.join(workspace.checkoutRoot, "apps/web/.next/static"), destination: "web/standalone/apps/web/.next/static" },
        { label: "next-public", source: path.join(workspace.checkoutRoot, "apps/web/public"), destination: "web/standalone/apps/web/public" },
        { label: "daemon-production-closure", source: normalization.daemon.root, destination: "runtime/daemon" },
        { label: "web-sidecar-dist", source: path.join(normalization.web.root, "dist"), destination: "runtime/packages/web-sidecar/dist" },
        { label: "web-sidecar-manifest", source: path.join(normalization.web.root, "package.json"), destination: "runtime/packages/web-sidecar/package.json" },
        { label: "license", source: path.join(workspace.checkoutRoot, provenance.license.sourceFile), destination: "legal/LICENSE" },
        { label: "sbom", source: sbomPath, destination: "legal/SBOM.spdx.json" },
      ],
    });
    await writeExclusiveCanonicalJson(path.join(copied.root, "provenance.json"), provenance);
    const nativeInventory = await inspectNativeRuntime({
      artifactRoot: copied.root,
      metadata,
      target,
      nodeBin: verification.toolchain.nodeExecutable,
      runtime: { platform: verification.toolchain.platform, arch: verification.toolchain.arch, nodeAbi: verification.toolchain.nodeAbi },
      buildEvidence: { buildStartedAtMs, copied: copied.copied },
    });
    const runtimeVerification = createRuntimeVerification(copied.copied);
    const attestation = createBuildAttestation({
      provenance,
      verification,
      environment: plan.environment,
      commandEvidence,
      postBuild,
      normalization,
      nativeInventory,
      runtimeVerification,
      sbomEvidence,
      externalInputs: [
        ...verification.inputs.map((input) => ({ name: input.path, sha256: input.sha256 })),
        { name: "legal/SBOM.spdx.json", sha256: sbomInput.sha256 },
        { name: "resource-metadata.json", sha256: metadataInput.sha256 },
        { name: "target.json", sha256: targetInput.sha256 },
        { name: "provenance.json", sha256: digestCanonicalJson(provenance) },
        { name: "artifact-policy.json", sha256: policyInput.sha256 },
        { name: "resource-decisions.json", sha256: decisionsInput.sha256 },
      ],
    });
    await writeExclusiveCanonicalJson(path.join(copied.root, "build-attestation.json"), attestation);
    const produced = await produceInventory({ stagingRoot: copied.root, metadata, provenance, policy, decisions, attestation, target, deferRights: true });
    await writeArtifactManifest(copied.root, produced);
    await sealCandidate({ target: atomicTarget, inventory: produced.inventory });
    const runEvidence = await smokeStagedRuntime({ artifactRoot: copied.root, nodeBin: verification.toolchain.nodeExecutable, expectedInventory: produced.inventory });
    await verifySealedCandidate({ target: atomicTarget, inventory: produced.inventory });
    if (produced.deferredRightsErrors.length > 0) stagingFail("RIGHTS_GATE_FAILED", produced.deferredRightsErrors.map((error) => `${error.code}: ${error.message}`).join("; "));
    const publish = await publishSealedCandidate({ target: atomicTarget, inventory: produced.inventory });
    return { dryRun: false, verification, plan: publicPlan(plan), copied, nativeInventory, attestation, inventory: produced.inventory, runEvidence, publish };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    await workspace?.cleanup().catch((error) => cleanupErrors.push(error));
    await atomicTarget.cleanup().catch((error) => cleanupErrors.push(error));
    if (cleanupErrors.length > 0 && primaryError == null) stagingFail("STAGING_CLEANUP_FAILED", cleanupErrors.map((error) => error.message).join("; "));
  }
}

export async function runBuildPlan(plan, runCommand = defaultCommandRunner, executableSha256 = "") {
  const evidence = [];
  const environmentSha256 = digestCanonicalJson(reproducibleEnvironment(plan.environment));
  for (const [ordinal, entry] of plan.commands.entries()) {
    await runCommand(entry.command, entry.args, { cwd: entry.cwd, env: entry.env });
    evidence.push({
      ordinal,
      executable: "<node>",
      executableSha256,
      args: entry.args.map((value) => normalizeBuildValue(value, plan)),
      cwdRole: "private-detached-checkout",
      environmentSha256,
    });
  }
  return evidence;
}

export function createBuildAttestation({ provenance, verification, environment, commandEvidence, postBuild, normalization, nativeInventory, runtimeVerification, sbomEvidence, externalInputs }) {
  const toolchain = verification.toolchain;
  return {
    schemaVersion: 1,
    sourceCommit: provenance.source.commit,
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
    environment: reproducibleEnvironment(environment),
    inputs: [...externalInputs].sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name))),
    sbom: structuredClone(sbomEvidence),
    commands: commandEvidence,
    build: {
      privateDetachedCheckout: true,
      postBuildVerified: true,
      freshOutputs: postBuild.requiredOutputs.map((entry) => path.basename(entry) === "standalone" || path.basename(entry) === "static" ? `apps/web/.next/${path.basename(entry)}` : path.basename(entry)),
      normalization: publicNormalizationEvidence(normalization),
    },
    native: nativeInventory.map(({ sourceCtime: _sourceCtime, ...entry }) => entry),
    runtimeVerification: structuredClone(runtimeVerification),
  };
}

export function createRuntimeVerification(copied) {
  const byPath = new Map(copied.map((entry) => [entry.path, entry]));
  const entries = ["runtime/daemon/dist/sidecar/index.js", "runtime/packages/web-sidecar/dist/sidecar/index.js"].map((entryPath) => {
    const entry = byPath.get(entryPath);
    stagingAssert(entry?.sha256, "RUNTIME_VERIFICATION_INVALID", `runtime entry copy evidence is missing: ${entryPath}`);
    return { entryPath, entrySha256: entry.sha256 };
  });
  return { method: "sealed-candidate-loopback-v1", candidateMustBeSealed: true, entries, expected: { daemonVersion: "0.14.1", webStatusMinimum: 200 } };
}

function reproducibleEnvironment(environment) {
  const replacements = {
    HOME: "<private-home>", TMPDIR: "<private-tmp>/", XDG_CACHE_HOME: "<private-cache>",
    npm_config_cache: "<private-cache>/npm", npm_config_store_dir: "<private-store>", PATH: "<node-dir>:/usr/bin:/bin",
  };
  return Object.fromEntries(Object.keys(environment).sort().map((key) => [key, replacements[key] ?? environment[key]]));
}

function normalizeBuildValue(value, plan) {
  const replacements = [
    [plan.workspace.checkoutRoot, "<private-checkout>"], [plan.workspace.daemonBundleRoot, "<daemon-bundle>"],
    [plan.workspace.webDeployRoot, "<web-sidecar>"], [plan.workspace.root, "<private-workspace>"],
    [plan.pnpmBin, "<pnpm>"], [plan.nodeBin, "<node>"],
  ].filter(([actual]) => typeof actual === "string" && actual.length > 0).sort((left, right) => right[0].length - left[0].length);
  return replacements.reduce((result, [actual, replacement]) => result.split(actual).join(replacement), value);
}

export async function materializeBuildOutputs({ workspace, buildStartedAtMs, daemonClosure } = {}) {
  stagingAssert(path.isAbsolute(workspace?.normalizedRoot ?? ""), "MATERIALIZE_ROOT_INVALID", "private normalization root is required");
  await mkdir(workspace.normalizedRoot, { mode: 0o700 });
  const definitions = [
    { role: "next-standalone", prefix: "web/standalone", source: path.join(workspace.checkoutRoot, "apps/web/.next/standalone"), destination: path.join(workspace.normalizedRoot, "next-standalone") },
    { role: "web-sidecar-closure", prefix: "runtime/packages/web-sidecar", source: workspace.webDeployRoot, destination: path.join(workspace.normalizedRoot, "web-sidecar") },
  ];
  const results = [];
  for (const definition of definitions) {
    const result = await materializeBuildOutput({ sourceRoot: definition.source, destinationRoot: definition.destination, buildStartedAtMs });
    await hoistMaterializedPnpmAliases({ materialized: result, buildStartedAtMs });
    results.push({ ...definition, ...result });
  }
  stagingAssert(daemonClosure?.root && Array.isArray(daemonClosure.nativeOrigins), "DAEMON_CLOSURE_INVALID", "daemon closure evidence is required");
  const daemon = { role: "daemon-esm-bundle-external-closure", prefix: "runtime/daemon", ...daemonClosure };
  results.push(daemon);
  return Object.assign({ outputs: results, daemonClosure }, Object.fromEntries(results.map((entry) => [entry.role === "next-standalone" ? "standalone" : entry.role === "daemon-esm-bundle-external-closure" ? "daemon" : "web", entry])));
}

function publicNormalizationEvidence(normalization) {
  const outputs = normalization.outputs.map((entry) => ({ role: entry.role, symlinksMaterialized: entry.symlinksMaterialized, hardlinksMaterialized: entry.hardlinksMaterialized, virtualStorePackagesHoisted: entry.virtualStorePackagesHoisted }));
  const nativeOrigins = normalization.outputs.flatMap((entry) => entry.nativeOrigins.map((origin) => ({
    path: `${entry.prefix}/${origin.path}`,
    sha256: origin.sha256,
    freshFromBuild: true,
    mode: origin.mode,
  }))).sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return {
    method: "daemon-esm-bundle-external-closure-v1",
    artifactSymlinksForbidden: true,
    outputs,
    nativeOrigins,
    daemonClosure: {
      method: "esbuild-node24-esm-create-require-banner-v1",
      bundleSha256: normalization.daemonClosure.bundleSha256,
      metafileSha256: normalization.daemonClosure.metafileSha256,
      metafileInputCount: normalization.daemonClosure.metafileInputCount,
      metafileOutput: "runtime/daemon/dist/sidecar/index.js",
      externalAllowlist: [...normalization.daemonClosure.externalAllowlist],
      files: normalization.daemonClosure.files.map((entry) => ({ path: `runtime/daemon/${entry.path}`, sha256: entry.sha256 })),
    },
  };
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

export function validateSbom({ sbom, sha256, provenance, policy } = {}) {
  stagingAssert(isPlainObject(sbom), "SBOM_INPUT_INVALID", "SBOM must be a JSON object");
  stagingAssert(sbom.spdxVersion === "SPDX-2.3", "SBOM_INPUT_INVALID", "SBOM must declare SPDX-2.3");
  for (const key of ["SPDXID", "name", "documentNamespace"]) stagingAssert(typeof sbom[key] === "string" && sbom[key].length > 0, "SBOM_INPUT_INVALID", `SBOM ${key} is required`);
  stagingAssert(policy?.sbomRequirements && Object.values(policy.sbomRequirements).every((value) => value === true), "SBOM_POLICY_INVALID", "SBOM package, lock, checksum, license and notice coverage must all be required");
  stagingAssert(Array.isArray(sbom.packages) && sbom.packages.length > 0, "SBOM_INPUT_INVALID", "SBOM packages must not be empty");
  stagingAssert(Array.isArray(sbom.documentDescribes), "SBOM_INPUT_INVALID", "SBOM documentDescribes is required");
  const lockAnnotation = sbom.annotations?.find((entry) => entry?.annotationType === "OTHER" && entry.comment === `pnpm-lock.yaml sha256:${provenance.lockfile.sha256}`);
  stagingAssert(lockAnnotation != null, "SBOM_LOCK_MISMATCH", "SBOM must bind the pinned pnpm lockfile digest");

  const expected = [...provenance.sbom.requiredPackages].sort(comparePackage);
  const actual = [...sbom.packages].sort(comparePackage);
  stagingAssert(actual.length === expected.length, "SBOM_PACKAGE_COVERAGE_MISSING", "SBOM must cover the exact pinned runtime package set");
  const evidence = [];
  const described = new Set(sbom.documentDescribes);
  for (let index = 0; index < expected.length; index += 1) {
    const pinned = expected[index];
    const entry = actual[index];
    stagingAssert(entry?.name === pinned.name && entry.versionInfo === pinned.version, "SBOM_PACKAGE_COVERAGE_MISSING", `SBOM package/version mismatch at ${pinned.name}@${pinned.version}`);
    stagingAssert(typeof entry.SPDXID === "string" && described.has(entry.SPDXID), "SBOM_PACKAGE_COVERAGE_MISSING", `SBOM package is not described: ${pinned.name}@${pinned.version}`);
    stagingAssert(entry.filesAnalyzed === false && entry.downloadLocation === "NOASSERTION", "SBOM_PACKAGE_INVALID", `SBOM package analysis mode is invalid: ${pinned.name}@${pinned.version}`);
    const checksum = entry.checksums?.find((candidate) => candidate?.algorithm === "SHA512")?.checksumValue;
    stagingAssert(checksum === pinned.contentSha512, "SBOM_CONTENT_DIGEST_MISMATCH", `SBOM content digest mismatch: ${pinned.name}@${pinned.version}`);
    stagingAssert(entry.licenseDeclared === pinned.licenseDeclared && entry.licenseConcluded === pinned.licenseDeclared, "SBOM_LICENSE_MISSING", `SBOM license coverage mismatch: ${pinned.name}@${pinned.version}`);
    stagingAssert(entry.comment === `notice=${pinned.noticeStatus}`, "SBOM_NOTICE_MISSING", `SBOM notice coverage mismatch: ${pinned.name}@${pinned.version}`);
    const expectedPurl = packagePurl(pinned.name, pinned.version);
    stagingAssert(entry.externalRefs?.some((reference) => reference?.referenceCategory === "PACKAGE-MANAGER" && reference.referenceType === "purl" && reference.referenceLocator === expectedPurl), "SBOM_LOCK_MISMATCH", `SBOM package lacks exact lock resolution identity: ${pinned.name}@${pinned.version}`);
    evidence.push({ name: pinned.name, version: pinned.version, contentSha512: pinned.contentSha512, licenseDeclared: pinned.licenseDeclared, noticeStatus: pinned.noticeStatus });
  }
  return { documentSha256: sha256, lockfileSha256: provenance.lockfile.sha256, packages: evidence };
}

function packagePurl(name, version) {
  return `pkg:npm/${name.startsWith("@") ? `%40${name.slice(1)}` : name}@${version}`;
}

function comparePackage(left, right) {
  return Buffer.compare(Buffer.from(`${left.name}@${left.version ?? left.versionInfo}`), Buffer.from(`${right.name}@${right.version ?? right.versionInfo}`));
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
    : { dryRun: false, stagingRoot: result.publish.root, files: result.inventory.files.length, nativeEntries: result.nativeInventory.length, smoke: result.runEvidence.ok, publish: result.publish };
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
