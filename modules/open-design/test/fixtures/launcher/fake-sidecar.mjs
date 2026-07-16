import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const app = process.argv.find((value) => value.startsWith("--od-stamp-app="))?.slice("--od-stamp-app=".length);
const namespace = process.argv.find((value) => value.startsWith("--od-stamp-namespace="))?.slice("--od-stamp-namespace=".length);
const ipc = process.argv.find((value) => value.startsWith("--od-stamp-ipc="))?.slice("--od-stamp-ipc=".length);
const port = Number(app === "daemon" ? process.env.OD_PORT : process.env.OD_WEB_PORT);
const dataRoot = process.env.OD_DATA_DIR;
const runtimeRoot = process.env.OD_SIDECAR_BASE;
const agentHome = process.env.OD_AGENT_HOME;
const hostAgentUrl = process.env.SIMULATOR_HOST_AGENT_URL;
const hostAgentTokenFile = process.env.SIMULATOR_HOST_AGENT_TOKEN_FILE;

if (!(["daemon", "web"].includes(app))
  || !namespace
  || !ipc?.includes(`${path.sep}${app}.sock`)
  || !process.argv.includes("--od-stamp-mode=runtime")
  || !process.argv.includes("--od-stamp-source=tools-pack")
  || process.env.OD_BIND_HOST !== "127.0.0.1"
  || process.env.OD_HOST !== "127.0.0.1"
  || !Number.isSafeInteger(port)
  || port < 1
  || port > 65_535
  || !dataRoot
  || !runtimeRoot
  || !agentHome
  || !/^[A-Za-z0-9_-]{32,}$/.test(process.env.OD_API_TOKEN ?? "")
  || process.env.OD_SIDECAR_SOURCE !== "tools-pack"
  || process.env.OD_WEB_OUTPUT_MODE !== "standalone") process.exit(64);
if ((app === "web" && !process.env.OD_WEB_STANDALONE_ROOT) || (app === "daemon" && process.env.OD_WEB_STANDALONE_ROOT)) process.exit(64);
if (
  (app === "daemon" && (hostAgentUrl !== "http://127.0.0.1:37654" || !hostAgentTokenFile))
  || (app === "web" && (hostAgentUrl || hostAgentTokenFile))
) process.exit(64);

mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
appendFileSync(path.join(dataRoot, "starts.log"), `${app}\n`);
writeFileSync(path.join(dataRoot, `${app}-pid`), String(process.pid));
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
descendant.unref();
writeFileSync(path.join(dataRoot, `${app}-descendant-pid`), String(descendant.pid));

const server = http.createServer((request, response) => {
  if (request.url === "/proxy") {
    response.writeHead(200, { "content-type": "text/plain", "x-from-fake": app });
    response.end(`proxied:${request.method}`);
    return;
  }
  if (request.url === "/slow-response") {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "text/plain", "x-from-fake": app });
      response.end("slow-proxied");
    }, 15_500);
    return;
  }
  if (request.url === "/observe-downstream-abort") {
    writeFileSync(path.join(dataRoot, "downstream-abort-ready"), "ready\n");
    response.once("close", () => {
      writeFileSync(path.join(dataRoot, "downstream-aborted"), "closed\n");
    });
    return;
  }
  if (request.url === "/pid") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ pid: process.pid, descendantPid: descendant.pid }));
    return;
  }
  if (request.url === "/runtime") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ agentHome, dataRoot, runtimeRoot, hostAgentUrl, hostAgentTokenFile }));
    return;
  }
  if (request.url === "/request-headers") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      host: request.headers.host ?? null,
      origin: request.headers.origin ?? null,
    }));
    return;
  }
  if (request.url === "/redirect-external") {
    response.writeHead(302, { location: "https://outside.example.invalid/" });
    response.end();
    return;
  }
  if (request.url === "/crash" && app === "web") {
    response.end("crashing");
    setTimeout(() => process.exit(23), 20).unref();
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
});

const ipcServer = process.platform === "win32" ? null : net.createServer();

server.on("upgrade", (request, socket) => {
  if (request.url !== "/ws" || app !== "web" || typeof request.headers["sec-websocket-key"] !== "string") {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\nfixture-upgrade`);
});

function listenHttp() {
  server.listen({ host: "127.0.0.1", port }, () => {
    process.stdout.write(`${JSON.stringify({ state: "running", pid: process.pid, url: `http://127.0.0.1:${port}` })}\n`);
  });
}

if (ipcServer) {
  mkdirSync(path.dirname(ipc), { recursive: true, mode: 0o700 });
  ipcServer.listen(ipc, listenHttp);
} else {
  listenHttp();
}

function stop() {
  if (existsSync(path.join(dataRoot, "ignore-sigterm"))) return;
  let remaining = ipcServer ? 2 : 1;
  const closed = () => {
    remaining -= 1;
    if (remaining === 0) process.exit(0);
  };
  server.close(closed);
  ipcServer?.close(closed);
}

process.once("SIGTERM", stop);
process.once("SIGINT", stop);
