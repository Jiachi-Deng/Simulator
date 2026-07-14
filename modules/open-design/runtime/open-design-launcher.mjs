import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

const LOOPBACK = "127.0.0.1";
const OUTPUT_LIMIT_BYTES = 1024 * 1024;
const READY_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 5_000;
const MAX_PROXY_BODY_BYTES = 32 * 1024 * 1024;
const FORWARDED_HEADERS = new Set([
  "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-port",
  "x-forwarded-proto", "x-real-ip", "x-original-url", "x-rewrite-url",
]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = path.dirname(runtimeDirectory);
let runtime;
let shuttingDown = false;
let shutdownPromise;

main().catch(async (error) => {
  const alreadyStopping = shuttingDown;
  if (!alreadyStopping) reportError(error);
  await shutdown(alreadyStopping ? 0 : 1);
  if (!alreadyStopping) process.exitCode = 1;
});

async function main() {
  const config = await readConfig();
  runtime = await createRuntime(config);
  installShutdownHandlers();
  await startSidecars(runtime);
  throwIfShuttingDown();
  await startProxy(runtime);
}

async function readConfig() {
  const id = requiredEnvironment("SIMULATOR_MODULE_ID", /^[a-z0-9](?:[a-z0-9.-]{1,126}[a-z0-9])?$/);
  const version = requiredEnvironment("SIMULATOR_MODULE_VERSION", /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  const healthHost = requiredEnvironment("SIMULATOR_MODULE_HEALTH_HOST", /^(?:127\.0\.0\.1|::1)$/);
  const healthPort = parsePort(requiredEnvironment("SIMULATOR_MODULE_HEALTH_PORT", /^\d{1,5}$/));
  const dataRoot = await canonicalDataRoot(requiredEnvironment("SIMULATOR_MODULE_DATA_ROOT", /^.{1,1024}$/));
  const root = await canonicalModuleRoot();
  const daemonEntry = await installedFile(root, "runtime/daemon/dist/sidecar/index.js");
  const webEntry = await installedFile(root, "runtime/packages/web-sidecar/dist/sidecar/index.js");
  const standaloneRoot = await installedDirectory(root, "web/standalone");
  const resourceRoot = await installedDirectory(root, "runtime/daemon/resources/open-design");
  return { id, version, healthHost, healthPort, dataRoot, root, daemonEntry, webEntry, standaloneRoot, resourceRoot };
}

function requiredEnvironment(name, expression) {
  const value = process.env[name];
  if (typeof value !== "string" || !expression.test(value) || value.includes("\0")) throw new Error(`invalid ${name}`);
  return value;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("invalid SIMULATOR_MODULE_HEALTH_PORT");
  return port;
}

async function canonicalDataRoot(value) {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || value.includes("\0")) throw new Error("invalid SIMULATOR_MODULE_DATA_ROOT");
  await mkdir(value, { recursive: true, mode: 0o700 });
  const supplied = await lstat(value);
  if (!supplied.isDirectory() || supplied.isSymbolicLink() || supplied.uid !== currentUid()) throw new Error("invalid SIMULATOR_MODULE_DATA_ROOT");
  const root = await realpath(value);
  if (root !== value) throw new Error("invalid SIMULATOR_MODULE_DATA_ROOT");
  await chmod(root, 0o700);
  return root;
}

async function canonicalModuleRoot() {
  const root = await realpath(moduleRoot);
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid module root");
  return root;
}

async function installedFile(root, relativePath) {
  const candidate = await realpath(path.join(root, relativePath));
  assertContained(root, candidate, "invalid installed runtime");
  const stat = await lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid installed runtime");
  return candidate;
}

async function installedDirectory(root, relativePath) {
  const candidate = await realpath(path.join(root, relativePath));
  assertContained(root, candidate, "invalid installed runtime");
  const stat = await lstat(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid installed runtime");
  return candidate;
}

function assertContained(root, candidate, message) {
  const relative = path.relative(root, candidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(message);
}

async function createRuntime(config) {
  const persistentRoot = path.join(config.dataRoot, "open-design");
  await ownerDirectory(persistentRoot, { recursive: true });
  const runsRoot = path.join(persistentRoot, "runs");
  await ownerDirectory(runsRoot, { recursive: true });
  const runRoot = await mkdtemp(path.join(runsRoot, "run-"));
  await chmod(runRoot, 0o700);
  const ipcBase = path.join(runRoot, "ipc");
  const homeRoot = path.join(persistentRoot, "home");
  await Promise.all([ownerDirectory(ipcBase), ownerDirectory(homeRoot, { recursive: true })]);
  const daemonReservation = await reservePort();
  const webReservation = await reservePort();
  return {
    ...config,
    persistentRoot,
    runRoot,
    ipcBase,
    homeRoot,
    token: randomBytes(32).toString("base64url"),
    namespace: `module-${randomBytes(12).toString("hex")}`,
    daemonReservation,
    webReservation,
    children: [],
    sockets: new Set(),
    server: null,
  };
}

async function ownerDirectory(directory, { recursive = false } = {}) {
  await mkdir(directory, { recursive, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== currentUid()) throw new Error("runtime directory is invalid");
  await chmod(directory, 0o700);
}

async function startSidecars(value) {
  await value.daemonReservation.release();
  await launchSidecar(value, "daemon", value.daemonEntry, value.daemonReservation.port);
  throwIfShuttingDown();
  await value.webReservation.release();
  await launchSidecar(value, "web", value.webEntry, value.webReservation.port);
}

async function launchSidecar(value, app, entry, port) {
  const args = [
    entry,
    `--od-stamp-app=${app}`,
    "--od-stamp-mode=runtime",
    `--od-stamp-namespace=${value.namespace}`,
    `--od-stamp-ipc=${path.join(value.ipcBase, value.namespace, `${app}.sock`)}`,
    "--od-stamp-source=tools-pack",
  ];
  const environment = Object.freeze({
    HOME: value.homeRoot,
    TMPDIR: `${value.runRoot}${path.sep}`,
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    NODE_ENV: "production",
    OD_API_TOKEN: value.token,
    OD_BIND_HOST: LOOPBACK,
    OD_DATA_DIR: value.persistentRoot,
    OD_DISABLE_TELEMETRY: "1",
    OD_HOST: LOOPBACK,
    OD_PORT: String(value.daemonReservation.port),
    OD_RESOURCE_ROOT: value.resourceRoot,
    OD_SIDECAR_BASE: value.runRoot,
    OD_SIDECAR_IPC_BASE: value.ipcBase,
    OD_SIDECAR_NAMESPACE: value.namespace,
    OD_SIDECAR_SOURCE: "tools-pack",
    OD_WEB_OUTPUT_MODE: "standalone",
    OD_WEB_PORT: String(value.webReservation.port),
    OD_WEB_PROD: "1",
    ...(app === "web" ? { OD_WEB_STANDALONE_ROOT: value.standaloneRoot } : {}),
  });
  const child = spawn(process.execPath, args, { cwd: value.root, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  if (!child.stdout || !child.stderr || !Number.isInteger(child.pid)) throw new Error(`${app} spawn failed`);
  const monitor = monitorChild(child, app);
  const record = { app, child, monitor, port, expectedUrl: `http://${LOOPBACK}:${port}` };
  value.children.push(record);
  child.once("exit", (code, signal) => {
    if (!shuttingDown) {
      reportError(new Error(`${app} sidecar exited (${code ?? signal ?? "unknown"})`));
      void shutdown(1);
    }
  });
  try {
    const status = await monitor.waitForReady();
    if (status.pid !== child.pid || status.state !== "running" || status.url !== record.expectedUrl) throw new Error(`${app} readiness mismatch`);
    return record;
  } catch (error) {
    await stopChild(child).catch(() => undefined);
    monitor.dispose();
    const index = value.children.indexOf(record);
    if (index >= 0) value.children.splice(index, 1);
    throw error;
  }
}

function monitorChild(child, app) {
  const decoder = new StringDecoder("utf8");
  let outputBytes = 0;
  let stderrTail = "";
  let readyDone = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const parser = jsonObjectParser();
  const fail = (error) => {
    if (!readyDone) {
      readyDone = true;
      rejectReady(error);
    }
  };
  const consume = (chunk, stream) => {
    outputBytes += chunk.length;
    if (outputBytes > OUTPUT_LIMIT_BYTES) {
      fail(new Error(`${app} sidecar output limit exceeded`));
      return;
    }
    const text = stream === "stdout" ? decoder.write(chunk) : chunk.toString("utf8");
    if (stream === "stderr") stderrTail = `${stderrTail}${text}`.slice(-1024);
    if (stream !== "stdout" || readyDone) return;
    for (const candidate of parser.push(text)) {
      if (candidate && typeof candidate === "object" && candidate.state === "running" && Number.isInteger(candidate.pid)) {
        readyDone = true;
        resolveReady(candidate);
        return;
      }
    }
  };
  const onStdout = (chunk) => consume(chunk, "stdout");
  const onStderr = (chunk) => consume(chunk, "stderr");
  const onError = () => fail(new Error(`${app} sidecar spawn error`));
  const onExit = () => fail(new Error(`${app} sidecar exited before ready${stderrTail ? "; stderr captured" : ""}`));
  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);
  child.once("error", onError);
  child.once("exit", onExit);
  return {
    async waitForReady() {
      let timeout;
      try {
        return await Promise.race([
          ready,
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`${app} readiness timeout`)), READY_TIMEOUT_MS); }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    },
    dispose() {
      decoder.end();
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
    },
  };
}

async function startProxy(value) {
  throwIfShuttingDown();
  const server = http.createServer((request, response) => proxyRequest(value, request, response));
  value.server = server;
  server.on("connection", (socket) => {
    value.sockets.add(socket);
    socket.once("close", () => value.sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => proxyUpgrade(value, request, socket, head));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: value.healthHost, port: value.healthPort, exclusive: true }, resolve);
  });
}

function proxyRequest(value, request, response) {
  if (request.url === "/health" && request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json", "content-length": "20", "cache-control": "no-store" });
    response.end('{"status":"healthy"}');
    return;
  }
  if (!isSafeProxyRequest(request)) {
    response.writeHead(400, { "content-type": "text/plain", "content-length": "11" });
    response.end("bad request");
    return;
  }
  const outbound = http.request({
    host: LOOPBACK,
    port: value.webReservation.port,
    method: request.method,
    path: request.url,
    headers: proxyHeaders(request.headers),
    agent: false,
  }, (upstream) => {
    if (isExternalLocation(upstream.headers.location)) {
      upstream.resume();
      response.writeHead(502, { "content-type": "text/plain", "content-length": "17" });
      response.end("unsafe navigation");
      return;
    }
    response.writeHead(upstream.statusCode ?? 502, responseHeaders(upstream.headers));
    upstream.pipe(response);
  });
  outbound.setTimeout(15_000, () => outbound.destroy(new Error("upstream timeout")));
  outbound.once("error", () => {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "text/plain", "content-length": "15" });
      response.end("upstream failed");
    } else response.destroy();
  });
  let received = 0;
  request.on("data", (chunk) => {
    received += chunk.length;
    if (received > MAX_PROXY_BODY_BYTES) request.destroy(new Error("request body too large"));
  });
  request.pipe(outbound);
}

function proxyUpgrade(value, request, socket, head) {
  if (!isSafeProxyRequest(request) || request.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  const outbound = http.request({
    host: LOOPBACK,
    port: value.webReservation.port,
    method: request.method,
    path: request.url,
    headers: { ...proxyHeaders(request.headers), connection: "Upgrade", upgrade: "websocket" },
    agent: false,
  });
  outbound.once("upgrade", (upstream, upstreamSocket, upstreamHead) => {
    const status = `HTTP/${upstream.httpVersion} 101 Switching Protocols\r\n`;
    const headers = Object.entries(responseHeaders(upstream.headers)).map(([key, headerValue]) => `${key}: ${Array.isArray(headerValue) ? headerValue.join(", ") : headerValue}\r\n`).join("");
    socket.write(`${status}connection: Upgrade\r\nupgrade: websocket\r\n${headers}\r\n`);
    if (head.length > 0) upstreamSocket.write(head);
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    socket.pipe(upstreamSocket).pipe(socket);
  });
  outbound.once("response", (upstream) => {
    socket.write(`HTTP/1.1 ${upstream.statusCode ?? 502} Bad Gateway\r\nConnection: close\r\n\r\n`);
    upstream.resume();
    socket.destroy();
  });
  outbound.once("error", () => socket.destroy());
  outbound.end();
}

function isSafeProxyRequest(request) {
  if (typeof request.url !== "string" || !request.url.startsWith("/") || request.url.startsWith("//") || request.url.includes("\\") || /[\r\n]/.test(request.url) || /%(?:2f|5c|0a|0d)/i.test(request.url)) return false;
  for (const name of Object.keys(request.headers)) if (FORWARDED_HEADERS.has(name.toLowerCase())) return false;
  return true;
}

function proxyHeaders(headers) {
  const result = Object.create(null);
  const connectionHeaders = new Set(String(headers.connection ?? "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean));
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (FORWARDED_HEADERS.has(lower) || HOP_BY_HOP_HEADERS.has(lower) || connectionHeaders.has(lower) || lower === "host") continue;
    result[name] = value;
  }
  result.host = `${LOOPBACK}:${runtime.webReservation.port}`;
  return result;
}

function responseHeaders(headers) {
  const result = Object.create(null);
  for (const [name, value] of Object.entries(headers)) if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) result[name] = value;
  return result;
}

function isExternalLocation(location) {
  if (location == null) return false;
  const value = Array.isArray(location) ? location[0] : location;
  return typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\r\n]/.test(value);
}

function installShutdownHandlers() {
  process.once("SIGTERM", () => { void shutdown(0); });
  process.once("SIGINT", () => { void shutdown(0); });
  process.once("disconnect", () => { void shutdown(0); });
  const originalParent = process.ppid;
  const parentWatcher = setInterval(() => {
    if (process.ppid === 1 || (originalParent > 1 && process.ppid !== originalParent)) void shutdown(0);
  }, 1_000);
  parentWatcher.unref();
}

function throwIfShuttingDown() {
  if (shuttingDown) throw new Error("launcher stopping");
}

async function shutdown(exitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    const value = runtime;
    if (!value) return;
    for (const socket of value.sockets) socket.destroy();
    if (value.server) await closeServer(value.server).catch(() => undefined);
    await Promise.allSettled(value.children.map(async ({ child, monitor }) => {
      await stopChild(child);
      monitor.dispose();
    }));
    await Promise.allSettled([value.daemonReservation.release(), value.webReservation.release()]);
    await rm(value.runRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
    process.exitCode = exitCode;
  })();
  return shutdownPromise;
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function stopChild(child) {
  signalProcessGroup(child.pid, "SIGTERM");
  if (await waitForProcessGroupGone(child.pid, STOP_GRACE_MS)) return;
  signalProcessGroup(child.pid, "SIGKILL");
  if (!await waitForProcessGroupGone(child.pid, STOP_GRACE_MS)) throw new Error("sidecar process group did not stop");
}

function signalProcessGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch (error) { if (error?.code !== "ESRCH") throw error; }
}

async function waitForProcessGroupGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processGroupExists(pid);
}

function processGroupExists(pid) {
  try { process.kill(-pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; }
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: LOOPBACK, port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string" || !Number.isSafeInteger(address.port)) throw new Error("port reservation failed");
  let released = false;
  return {
    port: address.port,
    release: async () => {
      if (released) return;
      released = true;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function jsonObjectParser() {
  let text = "";
  return {
    push(chunk) {
      text = `${text}${chunk}`.slice(-64 * 1024);
      const values = [];
      let start = 0;
      while (start < text.length) {
        const open = text.indexOf("{", start);
        if (open < 0) break;
        let depth = 0;
        let quoted = false;
        let escaped = false;
        let end = -1;
        for (let index = open; index < text.length; index += 1) {
          const character = text[index];
          if (quoted) {
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === '"') quoted = false;
          } else if (character === '"') quoted = true;
          else if (character === "{") depth += 1;
          else if (character === "}" && --depth === 0) { end = index; break; }
        }
        if (end < 0) { text = text.slice(open); break; }
        try { values.push(JSON.parse(text.slice(open, end + 1))); } catch { /* non-status log */ }
        start = end + 1;
        if (start >= text.length) text = "";
      }
      return values;
    },
  };
}

function currentUid() {
  if (typeof process.getuid !== "function") throw new Error("owner checks unsupported");
  return process.getuid();
}

function reportError(error) {
  // Do not emit child output, tokens, filesystem paths, or arbitrary environment values.
  const message = error instanceof Error && error.message.includes("sidecar exited") ? "sidecar exited" : "startup or runtime failure";
  process.stderr.write(`[open-design-launcher] ${message}\n`);
}

export function tokenFingerprintForTesting(token) {
  return createHash("sha256").update(token).digest("hex");
}
