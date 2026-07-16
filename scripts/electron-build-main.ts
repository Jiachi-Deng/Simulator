/**
 * Cross-platform main process build script
 * Loads .env and passes OAuth defines to esbuild
 */

import { spawn } from "bun";
import { existsSync, readFileSync, statSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import {
  EMBEDDED_BUILD_VARIABLES,
  DISABLE_UPDATES_ENV,
  embeddedBuildValue,
  isPublicBuild,
} from "./build-environment";
import { resolveBuildPolicy, writeBuildPolicy } from "./build-policy";
import {
  copyPiAgentServer,
  copySessionServer,
  verifyMcpServersExist,
  type BuildConfig,
} from "./build/common";
import {
  currentPackagedArch,
  currentPackagedPlatform,
  validatePackagedServerResources,
} from "./packaged-server-resources";
import {
  normalizeHostAgentWorkerMode,
  rebuildAndCopyHostAgentShim,
} from "../apps/electron/scripts/copy-assets";

const ROOT_DIR = join(import.meta.dir, "..");
const DIST_DIR = join(ROOT_DIR, "apps/electron/dist");
const OUTPUT_FILE = join(DIST_DIR, "main.cjs");
const HOST_AGENT_WORKER_OUTPUT = join(DIST_DIR, "resources/host-agent/worker.cjs");
const INTERCEPTOR_SOURCE = join(ROOT_DIR, "packages/shared/src/unified-network-interceptor.ts");
const INTERCEPTOR_OUTPUT = join(DIST_DIR, "interceptor.cjs");
const SESSION_TOOLS_CORE_DIR = join(ROOT_DIR, "packages/session-tools-core");
const SESSION_SERVER_DIR = join(ROOT_DIR, "packages/session-mcp-server");
const SESSION_SERVER_OUTPUT = join(SESSION_SERVER_DIR, "dist/index.js");
const PI_AGENT_SERVER_DIR = join(ROOT_DIR, "packages/pi-agent-server");
const PI_AGENT_SERVER_OUTPUT = join(PI_AGENT_SERVER_DIR, "dist/index.js");
const WA_WORKER_DIR = join(ROOT_DIR, "packages/messaging-whatsapp-worker");
const WA_WORKER_SOURCE = join(WA_WORKER_DIR, "src/worker.ts");
const WA_WORKER_OUTPUT = join(WA_WORKER_DIR, "dist/worker.cjs");

// Load .env file if it exists
function loadEnvFile(): void {
  if (isPublicBuild()) {
    return;
  }

  const envPath = join(ROOT_DIR, ".env");
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex > 0) {
          const key = trimmed.slice(0, eqIndex).trim();
          let value = trimmed.slice(eqIndex + 1).trim();
          if ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          process.env[key] = value;
        }
      }
    }
  }
}

// Get build-time defines for esbuild (OAuth, Sentry DSN, etc.)
// NOTE: Sentry source map upload is intentionally disabled for the main process.
// To enable in the future, add @sentry/esbuild-plugin. See apps/electron/CLAUDE.md.
// NOTE: Google OAuth credentials are NOT baked into the build - users provide their own
// via source config. See README_FOR_OSS.md for setup instructions.
function getBuildDefines(policy = resolveBuildPolicy()): string[] {
  const credentialDefines = EMBEDDED_BUILD_VARIABLES.map((varName) => {
    const value = embeddedBuildValue(varName);
    return `--define:process.env.${varName}="${value}"`;
  });
  return [
    ...credentialDefines,
    `--define:process.env.${DISABLE_UPDATES_ENV}="${policy.updatesDisabled ? "1" : "0"}"`,
  ];
}

// Wait for file to stabilize (no size changes)
async function waitForFileStable(filePath: string, timeoutMs = 10000): Promise<boolean> {
  const startTime = Date.now();
  let lastSize = -1;
  let stableCount = 0;

  while (Date.now() - startTime < timeoutMs) {
    if (!existsSync(filePath)) {
      await Bun.sleep(100);
      continue;
    }

    const stats = statSync(filePath);
    if (stats.size === lastSize) {
      stableCount++;
      if (stableCount >= 3) {
        return true;
      }
    } else {
      stableCount = 0;
      lastSize = stats.size;
    }

    await Bun.sleep(100);
  }

  return false;
}

// Verify a JavaScript file is syntactically valid
async function verifyJsFile(filePath: string): Promise<{ valid: boolean; error?: string }> {
  if (!existsSync(filePath)) {
    return { valid: false, error: "File does not exist" };
  }

  const stats = statSync(filePath);
  if (stats.size === 0) {
    return { valid: false, error: "File is empty" };
  }

  const proc = spawn({
    cmd: ["node", "--check", filePath],
    stdout: "pipe",
    stderr: "pipe",
  });

  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    return { valid: false, error: stderr || "Syntax error" };
  }

  return { valid: true };
}

// Verify Session Tools Core package exists (raw TypeScript, bundled by consumers)
// No build step needed - it exports TypeScript directly like other packages
function verifySessionToolsCore(): void {
  console.log("🔍 Verifying Session Tools Core...");

  // Verify source exists
  const sourceFile = join(SESSION_TOOLS_CORE_DIR, "src/index.ts");
  if (!existsSync(sourceFile)) {
    console.error("❌ Session tools core source not found at", sourceFile);
    process.exit(1);
  }

  console.log("✅ Session tools core verified");
}

// Build the unified network interceptor (bundled CJS loaded via --require into Node-based SDK subprocesses)
async function buildInterceptor(): Promise<void> {
  console.log("🔌 Building unified network interceptor...");

  const proc = spawn({
    cmd: [
      "bun", "run", "esbuild",
      INTERCEPTOR_SOURCE,
      "--bundle",
      "--platform=node",
      "--format=cjs",
      `--outfile=${INTERCEPTOR_OUTPUT}`,
    ],
    cwd: ROOT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error("❌ Interceptor build failed with exit code", exitCode);
    process.exit(exitCode);
  }

  if (!existsSync(INTERCEPTOR_OUTPUT)) {
    console.error("❌ Interceptor output not found at", INTERCEPTOR_OUTPUT);
    process.exit(1);
  }

  console.log("✅ Interceptor built successfully");
}

// Build the Session MCP Server (provides session-scoped tools like SubmitPlan for Codex sessions)
async function buildSessionServer(): Promise<void> {
  console.log("📋 Building Session MCP Server...");

  const distDir = join(SESSION_SERVER_DIR, "dist");
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  const proc = spawn({
    cmd: [
      "bun", "build",
      join(SESSION_SERVER_DIR, "src/index.ts"),
      "--outfile", SESSION_SERVER_OUTPUT,
      "--target", "node",
      "--format", "cjs",
    ],
    cwd: ROOT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error("❌ Session server build failed with exit code", exitCode);
    process.exit(exitCode);
  }

  // Verify output exists
  if (!existsSync(SESSION_SERVER_OUTPUT)) {
    console.error("❌ Session server output not found at", SESSION_SERVER_OUTPUT);
    process.exit(1);
  }

  console.log("✅ Session server built successfully");
}

// Build the Pi Agent Server (subprocess for Pi SDK sessions)
async function buildPiAgentServer(): Promise<void> {
  if (!existsSync(join(PI_AGENT_SERVER_DIR, "src"))) {
    throw new Error(`Pi agent server source not found at ${join(PI_AGENT_SERVER_DIR, "src")}`);
  }

  console.log("🥧 Building Pi Agent Server...");

  const distDir = join(PI_AGENT_SERVER_DIR, "dist");
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  // Use --target=bun --format=esm because the Pi SDK is ESM-only. All non-runtime
  // dependencies must stay bundled so packaged validation can enforce closure.
  const proc = spawn({
    cmd: [
      "bun", "build",
      join(PI_AGENT_SERVER_DIR, "src/index.ts"),
      "--outfile", PI_AGENT_SERVER_OUTPUT,
      "--target", "bun",
      "--format", "esm",
    ],
    cwd: ROOT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error("❌ Pi agent server build failed with exit code", exitCode);
    process.exit(exitCode);
  }

  // Verify output exists
  if (!existsSync(PI_AGENT_SERVER_OUTPUT)) {
    console.error("❌ Pi agent server output not found at", PI_AGENT_SERVER_OUTPUT);
    process.exit(1);
  }

  console.log("✅ Pi agent server built successfully");
}

// Build the WhatsApp worker (Baileys-backed subprocess spawned by WhatsAppAdapter)
async function buildWhatsAppWorker(): Promise<void> {
  if (!existsSync(WA_WORKER_SOURCE)) {
    console.log("⏭️  WhatsApp worker skipped (package not found)");
    return;
  }

  console.log("📨 Building WhatsApp worker...");

  const workerDistDir = join(WA_WORKER_DIR, "dist");
  if (!existsSync(workerDistDir)) {
    mkdirSync(workerDistDir, { recursive: true });
  }

  // Baileys is bundled INTO worker.cjs (not external) so the packaged app is
  // self-contained. Dynamic `import('@whiskeysockets/baileys')` is resolved
  // at bundle time because the specifier is a literal.
  const proc = spawn({
    cmd: [
      "bun", "run", "esbuild",
      WA_WORKER_SOURCE,
      "--bundle",
      "--platform=node",
      "--format=cjs",
      "--target=node20",
      `--outfile=${WA_WORKER_OUTPUT}`,
      "--external:electron",
      // Baileys' runtime-optional features — wrapped in try/catch at the
      // call site and not used by Simulator (we send text + documents, no
      // link previews, no inline image processing, no terminal QR).
      "--external:link-preview-js",
      "--external:qrcode-terminal",
      "--external:jimp",
    ],
    cwd: ROOT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error("❌ WhatsApp worker build failed with exit code", exitCode);
    process.exit(exitCode);
  }

  if (!existsSync(WA_WORKER_OUTPUT)) {
    console.error("❌ WhatsApp worker output not found at", WA_WORKER_OUTPUT);
    process.exit(1);
  }

  console.log("✅ WhatsApp worker built successfully");
}

async function main(): Promise<void> {
  loadEnvFile();

  // Ensure dist directory exists
  if (!existsSync(DIST_DIR)) {
    mkdirSync(DIST_DIR, { recursive: true });
  }

  console.log("🔐 Rebuilding Host Agent shim from current source...");
  rebuildAndCopyHostAgentShim(ROOT_DIR);

  // Verify session tools core exists (shared utilities for session-scoped tools)
  verifySessionToolsCore();

  // Build session server (provides session-scoped tools like SubmitPlan)
  // Depends on session-tools-core being built first
  await buildSessionServer();

  // Build Pi agent server (subprocess for Pi SDK sessions)
  await buildPiAgentServer();

  const stagingConfig: BuildConfig = {
    platform: currentPackagedPlatform(),
    arch: currentPackagedArch(),
    upload: false,
    uploadLatest: false,
    uploadScript: false,
    rootDir: ROOT_DIR,
    electronDir: join(ROOT_DIR, "apps/electron"),
  };
  copySessionServer(stagingConfig);
  copyPiAgentServer(stagingConfig);
  verifyMcpServersExist(stagingConfig);
  validatePackagedServerResources(join(stagingConfig.electronDir, "resources"));

  // Build unified network interceptor (CJS bundle for Node.js --require)
  await buildInterceptor();

  // Build WhatsApp worker (Baileys subprocess — optional package)
  await buildWhatsAppWorker();

  const buildPolicy = resolveBuildPolicy();
  const buildDefines = getBuildDefines(buildPolicy);

  console.log("🔨 Building main process...");

  const proc = spawn({
    cmd: [
      "bun", "run", "esbuild",
      "apps/electron/src/main/index.ts",
      "--bundle",
      "--platform=node",
      "--format=cjs",
      "--outfile=apps/electron/dist/main.cjs",
      "--external:electron",
      // Claude Agent SDK is pure ESM (sdk.mjs) and calls `createRequire(import.meta.url)`
      // at module init. esbuild's CJS bundling leaves the synthesized `import_meta.url`
      // undefined for inner ESM modules, which throws ERR_INVALID_ARG_VALUE on load.
      // Externalize so Node loads the SDK natively as ESM (with a real import.meta.url).
      // Electron 39 ships Node 22.x which supports require() of ESM without TLA, so the
      // bundled main.cjs's `require('@anthropic-ai/claude-agent-sdk')` works.
      "--external:@anthropic-ai/claude-agent-sdk",
      // Replace grammY's bundled polyfills (node-fetch@2 + abort-controller@3)
      // with native Node globals. esbuild otherwise renames the polyfill's
      // `class AbortSignal` to `_AbortSignal` to dodge collision with the
      // global, which then breaks node-fetch@2's `constructor.name` check and
      // fails every Telegram API call with a TypeError.
      "--alias:node-fetch=./apps/electron/src/main/shims/node-fetch.cjs",
      "--alias:abort-controller=./apps/electron/src/main/shims/abort-controller.cjs",
      ...buildDefines,
    ],
    cwd: ROOT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error("❌ esbuild failed with exit code", exitCode);
    process.exit(exitCode);
  }

  console.log("🔨 Building isolated Host Agent worker...");
  const workerProc = spawn({
    cmd: [
      "bun", "run", "esbuild",
      "apps/electron/src/host-agent/worker-entry.ts",
      "--bundle",
      "--platform=node",
      "--format=cjs",
      "--outfile=apps/electron/dist/resources/host-agent/worker.cjs",
      "--external:electron",
    ],
    cwd: ROOT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  const workerExitCode = await workerProc.exited;
  if (workerExitCode !== 0) {
    console.error("❌ Host Agent worker build failed with exit code", workerExitCode);
    process.exit(workerExitCode);
  }
  normalizeHostAgentWorkerMode(HOST_AGENT_WORKER_OUTPUT);

  // Wait for file to stabilize
  console.log("⏳ Waiting for file to stabilize...");
  const [stable, workerStable] = await Promise.all([
    waitForFileStable(OUTPUT_FILE),
    waitForFileStable(HOST_AGENT_WORKER_OUTPUT),
  ]);

  if (!stable || !workerStable) {
    console.error("❌ Output file did not stabilize");
    process.exit(1);
  }

  // Verify the output
  console.log("🔍 Verifying build output...");
  const [verification, workerVerification] = await Promise.all([
    verifyJsFile(OUTPUT_FILE),
    verifyJsFile(HOST_AGENT_WORKER_OUTPUT),
  ]);

  if (!verification.valid) {
    console.error("❌ Build verification failed:", verification.error);
    process.exit(1);
  }
  if (!workerVerification.valid) {
    console.error("❌ Host Agent worker verification failed:", workerVerification.error);
    process.exit(1);
  }

  writeBuildPolicy(join(DIST_DIR, "resources"), buildPolicy);

  console.log("✅ Build complete and verified");
  process.exit(0);
}

main();
