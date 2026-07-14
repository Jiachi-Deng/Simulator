import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const moduleRoot = new URL("../", import.meta.url);
const patchText = await readFile(new URL("patches/open-design-v0.14.1-simulator-host-runtime.patch", moduleRoot), "utf8");

test("pinned patch covers every Simulator Host-only integration surface", () => {
  const changedPaths = [...patchText.matchAll(/^diff --git a\/(.+?) b\//gm)].map((match) => match[1]);
  assert.deepEqual(changedPaths, [
    "apps/daemon/src/routes/runs.ts",
    "apps/daemon/src/routes/static-resource.ts",
    "apps/daemon/src/routes/vela.ts",
    "apps/daemon/src/runtimes/defs/simulator-host.ts",
    "apps/daemon/src/runtimes/registry.ts",
    "apps/daemon/src/runtimes/runs.ts",
    "apps/daemon/src/server.ts",
    "apps/daemon/src/simulator-host-agent.ts",
    "apps/web/src/components/EntryShell.tsx",
    "apps/web/src/providers/daemon.ts",
    "apps/web/src/providers/simulator-host-mode.js",
    "package.json",
  ]);
  const additions = patchText.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).join("\n");
  assert.match(additions, /const BASE_AGENT_DEFS: RuntimeAgentDef\[\] = SIMULATOR_HOST_MODE/);
  assert.match(additions, /\+\s+\? \[simulatorHostAgentDef\]/);
  assert.match(additions, /meta\.agentId = SIMULATOR_HOST_AGENT_ID/);
  assert.match(additions, /agents: \[agent\]/);
  assert.match(additions, /return runSimulatorHostAgentTurn/);
  assert.match(additions, /if \(isSimulatorHostAgentMode\(env\)\) return;/);
  assert.match(additions, /agentId: SIMULATOR_HOST_AGENT_ID,[\s\S]*model: null,[\s\S]*reasoning: null/);
  assert.doesNotMatch(additions, /PromaHost|PROMA_HOST|OD_RESOURCE_ROOT|resolveAmrPreflight|detectAgents\(/);
});

test("built web Host policy suppresses every Vela and AMR request after one Host-mode probe", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simulator-host-web-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policyModule = await importMaterializedNewFile(root, "apps/web/src/providers/simulator-host-mode.js");
  const requests = [];
  const policy = policyModule.createSimulatorHostNetworkPolicy(async (input) => {
    requests.push(String(input));
    if (input === "/api/agents") return json(200, { agents: [{ id: "simulator-host-runtime", available: true }] });
    return json(500, { error: "cloud request escaped Host policy" });
  });
  for (const endpoint of [
    "/api/integrations/vela/status",
    "/api/integrations/vela/wallet",
    "/api/amr/models",
    "/api/integrations/vela/login",
    "/api/integrations/vela/login/cancel",
    "/api/integrations/vela/logout",
  ]) {
    assert.equal(await policy.fetchIfAllowed(endpoint, { method: "POST" }), null);
  }
  assert.equal(await policy.isSimulatorHostRuntimeMode(), true);
  assert.deepEqual(requests, ["/api/agents"]);
});

test("web Host policy fails closed when the runtime-mode probe is unavailable", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simulator-host-web-policy-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policyModule = await importMaterializedNewFile(root, "apps/web/src/providers/simulator-host-mode.js");
  const requests = [];
  const policy = policyModule.createSimulatorHostNetworkPolicy(async (input) => {
    requests.push(String(input));
    throw new Error("daemon unavailable");
  });
  assert.equal(await policy.fetchIfAllowed("/api/integrations/vela/login", { method: "POST" }), null);
  assert.deepEqual(requests, ["/api/agents"]);
});

test("a run canceled before adapter entry performs zero Host I/O", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simulator-host-pre-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tokenFile = await writeGrantToken(root);
  const adapter = await importMaterializedAdapter(root);
  const requests = [];
  const run = { id: "run-pre-canceled", status: "queued", updatedAt: 0, cancelRequested: true };
  let finished;
  await adapter.runSimulatorHostAgentTurn({
    prompt: "Must not leave Open Design",
    workingDirectory: "/tmp/project",
    run,
    env: hostEnv(tokenFile),
    fetchImpl: async (...args) => {
      requests.push(args);
      return json(500, {});
    },
    send: () => {},
    finish: (...args) => { finished = args; },
  });
  assert.deepEqual(requests, []);
  assert.equal(finished, undefined);
  assert.equal(run.externalCancel, null);
});

test("Host Runtime adapter streams one turn through the launch-scoped gateway and closes the opaque session", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simulator-host-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = "ab".repeat(32);
  const tokenFile = path.join(root, "grant-token");
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  const adapter = await importMaterializedAdapter(root);
  const requests = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    const request = { method: options.method, url: `${url.pathname}${url.search}`, authorization: options.headers?.authorization, body: options.body ?? "" };
    requests.push(request);
    if (request.authorization !== `Bearer ${token}`) return json(401, {});
    if (request.method === "GET" && request.url === "/v1/capabilities") {
      return json(200, { contractVersion: 1, capability: "host-agent.use", features: { streaming: true, cancellation: true, multiTurn: true }, limits: { maxPromptBytes: 2 * 1024 * 1024, maxReplayEvents: 10_000 } });
    }
    if (request.method === "POST" && request.url === "/v1/module-sessions") {
      return json(200, { contractVersion: 1, sessionHandle: "opaque-session", state: "idle" });
    }
    if (request.method === "POST" && request.url === "/v1/module-sessions/opaque-session/turns") {
      return json(200, { contractVersion: 1, turnId: "opaque-turn", state: "running" });
    }
    if (request.method === "GET" && request.url === "/v1/module-sessions/opaque-session/events?afterSequence=0") {
      const frames = [
        envelope(1, "session.ready", {}),
        envelope(2, "turn.started", {}, "opaque-turn"),
        envelope(3, "message.delta", { delta: "Hello" }, "opaque-turn"),
        envelope(4, "message.completed", { text: "Hello world" }, "opaque-turn"),
        envelope(5, "turn.completed", { text: "Hello world" }, "opaque-turn"),
      ].map((event) => `event: module-agent.event\nid: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`).join("");
      return new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (request.method === "DELETE" && request.url === "/v1/module-sessions/opaque-session") {
      return new Response(null, { status: 204 });
    }
    return json(404, {});
  };
  const sent = [];
  let finished;
  const run = { id: "run-1", projectId: "project-1", status: "starting", updatedAt: 0, cancelRequested: false };
  await adapter.runSimulatorHostAgentTurn({
    prompt: "Design the landing page",
    workingDirectory: "/tmp/project",
    run,
    env: { SIMULATOR_HOST_AGENT_URL: "http://127.0.0.1:43123/", SIMULATOR_HOST_AGENT_TOKEN_FILE: tokenFile },
    fetchImpl,
    send: (event, data) => sent.push({ event, data }),
    finish: (...args) => { finished = args; },
  });
  assert.deepEqual(finished?.slice(1), ["succeeded", 0, null]);
  assert.deepEqual(sent.filter((entry) => entry.event === "agent").map((entry) => entry.data), [
    { type: "text_delta", delta: "Hello" },
    { type: "text_delta", delta: " world" },
  ]);
  assert.deepEqual(JSON.parse(requests.find((entry) => entry.url === "/v1/module-sessions")?.body ?? "null"), { contractVersion: 1, workingDirectory: "/tmp/project" });
  assert.deepEqual(JSON.parse(requests.find((entry) => entry.url?.endsWith("/turns"))?.body ?? "null"), { contractVersion: 1, prompt: "Design the landing page" });
  assert.equal(requests.at(-1)?.method, "DELETE");
});

test("cancel aborts streaming and closes the Host session even when the cancel request fails", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simulator-host-cancel-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tokenFile = await writeGrantToken(root);
  const adapter = await importMaterializedAdapter(root);
  const requests = [];
  let releaseStreamStarted;
  const streamStarted = new Promise((resolve) => { releaseStreamStarted = resolve; });
  let streamSignalAborted = false;
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    const request = { method: options.method, url: `${url.pathname}${url.search}` };
    requests.push(request);
    if (request.method === "GET" && request.url === "/v1/capabilities") {
      return json(200, { contractVersion: 1, capability: "host-agent.use", features: { streaming: true, cancellation: true, multiTurn: true }, limits: { maxPromptBytes: 2 * 1024 * 1024, maxReplayEvents: 10_000 } });
    }
    if (request.method === "POST" && request.url === "/v1/module-sessions") {
      return json(200, { contractVersion: 1, sessionHandle: "cancel-session", state: "idle" });
    }
    if (request.method === "POST" && request.url === "/v1/module-sessions/cancel-session/turns") {
      return json(200, { contractVersion: 1, turnId: "cancel-turn", state: "running" });
    }
    if (request.method === "GET" && request.url.startsWith("/v1/module-sessions/cancel-session/events")) {
      releaseStreamStarted();
      return await new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          streamSignalAborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    }
    if (request.method === "POST" && request.url === "/v1/module-sessions/cancel-session/cancel") {
      return json(500, { error: { code: "CANCEL_FAILED" } });
    }
    if (request.method === "DELETE" && request.url === "/v1/module-sessions/cancel-session") {
      return new Response(null, { status: 204 });
    }
    return json(404, {});
  };
  const run = { id: "run-cancel", status: "queued", updatedAt: 0, cancelRequested: false };
  let finished;
  const turnPromise = adapter.runSimulatorHostAgentTurn({
    prompt: "Cancel this turn",
    workingDirectory: "/tmp/project",
    run,
    env: hostEnv(tokenFile),
    fetchImpl,
    send: () => {},
    finish: (...args) => { finished = args; },
  });
  await streamStarted;
  run.cancelRequested = true;
  const cancel = run.externalCancel;
  assert.equal(typeof cancel, "function");
  await assert.rejects(cancel());
  await turnPromise;
  assert.equal(streamSignalAborted, true);
  assert.equal(finished, undefined);
  assert.equal(run.externalCancel, null);
  assert.equal(requests.some((request) => request.url === "/v1/module-sessions/cancel-session/cancel"), true);
  assert.equal(requests.at(-1)?.url, "/v1/module-sessions/cancel-session");
});

async function importMaterializedAdapter(root) {
  return await importMaterializedNewFile(root, "apps/daemon/src/simulator-host-agent.ts");
}

async function importMaterializedNewFile(root, sourcePath) {
  const marker = `diff --git a/${sourcePath} b/${sourcePath}\n`;
  const start = patchText.indexOf(marker);
  assert.notEqual(start, -1);
  const sectionStart = start + marker.length;
  const next = patchText.indexOf("\ndiff --git ", sectionStart);
  const section = patchText.slice(sectionStart, next === -1 ? undefined : next);
  const source = section.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)).join("\n");
  const filename = path.join(root, `${path.basename(sourcePath).replace(/\.[^.]+$/, "")}-${Date.now()}.mjs`);
  await writeFile(filename, `${source}\n`);
  return await import(`${new URL(`file://${filename}`).href}?test=${Date.now()}`);
}

async function writeGrantToken(root) {
  const tokenFile = path.join(root, "grant-token");
  await writeFile(tokenFile, `${"ab".repeat(32)}\n`, { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  return tokenFile;
}

function hostEnv(tokenFile) {
  return {
    SIMULATOR_HOST_AGENT_URL: "http://127.0.0.1:43123/",
    SIMULATOR_HOST_AGENT_TOKEN_FILE: tokenFile,
  };
}

function envelope(sequence, type, data, turnId) {
  return { contractVersion: 1, sequence, sessionHandle: "opaque-session", ...(turnId ? { turnId } : {}), type, occurredAt: sequence, data };
}

function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
