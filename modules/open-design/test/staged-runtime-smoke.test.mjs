import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { extractJsonObjects, smokeStagedRuntime } from "../src/staged-runtime-smoke.mjs";

async function artifactFixture(t, { wrongDaemonPid = false } = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "open-design-staged-smoke-"));
  const root = path.join(parent, "artifact");
  t.after(() => rm(parent, { recursive: true, force: true }));
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
      process.stdout.write(JSON.stringify({pid,state:'running',url:'http://127.0.0.1:' + port}) + '\\n');
    });
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `;
  await Promise.all([writeFile(daemonEntry, script), writeFile(webEntry, script)]);
  return root;
}

test("starts the staged daemon and web children, binds PID/ports/artifact hashes, and cleans up", async (t) => {
  const artifactRoot = await artifactFixture(t);
  const result = await smokeStagedRuntime({ artifactRoot, nodeBin: process.execPath, timeoutMs: 10_000 });
  assert.equal(result.ok, true);
  assert.equal(result.daemon.status.pid, result.daemon.pid);
  assert.equal(result.web.status.pid, result.web.pid);
  assert.match(result.daemon.entrySha256, /^[0-9a-f]{64}$/u);
  assert.match(result.tokenSha256, /^[0-9a-f]{64}$/u);
  assert.equal(result.functional.daemonVersion, "0.14.1");
});

test("rejects a listening process whose status PID is not the spawned child", async (t) => {
  const artifactRoot = await artifactFixture(t, { wrongDaemonPid: true });
  await assert.rejects(smokeStagedRuntime({ artifactRoot, nodeBin: process.execPath, timeoutMs: 5_000 }), { code: "SMOKE_PROCESS_IDENTITY_MISMATCH" });
});

test("extracts pretty JSON status after arbitrary startup logs", () => {
  assert.deepEqual(extractJsonObjects('log line\n{\n  "pid": 42,\n  "state": "running"\n}\n'), [{ pid: 42, state: "running" }]);
});
