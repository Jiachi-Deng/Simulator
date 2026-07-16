import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { isAllowedPatchPath } from "../src/apply-simulator-patch.mjs";

const moduleRoot = new URL("../", import.meta.url);
const patchText = await readFile(new URL("patches/open-design-v0.14.1-simulator-host-runtime.patch", moduleRoot), "utf8");
const provenance = JSON.parse(await readFile(new URL("provenance.json", moduleRoot), "utf8"));
const contractFixtures = JSON.parse(await readFile(
  new URL("../../../packages/host-agent-contract/fixtures/host-agent-v2-fixtures.json", import.meta.url),
  "utf8",
));
const canonicalTranscripts = contractFixtures.valid.transcripts;
const runHandle = `run_${"a".repeat(32)}`;
const execFileAsync = promisify(execFile);

test("pins the audited OpenDesign upstream commit", () => {
  assert.equal(provenance.source.commit, "2225647726d5387bb24e9539fdb577958b6d88c6");
  assert.equal(provenance.source.ref, "open-design-v0.14.1");
});

test("strict patch scope contains a complete git-applied v2 parser and no unrelated surface", async (t) => {
  const changedPaths = provenance.simulatorPatch.changedPaths;
  assert.equal(changedPaths.length, 23);
  assert.ok(changedPaths.every(isAllowedPatchPath));
  assert.ok(changedPaths.includes("apps/daemon/src/runtimes/simulator-host-v2-event-stream.ts"));
  assert.equal(changedPaths.includes("apps/daemon/src/runtimes/runs.ts"), false);

  const root = await mkdtemp(path.join(os.tmpdir(), "simulator-host-v2-git-apply-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = "apps/daemon/src/runtimes/simulator-host-v2-event-stream.ts";
  const patchPath = path.join(root, "simulator-host.patch");
  const targetPath = path.join(root, sourcePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(patchPath, patchText);
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", ["apply", `--include=${sourcePath}`, patchPath], { cwd: root });

  const source = await readFile(targetPath, "utf8");
  const expectedDigest = provenance.simulatorPatch.fileDigests.find((entry) => entry.path === sourcePath)?.postimageSha256;
  assert.equal(createHash("sha256").update(source).digest("hex"), expectedDigest);
  const importPath = path.join(root, "simulator-host-v2-event-stream.mjs");
  await writeFile(importPath, source);
  const parser = await import(`${pathToFileURL(importPath).href}?test=${Date.now()}`);
  assert.equal(typeof parser.createSimulatorHostV2EventHandler, "function");
});

test("patch uses an ordinary json-event-stream runtime with an empty argv", () => {
  const runtime = materializedNewFileSource("apps/daemon/src/runtimes/defs/simulator-host.ts");
  assert.match(runtime, /bin: shimPath/);
  assert.match(runtime, /buildArgs: \(\) => \[\]/);
  assert.match(runtime, /promptViaStdin: true/);
  assert.match(runtime, /streamFormat: 'json-event-stream'/);
  assert.match(runtime, /eventParser: 'simulator-host-v2'/);
});

test("runtime exposes no resume, MCP, model, provider, or custom daemon adapter option", () => {
  const runtime = materializedNewFileSource("apps/daemon/src/runtimes/defs/simulator-host.ts");
  assert.doesNotMatch(runtime, /resumeSessionId|resumesSessionViaCli|externalMcpInjection|--model|\bprovider\s*:/);
  assert.doesNotMatch(patchText, /runSimulatorHostAgentTurn|disposeSimulatorHostAgentSessions|cachedSessions|SESSION_CACHE|streamFormat: 'simulator-host-runtime'/);
});

test("Host environment contains exactly the four v2 launch values", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simulator-host-v2-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = await importMaterializedNewFile(root, "apps/daemon/src/simulator-host-agent.ts");
  const env = validHostEnv();
  assert.deepEqual(host.simulatorHostAgentLaunchEnvironment(env), env);
  assert.equal(host.SIMULATOR_HOST_AGENT_CONTRACT_VERSION, "2");
});

test("partial Host configuration enters Host mode but fails closed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simulator-host-v2-partial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = await importMaterializedNewFile(root, "apps/daemon/src/simulator-host-agent.ts");
  const partial = { SIMULATOR_HOST_AGENT_URL: "http://127.0.0.1:43123/" };
  assert.equal(host.isSimulatorHostAgentMode(partial), true);
  assert.equal(host.simulatorHostAgentConfigured(partial), false);
  assert.deepEqual(host.simulatorHostAgentLaunchEnvironment(partial), {});
  assert.equal(host.simulatorHostAgentInfo(partial).available, false);
  assert.equal(host.isSimulatorHostAgentMode({ SIMULATOR_HOST_AGENT_URL: "" }), true);
});

test("Host configuration rejects non-loopback URLs and noncanonical paths", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simulator-host-v2-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = await importMaterializedNewFile(root, "apps/daemon/src/simulator-host-agent.ts");
  assert.equal(host.simulatorHostAgentConfigured({ ...validHostEnv(), SIMULATOR_HOST_AGENT_URL: "https://example.com/" }), false);
  assert.equal(host.simulatorHostAgentConfigured({ ...validHostEnv(), SIMULATOR_HOST_AGENT_TOKEN_FILE: "relative/token" }), false);
  assert.equal(host.simulatorHostAgentConfigured({ ...validHostEnv(), SIMULATOR_HOST_AGENT_SHIM_PATH: "/tmp/../tmp/shim" }), false);
  assert.equal(host.simulatorHostAgentConfigured({ ...validHostEnv(), SIMULATOR_HOST_AGENT_CONTRACT_VERSION: "1" }), false);
});

test("configured agent info points at the Host shim and contract v2", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simulator-host-v2-info-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = await importMaterializedNewFile(root, "apps/daemon/src/simulator-host-agent.ts");
  const info = host.simulatorHostAgentInfo(validHostEnv());
  assert.equal(info.available, true);
  assert.equal(info.path, "/tmp/simulator-host-agent.mjs");
  assert.equal(info.version, "contract-v2");
  assert.equal(info.streamFormat, "json-event-stream");
});

test("Host launch values are inherited rather than scrubbed before shim spawn", () => {
  const host = materializedNewFileSource("apps/daemon/src/simulator-host-agent.ts");
  assert.doesNotMatch(host, /delete process\.env/);
  for (const name of [
    "SIMULATOR_HOST_AGENT_URL",
    "SIMULATOR_HOST_AGENT_TOKEN_FILE",
    "SIMULATOR_HOST_AGENT_SHIM_PATH",
    "SIMULATOR_HOST_AGENT_CONTRACT_VERSION",
  ]) assert.match(host, new RegExp(name));
});

test("v2 parser maps the canonical completed transcript", async (t) => {
  const parser = await parserForTest(t);
  const events = [];
  const handler = parser.createSimulatorHostV2EventHandler((event) => events.push(event));
  feed(handler, canonicalTranscripts.completed);
  handler.handleEnd();
  assert.deepEqual(events, [
    { type: "status", label: "initializing" },
    { type: "status", label: "running" },
    { type: "text_delta", delta: "Hello" },
    { type: "text_delta", delta: " world" },
    { type: "thinking_delta", delta: "Checking layout" },
    { type: "status", label: "Write file" },
    { type: "status", label: "Main preview", presentation: { itemId: "preview.main", kind: "preview", title: "Main preview", uri: "http://127.0.0.1:4173/", mediaType: "text/html" }, simulatorHostV2Completion: "presentation" },
    { type: "status", label: "completed" },
    { type: "status", label: "closed" },
  ]);
});

test("v2 parser maps the canonical failed transcript to one OpenDesign error", async (t) => {
  const events = await parseEvents(t, canonicalTranscripts.failed);
  assert.equal(events.filter((entry) => entry.type === "error").length, 1);
  assert.match(events.find((entry) => entry.type === "error").message, /RUNTIME_UNAVAILABLE/);
});

test("v2 parser maps the canonical interrupted transcript to one OpenDesign error", async (t) => {
  const events = await parseEvents(t, canonicalTranscripts.interrupted);
  assert.equal(events.filter((entry) => entry.type === "error").length, 1);
  assert.match(events.find((entry) => entry.type === "error").message, /CRAFT_TURN_PREEMPTED/);
});

test("materialized daemon bridge preserves canonical Host terminal code and retryability", async (t) => {
  const parser = await parserForTest(t);
  const cases = [
    [canonicalTranscripts.failedBeforeStart, "RUNTIME_UNAVAILABLE", true],
    [canonicalTranscripts.interrupted, "CRAFT_TURN_PREEMPTED", true],
    [canonicalTranscripts.interruptedBeforeStart, "CLIENT_CANCELLED", false],
    [[
      event(1, "run.accepted", {}),
      event(2, "turn.started", {}),
      event(3, "turn.failed", { code: "BROKER_DISCONNECTED", retryable: true }),
      event(4, "run.closed", {}),
    ], "BROKER_DISCONNECTED", true],
    [[
      event(1, "run.accepted", {}),
      event(2, "turn.failed", { code: "TOOL_BOUNDARY_UNAVAILABLE", retryable: false }),
      event(3, "run.closed", {}),
    ], "TOOL_BOUNDARY_UNAVAILABLE", false],
  ];

  for (const [transcript, code, retryable] of cases) {
    const agentEvents = [];
    const handler = parser.createSimulatorHostV2EventHandler((value) => agentEvents.push(value));
    feed(handler, transcript);
    handler.handleEnd();
    const terminal = agentEvents.find((entry) => entry.type === "error");
    const payload = parser.simulatorHostV2TerminalSsePayload("simulator-host-v2", terminal);
    assert.equal(payload.error.code, code);
    assert.equal(payload.error.retryable, retryable);
    assert.equal(payload.error.message, terminal.message);
    assert.equal(payload.error.details.raw, terminal.raw);
    assert.equal(parser.simulatorHostV2TerminalSsePayload("another-parser", terminal), null);
  }

  const protocolEvents = await parseEvents(t, [event(2, "turn.started", {})]);
  assert.equal(parser.simulatorHostV2TerminalSsePayload("simulator-host-v2", protocolEvents[0]), null);
});

test("presentation-only completion crosses the daemon substantive-output bridge", async (t) => {
  const parser = await parserForTest(t);
  const agentEvents = [];
  const handler = parser.createSimulatorHostV2EventHandler((value) => agentEvents.push(value));
  feed(handler, [
    event(1, "run.accepted", {}),
    event(2, "turn.started", {}),
    event(3, "presentation.item", {
      itemId: "file.index",
      kind: "file",
      title: "index.html",
      uri: "file:///workspace/index.html",
      mediaType: "text/html",
    }),
    event(4, "turn.completed", {}),
    event(5, "run.closed", {}),
  ]);
  handler.handleEnd();

  assert.equal(agentEvents.some((entry) => entry.type === "error"), false);
  const substantive = agentEvents.filter((entry) => (
    parser.simulatorHostV2AgentEventIsSubstantive("simulator-host-v2", entry)
  ));
  assert.equal(substantive.length, 1);
  assert.equal(substantive[0].presentation.itemId, "file.index");
  assert.equal(parser.simulatorHostV2AgentEventIsSubstantive("another-parser", substantive[0]), false);
});

test("v2 parser maps the canonical failed-before-start transcript without inventing turn.started", async (t) => {
  const events = await parseEvents(t, canonicalTranscripts.failedBeforeStart);
  assert.deepEqual(events.map(({ type, label }) => ({ type, ...(label === undefined ? {} : { label }) })), [
    { type: "status", label: "initializing" },
    { type: "error" },
    { type: "status", label: "closed" },
  ]);
  assert.match(events[1].message, /RUNTIME_UNAVAILABLE/);
});

test("v2 parser maps the canonical interrupted-before-start transcript without inventing turn.started", async (t) => {
  const events = await parseEvents(t, canonicalTranscripts.interruptedBeforeStart);
  assert.deepEqual(events.map(({ type, label }) => ({ type, ...(label === undefined ? {} : { label }) })), [
    { type: "status", label: "initializing" },
    { type: "error" },
    { type: "status", label: "closed" },
  ]);
  assert.match(events[1].message, /CLIENT_CANCELLED/);
});

test("v2 parser permits only started or a failure terminal while awaiting start, then only run.closed", async (t) => {
  const acceptedFrame = canonicalTranscripts.failedBeforeStart[0];
  const terminalFrame = canonicalTranscripts.failedBeforeStart[1];
  const invalidBeforeStartFrames = [
    ["run.accepted", {}],
    ["message.delta", { delta: "early" }],
    ["reasoning.delta", { delta: "early" }],
    ["activity", { phase: "started", kind: "runtime" }],
    ["presentation.item", { itemId: "early.item", kind: "text", text: "early" }],
    ["turn.completed", { finalText: "early" }],
    ["run.closed", {}],
  ];

  for (const [type, data] of invalidBeforeStartFrames) {
    const events = await parseEvents(t, [acceptedFrame, { ...terminalFrame, type, data }]);
    assert.equal(events.filter((entry) => entry.type === "error").length, 1, type);
    assert.match(events.at(-1).message, /out of order/, type);
  }

  const prefix = canonicalTranscripts.failedBeforeStart.slice(0, 2);
  const closingFrame = canonicalTranscripts.failedBeforeStart[2];
  const nonClosingFrames = [
    ["run.accepted", {}],
    ["turn.started", {}],
    ["message.delta", { delta: "late" }],
    ["reasoning.delta", { delta: "late" }],
    ["activity", { phase: "started", kind: "runtime" }],
    ["presentation.item", { itemId: "late.item", kind: "text", text: "late" }],
    ["turn.completed", { finalText: "late" }],
    ["turn.failed", { code: "RUNTIME_UNAVAILABLE", retryable: true }],
    ["turn.interrupted", { reason: "CLIENT_CANCELLED", retryable: false }],
  ];

  for (const [type, data] of nonClosingFrames) {
    const events = await parseEvents(t, [...prefix, { ...closingFrame, type, data }]);
    assert.equal(events.filter((entry) => entry.type === "error").length, 2, type);
    assert.match(events.at(-1).message, /out of order/, type);
  }
});

test("v2 parser rejects unknown envelope fields", async (t) => {
  const bad = { ...event(1, "run.accepted", {}), providerSessionId: "must-not-cross" };
  const events = await parseEvents(t, [bad]);
  assert.match(events[0].message, /missing or unknown fields/);
});

test("v2 parser rejects a replay gap", async (t) => {
  const events = await parseEvents(t, [event(2, "turn.started", {})]);
  assert.match(events[0].message, /sequence is not contiguous/);
});

test("v2 parser rejects a runHandle change", async (t) => {
  const changed = { ...event(2, "turn.started", {}), runHandle: `run_${"b".repeat(32)}` };
  const events = await parseEvents(t, [event(1, "run.accepted", {}), changed]);
  assert.match(events.at(-1).message, /runHandle changed/);
});

test("v2 parser rejects retryability that disagrees with the closed contract", async (t) => {
  const events = await parseEvents(t, [
    event(1, "run.accepted", {}),
    event(2, "turn.started", {}),
    event(3, "turn.failed", { code: "TOOL_BOUNDARY_UNAVAILABLE", retryable: true }),
  ]);
  assert.match(events.at(-1).message, /turn\.failed is invalid/);
});

test("v2 parser rejects finalText that disagrees with streamed deltas", async (t) => {
  const events = await parseEvents(t, [
    event(1, "run.accepted", {}),
    event(2, "turn.started", {}),
    event(3, "message.delta", { delta: "Hello" }),
    event(4, "turn.completed", { finalText: "Different" }),
  ]);
  assert.match(events.at(-1).message, /finalText disagrees/);
});

test("v2 parser reports invalid JSON once and suppresses follow-on noise", async (t) => {
  const parser = await parserForTest(t);
  const events = [];
  const handler = parser.createSimulatorHostV2EventHandler((event) => events.push(event));
  handler.handleInvalidJson();
  handler.handleInvalidJson();
  handler.handle(event(1, "run.accepted", {}));
  assert.equal(events.length, 1);
  assert.match(events[0].message, /not valid JSON/);
});

test("v2 parser rejects delta frames above 64 KiB", async (t) => {
  const events = await parseEvents(t, [
    event(1, "run.accepted", {}),
    event(2, "turn.started", {}),
    event(3, "message.delta", { delta: "x".repeat(64 * 1024 + 1) }),
  ]);
  assert.match(events.at(-1).message, /message\.delta is invalid/);
});

test("v2 parser bounds its streamed-text copy without rejecting a legal long answer", async (t) => {
  const parser = await parserForTest(t);
  const longAnswerEvents = [];
  const longAnswer = parser.createSimulatorHostV2EventHandler((value) => longAnswerEvents.push(value));
  longAnswer.handle(event(1, "run.accepted", {}));
  longAnswer.handle(event(2, "turn.started", {}));
  const chunk = "x".repeat(64 * 1024);
  for (let sequence = 3; sequence <= 7; sequence += 1) {
    longAnswer.handle(event(sequence, "message.delta", { delta: chunk }));
  }
  longAnswer.handle(event(8, "turn.completed", {}));
  longAnswer.handle(event(9, "run.closed", {}));
  longAnswer.handleEnd();
  assert.equal(longAnswerEvents.filter((entry) => entry.type === "text_delta").length, 5);
  assert.equal(longAnswerEvents.some((entry) => entry.type === "error"), false);

  const unverifiableFinalEvents = [];
  const unverifiableFinal = parser.createSimulatorHostV2EventHandler((value) => unverifiableFinalEvents.push(value));
  unverifiableFinal.handle(event(1, "run.accepted", {}));
  unverifiableFinal.handle(event(2, "turn.started", {}));
  for (let sequence = 3; sequence <= 7; sequence += 1) {
    unverifiableFinal.handle(event(sequence, "message.delta", { delta: chunk }));
  }
  unverifiableFinal.handle(event(8, "turn.completed", { finalText: "x" }));
  assert.match(unverifiableFinalEvents.at(-1).message, /finalText cannot be verified/);
});

test("v2 parser rejects NUL data and a stream ending before run.closed", async (t) => {
  const parser = await parserForTest(t);
  const events = [];
  const handler = parser.createSimulatorHostV2EventHandler((value) => events.push(value));
  handler.handle(event(1, "run.accepted", {}));
  handler.handle(event(2, "turn.started", {}));
  handler.handle(event(3, "message.delta", { delta: "unsafe\0text" }));
  assert.match(events.at(-1).message, /message\.delta is invalid/);

  const truncatedEvents = [];
  const truncated = parser.createSimulatorHostV2EventHandler((value) => truncatedEvents.push(value));
  truncated.handle(event(1, "run.accepted", {}));
  truncated.handleEnd();
  assert.match(truncatedEvents.at(-1).message, /ended before run\.closed/);
});

test("ordinary Runtime cancellation and process-group cleanup remain the only daemon path", async () => {
  const probe = await readFile(new URL("test/fixtures/ordinary-runtime-probe.e2e.ts", moduleRoot), "utf8");
  assert.match(probe, /SIGTERM/);
  assert.match(probe, /SIGKILL/);
  assert.match(probe, /grandchild/);
  assert.doesNotMatch(patchText, /externalCancel/);
});

test("Host-only product policy remains while Cloud and AMR requests stay disabled", () => {
  const additions = patchText.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).join("\n");
  assert.match(additions, /normalizeSimulatorHostConfig/);
  assert.match(additions, /onboardingCompleted: true/);
  assert.match(additions, /if \(isSimulatorHostAgentMode\(\)\) return;/);
  assert.match(additions, /Open Design Cloud is disabled in Simulator Host Runtime mode/);
});

test("patched daemon sendAgentEvent uses the Host terminal and substantive bridges", () => {
  const additions = patchText.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).join("\n");
  const terminalBridge = patchText.indexOf("const simulatorHostTerminalPayload = simulatorHostV2TerminalSsePayload(");
  const genericError = patchText.indexOf("if (ev?.type === 'error') {", terminalBridge);
  assert.ok(terminalBridge >= 0);
  assert.ok(genericError > terminalBridge);
  assert.match(additions, /send\('error', simulatorHostTerminalPayload\)/);
  assert.match(additions, /simulatorHostV2AgentEventIsSubstantive\(def\.eventParser, ev\)/);
});

function validHostEnv() {
  return {
    SIMULATOR_HOST_AGENT_URL: "http://127.0.0.1:43123/",
    SIMULATOR_HOST_AGENT_TOKEN_FILE: "/tmp/simulator-host-token",
    SIMULATOR_HOST_AGENT_SHIM_PATH: "/tmp/simulator-host-agent.mjs",
    SIMULATOR_HOST_AGENT_CONTRACT_VERSION: "2",
  };
}

function event(sequence, type, data) {
  return {
    contractVersion: 2,
    eventId: String(sequence),
    sequence,
    runHandle,
    occurredAt: 1_700_000_000_000 + sequence,
    type,
    data,
  };
}

function feed(handler, events) {
  for (const value of events) handler.handle(value);
}

async function parseEvents(t, values) {
  const parser = await parserForTest(t);
  const events = [];
  const handler = parser.createSimulatorHostV2EventHandler((value) => events.push(value));
  feed(handler, values);
  return events;
}

async function parserForTest(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "simulator-host-v2-parser-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return await importMaterializedNewFile(root, "apps/daemon/src/runtimes/simulator-host-v2-event-stream.ts");
}

async function importMaterializedNewFile(root, sourcePath) {
  const source = materializedNewFileSource(sourcePath);
  const filename = path.join(root, `${path.basename(sourcePath).replace(/\.[^.]+$/, "")}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  await writeFile(filename, `${source}\n`);
  return await import(`${new URL(`file://${filename}`).href}?test=${Date.now()}`);
}

function materializedNewFileSource(sourcePath) {
  const marker = `diff --git a/${sourcePath} b/${sourcePath}\n`;
  const start = patchText.indexOf(marker);
  assert.notEqual(start, -1, sourcePath);
  const sectionStart = start + marker.length;
  const next = patchText.indexOf("\ndiff --git ", sectionStart);
  const section = patchText.slice(sectionStart, next === -1 ? undefined : next);
  return section.split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}
