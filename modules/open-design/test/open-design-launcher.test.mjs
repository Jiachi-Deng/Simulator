import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const moduleSourceRoot = path.dirname(testDirectory);
const runtimeSource = path.join(moduleSourceRoot, "runtime");
const fixtureSidecar = path.join(testDirectory, "fixtures", "launcher", "fake-sidecar.mjs");

test("bootstrap launches sealed sidecars, proxies HTTP/WebSocket, preserves data, and removes run state", { timeout: 30_000 }, async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const first = await startLauncher(fixture);
  t.after(() => stopLauncher(first));
  const health = await request(first.port, "/health");
  assert.equal(health.statusCode, 200);
  assert.equal(health.body, '{"status":"healthy"}');
  assert.equal(health.headers["content-type"], "application/json");

  const proxied = await request(first.port, "/proxy");
  assert.equal(proxied.statusCode, 200);
  assert.equal(proxied.body, "proxied:GET");
  assert.equal(proxied.headers["x-from-fake"], "web");
  const forwarded = await request(first.port, "/proxy", { forwarded: "for=198.51.100.9" });
  assert.equal(forwarded.statusCode, 400);
  const external = await request(first.port, "/redirect-external");
  assert.equal(external.statusCode, 502);
  assert.equal(external.body, "unsafe navigation");
  await websocketUpgrade(first.port);

  const runtime = JSON.parse((await request(first.port, "/runtime")).body);
  assert.equal(runtime.dataRoot, path.join(fixture.dataRoot, "open-design"));
  assert.equal(runtime.resourceRoot, await realpath(path.join(fixture.root, "runtime", "daemon", "resources", "open-design")));
  if (process.platform !== "win32") {
    assert.match(runtime.runtimeRoot, /^\/tmp\/simulator-open-design-/);
  }
  assert.equal(await stat(runtime.runtimeRoot).then(() => true), true);
  const firstPids = await readPids(fixture.dataRoot);
  await writeFile(path.join(fixture.dataRoot, "open-design", "ignore-sigterm"), "1\n");
  const stopStartedAt = Date.now();
  await stopLauncher(first);
  assert.ok(Date.now() - stopStartedAt < 1_900, "launcher must clean up before the host supervisor escalates");
  await assertExited(firstPids);
  await assert.rejects(stat(runtime.runtimeRoot), { code: "ENOENT" });
  assert.deepEqual(await readdir(path.join(fixture.dataRoot, "open-design", "runs")), []);
  assert.equal((await stat(path.join(fixture.dataRoot, "open-design"))).mode & 0o077, 0);

  const second = await startLauncher(fixture);
  t.after(() => stopLauncher(second));
  assert.equal((await request(second.port, "/health")).body, '{"status":"healthy"}');
  await stopLauncher(second);
  const starts = await readFile(path.join(fixture.dataRoot, "open-design", "starts.log"), "utf8");
  assert.equal((starts.match(/^daemon$/gm) ?? []).length, 2);
  assert.equal((starts.match(/^web$/gm) ?? []).length, 2);
});

test("web sidecar crash terminates daemon process group and closes the host endpoint", { timeout: 20_000 }, async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const launcher = await startLauncher(fixture);
  t.after(() => stopLauncher(launcher));
  const pids = await readPids(fixture.dataRoot);
  assert.equal((await request(launcher.port, "/crash")).statusCode, 200);
  await waitForExit(launcher.process);
  await assertExited(pids);
  await waitForPortClosed(launcher.port);
  assert.deepEqual(await readdir(path.join(fixture.dataRoot, "open-design", "runs")), []);
});

test("parent IPC disconnect stops both sidecar process groups and removes run state", { timeout: 20_000 }, async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const launcher = await startLauncher(fixture, { ipc: true });
  t.after(() => stopLauncher(launcher));
  const pids = await readPids(fixture.dataRoot);
  assert.equal(launcher.process.connected, true);
  launcher.process.disconnect();
  await waitForExit(launcher.process);
  await assertExited(pids);
  assert.deepEqual(await readdir(path.join(fixture.dataRoot, "open-design", "runs")), []);
});

test("invalid host-owned environment fails closed without exposing the supplied data root", { timeout: 15_000 }, async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const port = await freePort();
  const secretDataRoot = path.join(fixture.root, "this-must-not-appear-in-error");
  const process = spawn(fixture.bootstrap, [], {
    env: environmentFor(fixture, port, { SIMULATOR_MODULE_HEALTH_HOST: "0.0.0.0", SIMULATOR_MODULE_DATA_ROOT: secretDataRoot }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = capture(process.stderr);
  const { code } = await waitForExit(process);
  assert.notEqual(code, 0);
  assert.equal((await stderr).includes(secretDataRoot), false);
  await assert.rejects(stat(path.join(secretDataRoot, "open-design")), { code: "ENOENT" });
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "open-design-launcher-"));
  const runtime = path.join(root, "runtime");
  const daemonEntry = path.join(runtime, "daemon", "dist", "sidecar", "index.js");
  const webEntry = path.join(runtime, "packages", "web-sidecar", "dist", "sidecar", "index.js");
  await Promise.all([
    mkdir(path.dirname(daemonEntry), { recursive: true, mode: 0o700 }),
    mkdir(path.dirname(webEntry), { recursive: true, mode: 0o700 }),
    mkdir(path.join(root, "web", "standalone"), { recursive: true, mode: 0o700 }),
    mkdir(path.join(runtime, "daemon", "resources", "open-design"), { recursive: true, mode: 0o700 }),
    mkdir(path.join(runtime, "node", "bin"), { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    copyFile(path.join(runtimeSource, "open-design-launcher"), path.join(runtime, "open-design-launcher")),
    copyFile(path.join(runtimeSource, "open-design-launcher.mjs"), path.join(runtime, "open-design-launcher.mjs")),
    copyFile(fixtureSidecar, daemonEntry),
    copyFile(fixtureSidecar, webEntry),
  ]);
  const nodeShim = `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`;
  await writeFile(path.join(runtime, "node", "bin", "node"), nodeShim, { mode: 0o700 });
  await Promise.all([chmod(path.join(runtime, "open-design-launcher"), 0o700), chmod(path.join(runtime, "node", "bin", "node"), 0o700)]);
  const longDataParent = path.join(root, "intentionally-long-user-data-root-for-unix-socket-regression");
  await mkdir(longDataParent, { recursive: true, mode: 0o700 });
  const dataRoot = await realpath(await mkdtemp(path.join(longDataParent, "data-")));
  return { root, dataRoot, bootstrap: path.join(runtime, "open-design-launcher") };
}

async function startLauncher(fixture, { ipc = false } = {}) {
  const port = await freePort();
  const process = spawn(fixture.bootstrap, [], { env: environmentFor(fixture, port), stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"] });
  const stderr = capture(process.stderr);
  await waitForHealthy(port, process, stderr);
  return { process, port, stderr };
}

function environmentFor(fixture, port, overrides = {}) {
  return {
    SIMULATOR_MODULE_ID: "org.simulator.open-design",
    SIMULATOR_MODULE_VERSION: "0.14.1",
    SIMULATOR_MODULE_HEALTH_HOST: "127.0.0.1",
    SIMULATOR_MODULE_HEALTH_PORT: String(port),
    SIMULATOR_MODULE_DATA_ROOT: fixture.dataRoot,
    ...overrides,
  };
}

function capture(stream) {
  let text = "";
  stream.on("data", (chunk) => { text += chunk.toString("utf8"); });
  return new Promise((resolve) => stream.once("close", () => resolve(text)));
}

async function waitForHealthy(port, process, stderr) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (process.exitCode != null || process.signalCode != null) throw new Error(`launcher exited before health: ${await stderr}`);
    try {
      const health = await request(port, "/health");
      if (health.statusCode === 200 && health.body === '{"status":"healthy"}') return;
    } catch { /* launching */ }
    await sleep(25);
  }
  throw new Error(`launcher health timeout: ${await stderr}`);
}

function request(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: pathname, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.once("end", () => resolve({ statusCode: response.statusCode, headers: response.headers, body }));
    });
    request.once("error", reject);
    request.end();
  });
}

function websocketUpgrade(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let text = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("websocket upgrade timeout")); }, 5_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write("GET /ws HTTP/1.1\r\nHost: module.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"));
    socket.on("data", (chunk) => {
      text += chunk;
      if (text.includes("101 Switching Protocols") && text.includes("fixture-upgrade")) {
        clearTimeout(timer);
        socket.destroy();
        resolve();
      }
    });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

async function readPids(dataRoot) {
  const persistentRoot = path.join(dataRoot, "open-design");
  return Promise.all(["daemon-pid", "daemon-descendant-pid", "web-pid", "web-descendant-pid"].map(async (name) => Number(await readFile(path.join(persistentRoot, name), "utf8"))));
}

async function stopLauncher(launcher) {
  if (!launcher?.process || launcher.process.exitCode != null || launcher.process.signalCode != null) return;
  launcher.process.kill("SIGTERM");
  await waitForExit(launcher.process);
}

async function waitForExit(process) {
  if (process.exitCode != null || process.signalCode != null) return { code: process.exitCode, signal: process.signalCode };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("process did not exit")), 10_000);
    process.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

async function assertExited(pids) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isAlive(pid))) return;
    await sleep(25);
  }
  assert.deepEqual(pids.filter(isAlive), [], "sidecar process group left an orphan");
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

async function waitForPortClosed(port) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { await request(port, "/health"); } catch { return; }
    await sleep(25);
  }
  throw new Error("host health endpoint remains open");
}

function freePort() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
