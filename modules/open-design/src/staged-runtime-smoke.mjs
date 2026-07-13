import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { smokeLoopback } from "./smoke-loopback.mjs";
import { stagingAssert, stagingFail } from "./staging-error.mjs";

const HOST = "127.0.0.1";

export async function smokeStagedRuntime({ artifactRoot, nodeBin, timeoutMs = 60_000, spawnProcess = spawn } = {}) {
  stagingAssert(path.isAbsolute(artifactRoot ?? ""), "SMOKE_ARTIFACT_INVALID", "artifact root must be absolute");
  stagingAssert(path.isAbsolute(nodeBin ?? ""), "SMOKE_NODE_INVALID", "exact Node executable path must be absolute");
  const daemonEntry = path.join(artifactRoot, "runtime/daemon/dist/sidecar/index.js");
  const webEntry = path.join(artifactRoot, "runtime/packages/web-sidecar/dist/sidecar/index.js");
  const standaloneRoot = path.join(artifactRoot, "web/standalone");
  const [daemonSha256, webSha256] = await Promise.all([
    hashOwnerRegular(daemonEntry, "SMOKE_DAEMON_INVALID"),
    hashOwnerRegular(webEntry, "SMOKE_WEB_INVALID"),
  ]);
  const standaloneStat = await lstat(standaloneRoot).catch((error) => stagingFail("SMOKE_WEB_INVALID", error.message));
  stagingAssert(standaloneStat.isDirectory() && !standaloneStat.isSymbolicLink() && standaloneStat.uid === currentUid(), "SMOKE_WEB_INVALID", "standalone root must be an owner-built directory");

  // macOS Unix-domain sockets have a short pathname limit. /tmp is shorter than
  // macOS's TMPDIR (/var/folders/...) and mkdtemp immediately creates an owned dir.
  const runtimeRoot = await mkdtemp("/tmp/od-smoke-").catch((error) => stagingFail("SMOKE_RUNTIME_INVALID", error.message));
  await chmod(runtimeRoot, 0o700);
  const ipcBase = path.join(runtimeRoot, "ipc");
  const dataRoot = path.join(runtimeRoot, "data");
  const homeRoot = path.join(runtimeRoot, "home");
  await Promise.all([ipcBase, dataRoot, homeRoot].map((directory) => mkdir(directory, { mode: 0o700 })));
  const namespace = `staging-${randomBytes(12).toString("hex")}`;
  const token = randomBytes(32).toString("base64url");
  const tokenSha256 = createHash("sha256").update(token).digest("hex");
  const daemonReservation = await reservePort();
  const webReservation = await reservePort();
  const children = [];
  const processes = [];
  let primaryError;
  try {
    await daemonReservation.release();
    const daemon = await launchSidecar({
      app: "daemon", entry: daemonEntry, entrySha256: daemonSha256, nodeBin, namespace, ipcBase, runtimeRoot,
      port: daemonReservation.port, daemonPort: daemonReservation.port, webPort: webReservation.port,
      dataRoot, homeRoot, token, timeoutMs, spawnProcess, onSpawn: (child) => processes.push(child),
    });
    children.push(daemon);
    await webReservation.release();
    const web = await launchSidecar({
      app: "web", entry: webEntry, entrySha256: webSha256, nodeBin, namespace, ipcBase, runtimeRoot,
      port: webReservation.port, daemonPort: daemonReservation.port, webPort: webReservation.port,
      dataRoot, homeRoot, token, standaloneRoot, timeoutMs, spawnProcess, onSpawn: (child) => processes.push(child),
    });
    children.push(web);
    const functional = await smokeLoopback({ daemonUrl: daemon.status.url, webUrl: web.status.url, timeoutMs });
    for (const child of children) {
      stagingAssert(child.process.exitCode == null && child.process.signalCode == null, "SMOKE_CHILD_EXITED", `${child.app} exited during functional smoke`);
    }
    return {
      ok: true,
      namespace,
      tokenSha256,
      daemon: publicChildEvidence(daemon),
      web: publicChildEvidence(web),
      functional,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await daemonReservation.release().catch(() => undefined);
    await webReservation.release().catch(() => undefined);
    const cleanupErrors = [];
    for (const child of processes.reverse()) {
      await stopChild(child, timeoutMs).catch((error) => cleanupErrors.push(error));
    }
    for (const port of [daemonReservation.port, webReservation.port]) {
      await assertPortClosed(port, 5_000).catch((error) => cleanupErrors.push(error));
    }
    await rm(runtimeRoot, { recursive: true, force: true }).catch((error) => cleanupErrors.push(error));
    if (cleanupErrors.length > 0 && primaryError == null) stagingFail("SMOKE_CLEANUP_FAILED", cleanupErrors.map((error) => error.message).join("; "));
  }
}

async function launchSidecar({ app, entry, entrySha256, nodeBin, namespace, ipcBase, runtimeRoot, port, daemonPort, webPort, dataRoot, homeRoot, token, standaloneRoot, timeoutMs, spawnProcess, onSpawn }) {
  const ipc = path.join(ipcBase, namespace, `${app}.sock`);
  const args = [
    entry,
    `--od-stamp-app=${app}`,
    `--od-stamp-mode=runtime`,
    `--od-stamp-namespace=${namespace}`,
    `--od-stamp-ipc=${ipc}`,
    `--od-stamp-source=tools-pack`,
  ];
  const env = {
    HOME: homeRoot,
    TMPDIR: `${runtimeRoot}${path.sep}`,
    PATH: `${path.dirname(nodeBin)}:/usr/bin:/bin`,
    NODE_ENV: "production",
    OD_API_TOKEN: token,
    OD_BIND_HOST: HOST,
    OD_DATA_DIR: dataRoot,
    OD_DISABLE_TELEMETRY: "1",
    OD_HOST: HOST,
    OD_PORT: String(daemonPort),
    OD_SIDECAR_BASE: runtimeRoot,
    OD_SIDECAR_IPC_BASE: ipcBase,
    OD_SIDECAR_NAMESPACE: namespace,
    OD_SIDECAR_SOURCE: "tools-pack",
    OD_WEB_OUTPUT_MODE: "standalone",
    OD_WEB_PORT: String(webPort),
    OD_WEB_PROD: "1",
    ...(standaloneRoot ? { OD_WEB_STANDALONE_ROOT: standaloneRoot } : {}),
  };
  const child = spawnProcess(nodeBin, args, { cwd: artifactRootForEntry(entry), env, stdio: ["ignore", "pipe", "pipe"] });
  stagingAssert(child?.stdout && child?.stderr && Number.isInteger(child.pid), "SMOKE_SPAWN_FAILED", `${app} child process did not expose pipes and PID`);
  onSpawn(child);
  const status = await waitForStatus(child, timeoutMs, app);
  stagingAssert(status.pid === child.pid, "SMOKE_PROCESS_IDENTITY_MISMATCH", `${app} status PID ${status.pid} does not match spawned PID ${child.pid}`);
  stagingAssert(status.state === "running" && status.url === `http://${HOST}:${port}`, "SMOKE_STATUS_MISMATCH", `${app} status does not bind the reserved loopback port`);
  return { app, process: child, status, entryPath: relativeArtifactEntry(entry), entrySha256, args, startedAt: new Date().toISOString() };
}

function waitForStatus(child, timeoutMs, app) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => finish(new Error(`${app} status timeout; stderr=${stderr.slice(-2000)}`)), timeoutMs);
    const onStdout = (chunk) => {
      stdout += chunk.toString("utf8");
      for (const value of extractJsonObjects(stdout)) {
        if (value && typeof value === "object" && value.state === "running" && Number.isInteger(value.pid)) {
          finish(null, value);
          return;
        }
      }
    };
    const onStderr = (chunk) => { stderr += chunk.toString("utf8"); };
    const onError = (error) => finish(error);
    const onExit = (code, signal) => finish(new Error(`${app} exited before status: code=${code} signal=${signal}; stderr=${stderr.slice(-2000)}`));
    function finish(error, value) {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(value);
    }
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  }).catch((error) => stagingFail("SMOKE_CHILD_NOT_READY", error.message));
}

export function extractJsonObjects(text) {
  const values = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        try { values.push(JSON.parse(text.slice(start, index + 1))); } catch { /* continue scanning */ }
        start = index;
        break;
      }
    }
  }
  return values;
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: HOST, port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  stagingAssert(address && typeof address === "object", "SMOKE_PORT_RESERVATION_FAILED", "reserved port has no address");
  let released = false;
  return {
    port: address.port,
    async release() {
      if (released) return;
      released = true;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function stopChild(child, timeoutMs) {
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill("SIGTERM");
  const exited = await waitForExit(child, Math.min(timeoutMs, 10_000));
  if (exited) return;
  child.kill("SIGKILL");
  stagingAssert(await waitForExit(child, 5_000), "SMOKE_CLEANUP_FAILED", `PID ${child.pid} did not exit after SIGKILL`);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { child.off("exit", onExit); resolve(false); }, timeoutMs);
    const onExit = () => { clearTimeout(timeout); resolve(true); };
    child.once("exit", onExit);
  });
}

async function assertPortClosed(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await canConnect(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  stagingFail("SMOKE_CLEANUP_FAILED", `loopback port ${port} remains open after child cleanup`);
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: HOST, port });
    socket.setTimeout(200);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

async function hashOwnerRegular(filename, code) {
  const stat = await lstat(filename).catch((error) => stagingFail(code, error.message));
  stagingAssert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === currentUid(), code, `${filename} must be an owner-built unlinked regular file`);
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}

function artifactRootForEntry(entry) {
  return entry.includes(`${path.sep}runtime${path.sep}daemon${path.sep}`)
    ? entry.slice(0, entry.indexOf(`${path.sep}runtime${path.sep}daemon${path.sep}`))
    : entry.slice(0, entry.indexOf(`${path.sep}runtime${path.sep}packages${path.sep}`));
}

function relativeArtifactEntry(entry) {
  const root = artifactRootForEntry(entry);
  return path.relative(root, entry).split(path.sep).join("/");
}

function publicChildEvidence(child) {
  return { pid: child.process.pid, status: child.status, entryPath: child.entryPath, entrySha256: child.entrySha256, args: child.args, startedAt: child.startedAt };
}

function currentUid() {
  stagingAssert(typeof process.getuid === "function", "OWNER_CHECK_UNSUPPORTED", "current platform cannot verify filesystem ownership");
  return process.getuid();
}
