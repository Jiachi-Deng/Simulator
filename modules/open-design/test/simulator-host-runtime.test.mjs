import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isAllowedPatchPath } from "../src/apply-simulator-patch.mjs";

const moduleRoot = new URL("../", import.meta.url);
const patchText = await readFile(new URL("patches/open-design-v0.14.1-simulator-host-runtime.patch", moduleRoot), "utf8");

test("strict patch allowlist matches all 22 pinned Host integration paths and rejects scope expansion", async () => {
  const provenance = JSON.parse(await readFile(new URL("provenance.json", moduleRoot), "utf8"));
  const changedPaths = provenance.simulatorPatch.changedPaths;
  assert.equal(changedPaths.length, 22);
  assert.ok(changedPaths.every(isAllowedPatchPath));
  for (const unsupported of [
    "apps/web/src/components/FileViewer.tsx",
    "apps/web/src/components/Unexpected.tsx",
    "apps/web/public/logo.svg",
    "apps/desktop/src/main.ts",
    "../package.json",
    "/absolute/package.json",
  ]) {
    assert.equal(isAllowedPatchPath(unsupported), false, unsupported);
  }
});

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
    "apps/web/next.config.ts",
    "apps/web/src/App.tsx",
    "apps/web/src/components/AvatarMenu.tsx",
    "apps/web/src/components/EntrySettingsMenu.tsx",
    "apps/web/src/components/EntryShell.tsx",
    "apps/web/src/components/FileWorkspace.tsx",
    "apps/web/src/components/InlineModelSwitcher.tsx",
    "apps/web/src/components/ProjectView.tsx",
    "apps/web/src/components/SettingsDialog.tsx",
    "apps/web/src/index.css",
    "apps/web/src/providers/daemon.ts",
    "apps/web/src/providers/simulator-host-mode.js",
    "apps/web/src/styles/simulator-host.css",
    "package.json",
  ]);
  const additions = patchText.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).join("\n");
  assert.match(additions, /const BASE_AGENT_DEFS: RuntimeAgentDef\[\] = SIMULATOR_HOST_MODE/);
  assert.match(additions, /\+\s+\? \[simulatorHostAgentDef\]/);
  assert.match(additions, /meta\.agentId = SIMULATOR_HOST_AGENT_ID/);
  assert.match(additions, /agents: \[agent\]/);
  assert.match(additions, /return runSimulatorHostAgentTurn/);
  assert.match(additions, /continuationPrompt:[\s\S]*skipTranscript: true/);
  assert.match(additions, /delete process\.env\.SIMULATOR_HOST_AGENT_TOKEN_FILE/);
  assert.match(additions, /if \(!isSimulatorHostAgentMode\(\)\) registerTerminalRoutes/);
  assert.match(additions, /disposeSimulatorHostAgentSessions/);
  assert.match(additions, /if \(isSimulatorHostAgentMode\(\)\) return;/);
  assert.doesNotMatch(additions, /isSimulatorHostAgentMode\(process\.env\)|isSimulatorHostAgentMode\(env\)/);
  assert.match(additions, /agentId: SIMULATOR_HOST_AGENT_ID,[\s\S]*model: null,[\s\S]*reasoning: null/);
  assert.match(additions, /normalizeSimulatorHostConfig/);
  assert.match(additions, /onboardingCompleted: true/);
  assert.match(additions, /pendingRuntimeBootstrap = !daemonConfigLoaded/);
  assert.match(additions, /window\.location\.pathname === '\/onboarding'/);
  assert.match(additions, /navigate\(\{ kind: 'home', view: 'home' \}, \{ replace: true \}\)/);
  assert.match(additions, /data-testid="settings-simulator-host-runtime"/);
  assert.match(additions, /simulatorHostRuntimeMode \? undefined : handleShareToOpenDesign/);
  assert.match(additions, /createBrowser: simulatorHostRuntimeMode \? undefined/);
  assert.match(additions, /data-simulator-host-runtime='true'[\s\S]*\.chrome-file-action-menus/);
  assert.match(additions, /images: \{ unoptimized: true \}/);
  assert.match(additions, /Simulator current Workspace connection/);
  assert.doesNotMatch(additions, /PromaHost|PROMA_HOST|OD_RESOURCE_ROOT|resolveAmrPreflight|detectAgents\(/);
  assert.doesNotMatch(changedPaths.join("\n"), /FileViewer|HomeView|WorkspaceTabsBar/);
});

test("Host mode atomically normalizes and scrubs standalone execution choices", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simulator-host-config-normalization-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policyModule = await importMaterializedNewFile(root, "apps/web/src/providers/simulator-host-mode.js");
  const normalized = policyModule.normalizeSimulatorHostConfig({
    mode: "api",
    apiKey: "must-not-survive",
    apiProtocolConfigs: { openai: { apiKey: "must-not-survive" } },
    byokProviderConfigDrafts: { openai: { apiConfig: { apiKey: "must-not-survive" } } },
    mediaProviders: { image: { apiKey: "must-not-survive" } },
    agentId: "amr",
    agentModels: { amr: { model: "cloud-model" } },
    agentCliEnv: { amr: { OPEN_DESIGN_AMR_PROFILE: "cloud" } },
    agentCliEnvIntent: { amr: { OPEN_DESIGN_AMR_PROFILE: "set" } },
    onboardingCompleted: false,
    telemetry: { metrics: true, content: true },
    theme: "dark",
  });
  assert.equal(policyModule.isSimulatorHostAgentConfig(normalized), true);
  assert.deepEqual(
    {
      mode: normalized.mode,
      apiKey: normalized.apiKey,
      apiProtocolConfigs: normalized.apiProtocolConfigs,
      byokProviderConfigDrafts: normalized.byokProviderConfigDrafts,
      mediaProviders: normalized.mediaProviders,
      agentId: normalized.agentId,
      agentModels: normalized.agentModels,
      agentCliEnv: normalized.agentCliEnv,
      agentCliEnvIntent: normalized.agentCliEnvIntent,
      onboardingCompleted: normalized.onboardingCompleted,
      telemetry: normalized.telemetry,
      theme: normalized.theme,
    },
    {
      mode: "daemon",
      apiKey: "",
      apiProtocolConfigs: {},
      byokProviderConfigDrafts: {},
      mediaProviders: {},
      agentId: "simulator-host-runtime",
      agentModels: {},
      agentCliEnv: {},
      agentCliEnvIntent: {},
      onboardingCompleted: true,
      telemetry: { metrics: false, content: false },
      theme: "dark",
    },
  );
});

test("Host mode captures then scrubs the bearer environment before child processes can inherit it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simulator-host-env-scrub-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousUrl = process.env.SIMULATOR_HOST_AGENT_URL;
  const previousTokenFile = process.env.SIMULATOR_HOST_AGENT_TOKEN_FILE;
  process.env.SIMULATOR_HOST_AGENT_URL = "http://127.0.0.1:43123/";
  process.env.SIMULATOR_HOST_AGENT_TOKEN_FILE = path.join(root, "grant-token");
  t.after(() => {
    if (previousUrl === undefined) delete process.env.SIMULATOR_HOST_AGENT_URL;
    else process.env.SIMULATOR_HOST_AGENT_URL = previousUrl;
    if (previousTokenFile === undefined) delete process.env.SIMULATOR_HOST_AGENT_TOKEN_FILE;
    else process.env.SIMULATOR_HOST_AGENT_TOKEN_FILE = previousTokenFile;
  });
  const adapter = await importMaterializedAdapter(root);
  assert.equal(process.env.SIMULATOR_HOST_AGENT_URL, undefined);
  assert.equal(process.env.SIMULATOR_HOST_AGENT_TOKEN_FILE, undefined);
  assert.equal(adapter.isSimulatorHostAgentMode(), true);
  assert.equal(adapter.isSimulatorHostAgentMode(process.env), false);
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
    continuationPrompt: "Must not leave Open Design",
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

test("Host Runtime adapter reuses one conversation session across turns and closes it at daemon shutdown", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simulator-host-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = "ab".repeat(32);
  const tokenFile = path.join(root, "grant-token");
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  const adapter = await importMaterializedAdapter(root);
  const requests = [];
  let turnCount = 0;
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
      turnCount += 1;
      return json(200, { contractVersion: 1, turnId: `opaque-turn-${turnCount}`, state: "running" });
    }
    if (request.method === "GET" && request.url.startsWith("/v1/module-sessions/opaque-session/events")) {
      const currentTurn = `opaque-turn-${turnCount}`;
      const frames = turnCount === 1 ? [
        envelope(1, "session.ready", {}),
        envelope(2, "turn.started", {}, currentTurn),
        envelope(3, "message.delta", { delta: "Hello" }, currentTurn),
        envelope(4, "message.completed", { text: "Hello world" }, currentTurn),
        envelope(5, "turn.completed", { text: "Hello world" }, currentTurn),
      ] : [
        envelope(6, "turn.started", {}, currentTurn),
        envelope(7, "message.delta", { delta: "Revised" }, currentTurn),
        envelope(8, "message.completed", { text: "Revised design" }, currentTurn),
        envelope(9, "turn.completed", { text: "Revised design" }, currentTurn),
      ];
      const payload = frames.map((event) => `event: module-agent.event\nid: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`).join("");
      return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (request.method === "DELETE" && request.url === "/v1/module-sessions/opaque-session") {
      return new Response(null, { status: 204 });
    }
    return json(404, {});
  };
  const sent = [];
  const finished = [];
  const run = { id: "run-1", projectId: "project-1", conversationId: "conversation-1", status: "starting", updatedAt: 0, cancelRequested: false };
  await adapter.runSimulatorHostAgentTurn({
    prompt: "Design the landing page",
    continuationPrompt: "Design the landing page",
    workingDirectory: "/tmp/project",
    run,
    env: { SIMULATOR_HOST_AGENT_URL: "http://127.0.0.1:43123/", SIMULATOR_HOST_AGENT_TOKEN_FILE: tokenFile },
    fetchImpl,
    send: (event, data) => sent.push({ event, data }),
    finish: (...args) => { finished.push(args); },
  });
  await adapter.runSimulatorHostAgentTurn({
    prompt: "Revise the same design",
    continuationPrompt: "Only the latest revision request",
    workingDirectory: "/tmp/project",
    run: { id: "run-2", projectId: "project-1", conversationId: "conversation-1", status: "starting", updatedAt: 0, cancelRequested: false },
    env: { SIMULATOR_HOST_AGENT_URL: "http://127.0.0.1:43123/", SIMULATOR_HOST_AGENT_TOKEN_FILE: tokenFile },
    fetchImpl,
    send: (event, data) => sent.push({ event, data }),
    finish: (...args) => { finished.push(args); },
  });
  assert.deepEqual(finished.map((entry) => entry.slice(1)), [["succeeded", 0, null], ["succeeded", 0, null]]);
  assert.deepEqual(sent.filter((entry) => entry.event === "agent").map((entry) => entry.data), [
    { type: "text_delta", delta: "Hello" },
    { type: "text_delta", delta: " world" },
    { type: "text_delta", delta: "Revised" },
    { type: "text_delta", delta: " design" },
  ]);
  assert.deepEqual(JSON.parse(requests.find((entry) => entry.url === "/v1/module-sessions")?.body ?? "null"), { contractVersion: 1, workingDirectory: "/tmp/project" });
  assert.deepEqual(
    requests.filter((entry) => entry.url?.endsWith("/turns")).map((entry) => JSON.parse(entry.body)),
    [
      { contractVersion: 1, prompt: "Design the landing page" },
      { contractVersion: 1, prompt: "Only the latest revision request" },
    ],
  );
  assert.equal(requests.filter((entry) => entry.method === "POST" && entry.url === "/v1/module-sessions").length, 1);
  assert.equal(requests.filter((entry) => entry.method === "POST" && entry.url.endsWith("/turns")).length, 2);
  assert.equal(requests.some((entry) => entry.method === "DELETE"), false);
  await adapter.disposeSimulatorHostAgentSessions();
  assert.equal(requests.at(-1)?.method, "DELETE");
});

test("different conversations in one project never share a Host session", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simulator-host-conversation-isolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tokenFile = await writeGrantToken(root);
  const adapter = await importMaterializedAdapter(root);
  const host = createSuccessfulHostFetch();

  for (const conversationId of ["conversation-a", "conversation-b"]) {
    await adapter.runSimulatorHostAgentTurn({
      prompt: `full transcript ${conversationId}`,
      continuationPrompt: `latest turn ${conversationId}`,
      workingDirectory: "/tmp/shared-project",
      run: { id: `run-${conversationId}`, conversationId, status: "starting", updatedAt: 0, cancelRequested: false },
      env: hostEnv(tokenFile),
      fetchImpl: host.fetchImpl,
      send: () => {},
      finish: () => {},
    });
  }

  assert.equal(host.requests.filter((request) => request.method === "POST" && request.url === "/v1/module-sessions").length, 2);
  assert.deepEqual(host.turnPrompts(), ["full transcript conversation-a", "full transcript conversation-b"]);
  await adapter.disposeSimulatorHostAgentSessions();
});

test("finish re-entry releases once and cannot unlock a newer active turn", async (t) => {
  const adapterSource = materializedNewFileSource("apps/daemon/src/simulator-host-agent.ts");
  assert.equal(adapterSource.match(/releaseCachedSession\(sessionRecord\)/g)?.length, 1);
  const root = await mkdtemp(path.join(os.tmpdir(), "simulator-host-finish-reentry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tokenFile = await writeGrantToken(root);
  const adapter = await importMaterializedAdapter(root);
  const host = createSuccessfulHostFetch({ gateTurnNumber: 2 });
  let reentrantTurn;

  await adapter.runSimulatorHostAgentTurn({
    prompt: "initial full transcript",
    continuationPrompt: "initial latest turn",
    workingDirectory: "/tmp/reentrant-project",
    run: { id: "run-reentrant-1", conversationId: "conversation-reentrant", status: "starting", updatedAt: 0, cancelRequested: false },
    env: hostEnv(tokenFile),
    fetchImpl: host.fetchImpl,
    send: () => {},
    finish: (finishedRun) => {
      if (finishedRun.id !== "run-reentrant-1") return;
      reentrantTurn = adapter.runSimulatorHostAgentTurn({
        prompt: "must not resend the initial transcript",
        continuationPrompt: "reentrant latest turn",
        workingDirectory: "/tmp/reentrant-project",
        run: { id: "run-reentrant-2", conversationId: "conversation-reentrant", status: "starting", updatedAt: 0, cancelRequested: false },
        env: hostEnv(tokenFile),
        fetchImpl: host.fetchImpl,
        send: () => {},
        finish: () => {},
      });
    },
  });

  assert.ok(reentrantTurn);
  await host.gatedTurnStarted;
  await assert.rejects(adapter.runSimulatorHostAgentTurn({
    prompt: "concurrent full transcript",
    continuationPrompt: "concurrent latest turn",
    workingDirectory: "/tmp/reentrant-project",
    run: { id: "run-reentrant-3", conversationId: "conversation-reentrant", status: "starting", updatedAt: 0, cancelRequested: false },
    env: hostEnv(tokenFile),
    fetchImpl: host.fetchImpl,
    send: () => {},
    finish: () => {},
  }));
  assert.deepEqual(host.turnPrompts(), ["initial full transcript", "reentrant latest turn"]);
  host.releaseGatedTurn();
  await reentrantTurn;
  await adapter.disposeSimulatorHostAgentSessions();
});

test("the fifth idle project evicts the least-recently-used Host session", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simulator-host-session-lru-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tokenFile = await writeGrantToken(root);
  const adapter = await importMaterializedAdapter(root);
  const host = createSuccessfulHostFetch();

  for (let index = 1; index <= 5; index += 1) {
    await adapter.runSimulatorHostAgentTurn({
      prompt: `full project ${index}`,
      continuationPrompt: `latest project ${index}`,
      workingDirectory: `/tmp/project-${index}`,
      run: { id: `run-${index}`, conversationId: `conversation-${index}`, status: "starting", updatedAt: 0, cancelRequested: false },
      env: hostEnv(tokenFile),
      fetchImpl: host.fetchImpl,
      send: () => {},
      finish: () => {},
    });
  }

  const creates = host.requests.filter((request) => request.method === "POST" && request.url === "/v1/module-sessions");
  const deletesBeforeDispose = host.requests.filter((request) => request.method === "DELETE");
  assert.equal(creates.length, 5);
  assert.deepEqual(deletesBeforeDispose.map((request) => request.url), ["/v1/module-sessions/opaque-session-1"]);
  assert.ok(host.requests.indexOf(deletesBeforeDispose[0]) < host.requests.indexOf(creates[4]));
  await adapter.disposeSimulatorHostAgentSessions();
  assert.equal(host.requests.filter((request) => request.method === "DELETE").length, 5);
});

test("LRU admission retries a retained closeFailed opaque handle", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simulator-host-lru-close-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tokenFile = await writeGrantToken(root);
  const adapter = await importMaterializedAdapter(root);
  const host = createSuccessfulHostFetch({ closeFailures: 1 });
  const runProject = (index) => adapter.runSimulatorHostAgentTurn({
    prompt: `full project ${index}`,
    continuationPrompt: `latest project ${index}`,
    workingDirectory: `/tmp/lru-retry-project-${index}`,
    run: { id: `run-lru-retry-${index}`, conversationId: `conversation-lru-retry-${index}`, status: "starting", updatedAt: 0, cancelRequested: false },
    env: hostEnv(tokenFile),
    fetchImpl: host.fetchImpl,
    send: () => {},
    finish: () => {},
  });
  for (let index = 1; index <= 4; index += 1) await runProject(index);

  await assert.rejects(runProject(5));
  assert.equal(host.requests.filter((request) => request.method === "POST" && request.url === "/v1/module-sessions").length, 4);
  assert.deepEqual(host.requests.filter((request) => request.method === "DELETE").map((request) => request.url), [
    "/v1/module-sessions/opaque-session-1",
  ]);

  await runProject(5);
  assert.equal(host.requests.filter((request) => request.method === "POST" && request.url === "/v1/module-sessions").length, 5);
  assert.deepEqual(host.requests.filter((request) => request.method === "DELETE").map((request) => request.url), [
    "/v1/module-sessions/opaque-session-1",
    "/v1/module-sessions/opaque-session-1",
  ]);
  await adapter.disposeSimulatorHostAgentSessions();
});

test("daemon disposal waits for an in-flight create and closes the resulting opaque session", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simulator-host-create-dispose-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tokenFile = await writeGrantToken(root);
  const adapter = await importMaterializedAdapter(root);
  let markCreateStarted;
  let releaseCreate;
  const createStarted = new Promise((resolve) => { markCreateStarted = resolve; });
  const createGate = new Promise((resolve) => { releaseCreate = resolve; });
  const requests = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    const request = { method: options.method, url: `${url.pathname}${url.search}` };
    requests.push(request);
    if (request.method === "GET" && request.url === "/v1/capabilities") return capabilitiesResponse();
    if (request.method === "POST" && request.url === "/v1/module-sessions") {
      markCreateStarted();
      await createGate;
      return json(200, { contractVersion: 1, sessionHandle: "dispose-session", state: "idle" });
    }
    if (request.method === "DELETE" && request.url === "/v1/module-sessions/dispose-session") {
      return new Response(null, { status: 204 });
    }
    return json(500, {});
  };
  const turn = adapter.runSimulatorHostAgentTurn({
    prompt: "full prompt",
    continuationPrompt: "latest prompt",
    workingDirectory: "/tmp/dispose-project",
    run: { id: "run-dispose", conversationId: "conversation-dispose", status: "starting", updatedAt: 0, cancelRequested: false },
    env: hostEnv(tokenFile),
    fetchImpl,
    send: () => {},
    finish: () => {},
  });
  const rejectedTurn = assert.rejects(turn);
  await createStarted;
  const disposal = adapter.disposeSimulatorHostAgentSessions();
  releaseCreate();
  await Promise.all([rejectedTurn, disposal]);
  assert.equal(requests.some((request) => request.url.endsWith("/turns")), false);
  assert.deepEqual(requests.filter((request) => request.method === "DELETE").map((request) => request.url), [
    "/v1/module-sessions/dispose-session",
  ]);
});

test("a failed close retains the opaque handle for a later disposal retry", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simulator-host-close-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tokenFile = await writeGrantToken(root);
  const adapter = await importMaterializedAdapter(root);
  const host = createSuccessfulHostFetch({ closeFailures: 1 });
  await adapter.runSimulatorHostAgentTurn({
    prompt: "full prompt",
    continuationPrompt: "latest prompt",
    workingDirectory: "/tmp/retry-project",
    run: { id: "run-retry", conversationId: "conversation-retry", status: "starting", updatedAt: 0, cancelRequested: false },
    env: hostEnv(tokenFile),
    fetchImpl: host.fetchImpl,
    send: () => {},
    finish: () => {},
  });

  await assert.rejects(adapter.disposeSimulatorHostAgentSessions());
  await assert.rejects(adapter.runSimulatorHostAgentTurn({
    prompt: "must not reuse failed close",
    continuationPrompt: "must not reuse failed close",
    workingDirectory: "/tmp/retry-project",
    run: { id: "run-retry-2", conversationId: "conversation-retry", status: "starting", updatedAt: 0, cancelRequested: false },
    env: hostEnv(tokenFile),
    fetchImpl: host.fetchImpl,
    send: () => {},
    finish: () => {},
  }));
  assert.deepEqual(host.turnPrompts(), ["full prompt"]);
  await adapter.disposeSimulatorHostAgentSessions();
  assert.deepEqual(host.requests.filter((request) => request.method === "DELETE").map((request) => request.url), [
    "/v1/module-sessions/opaque-session-1",
    "/v1/module-sessions/opaque-session-1",
  ]);
});

test("cancel during gated session creation waits for the opaque handle and closes it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simulator-host-create-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tokenFile = await writeGrantToken(root);
  const adapter = await importMaterializedAdapter(root);
  let markCreateStarted;
  let releaseCreate;
  const createStarted = new Promise((resolve) => { markCreateStarted = resolve; });
  const createGate = new Promise((resolve) => { releaseCreate = resolve; });
  const requests = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    const request = { method: options.method, url: `${url.pathname}${url.search}` };
    requests.push(request);
    if (request.method === "GET" && request.url === "/v1/capabilities") {
      return json(200, { contractVersion: 1, capability: "host-agent.use", features: { streaming: true, cancellation: true, multiTurn: true }, limits: { maxPromptBytes: 2 * 1024 * 1024, maxReplayEvents: 10_000 } });
    }
    if (request.method === "POST" && request.url === "/v1/module-sessions") {
      markCreateStarted();
      await createGate;
      assert.equal(options.signal.aborted, false);
      return json(200, { contractVersion: 1, sessionHandle: "gated-session", state: "idle" });
    }
    if (request.method === "DELETE" && request.url === "/v1/module-sessions/gated-session") {
      return new Response(null, { status: 204 });
    }
    return json(500, {});
  };
  const run = { id: "run-create-cancel", status: "queued", updatedAt: 0, cancelRequested: false };
  let finished;
  const turn = adapter.runSimulatorHostAgentTurn({
    prompt: "Cancel while creating",
    continuationPrompt: "Cancel while creating",
    workingDirectory: "/tmp/gated-project",
    run,
    env: hostEnv(tokenFile),
    fetchImpl,
    send: () => {},
    finish: (...args) => { finished = args; },
  });
  await createStarted;
  run.cancelRequested = true;
  const cancel = run.externalCancel();
  releaseCreate();
  await cancel;
  await turn;
  assert.equal(finished, undefined);
  assert.equal(run.externalCancel, null);
  assert.equal(requests.some((request) => request.url.endsWith("/turns")), false);
  assert.equal(requests.filter((request) => request.method === "DELETE").length, 1);
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
    continuationPrompt: "Cancel this turn",
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

function createSuccessfulHostFetch({ closeFailures = 0, gateTurnNumber = null } = {}) {
  const requests = [];
  const sequenceBySession = new Map();
  const turnBySession = new Map();
  let sessionCount = 0;
  let turnCount = 0;
  let remainingCloseFailures = closeFailures;
  let markGatedTurnStarted;
  let releaseGatedTurn;
  const gatedTurnStarted = new Promise((resolve) => { markGatedTurnStarted = resolve; });
  const gatedTurn = new Promise((resolve) => { releaseGatedTurn = resolve; });
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    const request = {
      method: options.method,
      url: `${url.pathname}${url.search}`,
      body: options.body ?? "",
    };
    requests.push(request);
    if (request.method === "GET" && request.url === "/v1/capabilities") return capabilitiesResponse();
    if (request.method === "POST" && request.url === "/v1/module-sessions") {
      sessionCount += 1;
      return json(200, { contractVersion: 1, sessionHandle: `opaque-session-${sessionCount}`, state: "idle" });
    }
    const turnMatch = /^\/v1\/module-sessions\/(opaque-session-\d+)\/turns$/.exec(request.url);
    if (request.method === "POST" && turnMatch) {
      turnCount += 1;
      const turnId = `opaque-turn-${turnCount}`;
      turnBySession.set(turnMatch[1], turnId);
      return json(200, { contractVersion: 1, turnId, state: "running" });
    }
    const eventMatch = /^\/v1\/module-sessions\/(opaque-session-\d+)\/events\?afterSequence=(\d+)$/.exec(request.url);
    if (request.method === "GET" && eventMatch) {
      const sessionHandle = eventMatch[1];
      const turnId = turnBySession.get(sessionHandle);
      let sequence = sequenceBySession.get(sessionHandle) ?? 0;
      assert.equal(Number(eventMatch[2]), sequence);
      const frames = [];
      if (sequence === 0) frames.push(envelope(++sequence, "session.ready", {}, undefined, sessionHandle));
      frames.push(envelope(++sequence, "turn.started", {}, turnId, sessionHandle));
      frames.push(envelope(++sequence, "message.completed", { text: `result-${turnId}` }, turnId, sessionHandle));
      frames.push(envelope(++sequence, "turn.completed", { text: `result-${turnId}` }, turnId, sessionHandle));
      sequenceBySession.set(sessionHandle, sequence);
      if (Number(turnId?.split("-").at(-1)) === gateTurnNumber) {
        markGatedTurnStarted();
        await gatedTurn;
      }
      return new Response(
        frames.map((event) => `event: module-agent.event\nid: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    const closeMatch = /^\/v1\/module-sessions\/(opaque-session-\d+)$/.exec(request.url);
    if (request.method === "DELETE" && closeMatch) {
      if (remainingCloseFailures > 0) {
        remainingCloseFailures -= 1;
        return json(500, { error: { code: "CLOSE_FAILED" } });
      }
      return new Response(null, { status: 204 });
    }
    return json(404, {});
  };
  return {
    fetchImpl,
    requests,
    gatedTurnStarted,
    releaseGatedTurn: () => releaseGatedTurn(),
    turnPrompts: () => requests
      .filter((request) => request.method === "POST" && request.url.endsWith("/turns"))
      .map((request) => JSON.parse(request.body).prompt),
  };
}

async function importMaterializedAdapter(root) {
  return await importMaterializedNewFile(root, "apps/daemon/src/simulator-host-agent.ts");
}

async function importMaterializedNewFile(root, sourcePath) {
  const source = materializedNewFileSource(sourcePath);
  const filename = path.join(root, `${path.basename(sourcePath).replace(/\.[^.]+$/, "")}-${Date.now()}.mjs`);
  await writeFile(filename, `${source}\n`);
  return await import(`${new URL(`file://${filename}`).href}?test=${Date.now()}`);
}

function materializedNewFileSource(sourcePath) {
  const marker = `diff --git a/${sourcePath} b/${sourcePath}\n`;
  const start = patchText.indexOf(marker);
  assert.notEqual(start, -1);
  const sectionStart = start + marker.length;
  const next = patchText.indexOf("\ndiff --git ", sectionStart);
  const section = patchText.slice(sectionStart, next === -1 ? undefined : next);
  return section.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)).join("\n");
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

function envelope(sequence, type, data, turnId, sessionHandle = "opaque-session") {
  return { contractVersion: 1, sequence, sessionHandle, ...(turnId ? { turnId } : {}), type, occurredAt: sequence, data };
}

function capabilitiesResponse() {
  return json(200, {
    contractVersion: 1,
    capability: "host-agent.use",
    features: { streaming: true, cancellation: true, multiTurn: true },
    limits: { maxPromptBytes: 2 * 1024 * 1024, maxReplayEvents: 10_000 },
  });
}

function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
