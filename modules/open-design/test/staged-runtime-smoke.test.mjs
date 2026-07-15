import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, opendir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { extractJsonObjects, removeSmokeRuntimeRoot, smokeStagedRuntime } from "../src/staged-runtime-smoke.mjs";

async function artifactFixture(t, { wrongDaemonPid = false, startupNoiseBytes = 0 } = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "open-design-staged-smoke-"));
  const root = path.join(parent, "artifact");
  t.after(async () => { await makeWritable(root); await rm(parent, { recursive: true, force: true }); });
  const daemonEntry = path.join(root, "runtime/daemon/dist/sidecar/index.js");
  const webEntry = path.join(root, "runtime/packages/web-sidecar/dist/sidecar/index.js");
  await Promise.all([
    mkdir(path.dirname(daemonEntry), { recursive: true }),
    mkdir(path.dirname(webEntry), { recursive: true }),
    mkdir(path.join(root, "web/standalone"), { recursive: true }),
  ]);
  const script = `
    const http = require('node:http');
    const appArg = process.argv.find((value) => value.startsWith('--od-stamp-app='));
    const app = appArg.split('=')[1];
    const port = Number(process.env[app === 'daemon' ? 'OD_PORT' : 'OD_WEB_PORT']);
    const server = http.createServer((request, response) => {
      if (app === 'web' && request.url === '/') {
        response.writeHead(200, {'content-type':'text/html'}); response.end('<!doctype html><title>staged</title>'); return;
      }
      if (request.url === '/api/health') {
        response.writeHead(200, {'content-type':'application/json'}); response.end(JSON.stringify({ok:true,version:'0.14.1'})); return;
      }
      if (request.url === '/api/ready') {
        response.writeHead(200, {'content-type':'application/json'}); response.end(JSON.stringify({ok:true,ready:true,version:'0.14.1'})); return;
      }
      response.writeHead(404); response.end();
    });
    server.listen(port, '127.0.0.1', () => {
      const pid = app === 'daemon' && ${wrongDaemonPid ? "true" : "false"} ? process.pid + 1 : process.pid;
      if (app === 'daemon' && ${startupNoiseBytes} > 0) process.stdout.write('x'.repeat(${startupNoiseBytes}));
      process.stdout.write(JSON.stringify({pid,state:'running',url:'http://127.0.0.1:' + port}) + '\\n');
    });
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `;
  await Promise.all([writeFile(daemonEntry, script), writeFile(webEntry, script)]);
  const files = await Promise.all([
    inventoryEntry(root, "runtime/daemon/dist/sidecar/index.js"),
    inventoryEntry(root, "runtime/packages/web-sidecar/dist/sidecar/index.js"),
  ]);
  await sealTree(root);
  return { root, inventory: { files } };
}

test("starts the staged daemon and web children, binds PID/ports/artifact hashes, and cleans up", async (t) => {
  const fixture = await artifactFixture(t);
  const result = await smokeStagedRuntime({ artifactRoot: fixture.root, expectedInventory: fixture.inventory, nodeBin: process.execPath, timeoutMs: 10_000 });
  assert.equal(result.ok, true);
  assert.equal(result.daemon.status.pid, result.daemon.pid);
  assert.equal(result.web.status.pid, result.web.pid);
  assert.match(result.daemon.entrySha256, /^[0-9a-f]{64}$/u);
  assert.match(result.tokenSha256, /^[0-9a-f]{64}$/u);
  assert.equal(result.functional.daemonVersion, "0.14.1");
});

test("rejects a listening process whose status PID is not the spawned child", async (t) => {
  const fixture = await artifactFixture(t, { wrongDaemonPid: true });
  await assert.rejects(smokeStagedRuntime({ artifactRoot: fixture.root, expectedInventory: fixture.inventory, nodeBin: process.execPath, timeoutMs: 5_000 }), { code: "SMOKE_PROCESS_IDENTITY_MISMATCH" });
});

test("rejects sealed runtime bytes that differ from the final inventory", async (t) => {
  const fixture = await artifactFixture(t);
  fixture.inventory.files[0].sha256 = "0".repeat(64);
  await assert.rejects(smokeStagedRuntime({ artifactRoot: fixture.root, expectedInventory: fixture.inventory, nodeBin: process.execPath }), { code: "SMOKE_INVENTORY_MISMATCH" });
});

test("caps combined stdout and stderr while continuing to drain child pipes", async (t) => {
  const fixture = await artifactFixture(t, { startupNoiseBytes: 4096 });
  await assert.rejects(smokeStagedRuntime({ artifactRoot: fixture.root, expectedInventory: fixture.inventory, nodeBin: process.execPath, maxOutputBytes: 1024, timeoutMs: 5_000 }), { code: "SMOKE_OUTPUT_LIMIT" });
});

test("extracts pretty JSON status after arbitrary startup logs", () => {
  assert.deepEqual(extractJsonObjects('log line\n{\n  "pid": 42,\n  "state": "running"\n}\n'), [{ pid: 42, state: "running" }]);
});

test("uses bounded retries and verifies the runtime root is absent", async () => {
  let options;
  await removeSmokeRuntimeRoot("/tmp/od-smoke-test", {
    remove: async (_root, value) => { options = value; },
    stat: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  });
  assert.deepEqual(options, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});

async function inventoryEntry(root, relativePath) {
  const bytes = await readFile(path.join(root, relativePath));
  return { path: relativePath, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function sealTree(root) {
  const directory = await opendir(root);
  for await (const entry of directory) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) await sealTree(child);
    else await chmod(child, 0o444);
  }
  await chmod(root, 0o555);
}

async function makeWritable(root) {
  await chmod(root, 0o700).catch(() => undefined);
  const directory = await opendir(root).catch(() => null);
  if (directory == null) return;
  for await (const entry of directory) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) await makeWritable(child);
    else await chmod(child, 0o600).catch(() => undefined);
  }
}
