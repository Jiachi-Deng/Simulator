import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

type StartedServer = {
  url: string;
  server: Server;
  shutdown?: () => Promise<void> | void;
};

type RunStatus = {
  id: string;
  status: string;
  signal: string | null;
  error: string | null;
  eventsLogPath: string;
};

type RunEvent = {
  event: string;
  data: Record<string, unknown>;
  timestamp?: number;
};

type InvocationRecord = {
  kind: 'invoke';
  pid: number;
  ppid: number;
  attempt: number;
  argv: string[];
  cwd: string;
  stdinUtf8: string;
  stdinBase64: string;
  stdinBytes: number;
  stdinSha256: string;
  eofObserved: true;
  at: number;
  allowlistedEnv: Record<string, string>;
};

type SignalRecord = {
  kind: 'signal';
  pid: number;
  signal: string;
  at: number;
};

type GrandchildRecord = {
  kind: 'grandchild';
  pid: number;
  ppid: number;
  at: number;
};

type ProbeRecord = InvocationRecord | SignalRecord | GrandchildRecord;

type ProbeMode =
  | 'success'
  | 'success-without-session-id'
  | 'stale-resume'
  | 'chunked-success'
  | 'tool-success'
  | 'empty-then-success'
  | 'text-then-transient-error'
  | 'tool-then-transient-error'
  | 'hang-until-term'
  | 'ignore-term-with-grandchild';

const SESSION = 'ses_probe_01';
const FIRST_USER = 'FIRST_USER_SENTINEL';
const FIRST_ASSISTANT = 'FIRST_ASSISTANT_SENTINEL';
const SECOND_USER = 'SECOND_USER_SENTINEL';

const HAPPY_EVENTS = [
  { type: 'status', label: 'running', sessionId: SESSION },
  { type: 'text_delta', delta: 'PROBE_REPLY_1' },
  {
    type: 'usage',
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      thought_tokens: 0,
      cached_read_tokens: 5,
      cached_write_tokens: 2,
    },
    costUsd: 0,
  },
];

describe.sequential('Simulator V0-V12 ordinary json-event-stream probe', () => {
  const originalEnv = snapshotEnv();
  let started: StartedServer | null = null;
  let probeRoot: string | null = null;

  afterEach(async () => {
    await Promise.resolve(started?.shutdown?.());
    if (started?.server) {
      await new Promise<void>((resolve) => started?.server.close(() => resolve()));
    }
    started = null;
    if (probeRoot) await rm(probeRoot, { recursive: true, force: true });
    probeRoot = null;
    restoreEnv(originalEnv);
  });

  it('V0 separates detection calls and emits the canonical minimal chat argv', async () => {
    const probe = await setupProbe('success');
    const run = await sendRunAndWait(probe, transcript(FIRST_USER), FIRST_USER);
    expect(run.status).toBe('succeeded');

    const invocations = await readInvocations(probe.logPath);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.argv).toEqual(['run', '--format', 'json']);
    expect(invocations[0]?.argv).not.toContain(FIRST_USER);
  });

  it('V1 writes exact UTF-8 stdin only after EOF and normalizes the happy path', async () => {
    const probe = await setupProbe('success');
    const run = await sendRunAndWait(probe, transcript(FIRST_USER), FIRST_USER);
    expect(run.status).toBe('succeeded');

    const [invoke] = await readInvocations(probe.logPath);
    expect(invoke?.eofObserved).toBe(true);
    expect(invoke?.stdinBytes).toBe(Buffer.byteLength(invoke?.stdinUtf8 ?? '', 'utf8'));
    expect(Buffer.from(invoke?.stdinBase64 ?? '', 'base64').toString('utf8')).toBe(invoke?.stdinUtf8);
    expect(invoke?.stdinSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(invoke?.stdinUtf8).toContain('# User request\n\n## user\n' + FIRST_USER);
    expect(invoke?.stdinUtf8.endsWith(FIRST_USER)).toBe(true);
    expect(agentEvents(await readRunEvents(run.eventsLogPath))).toEqual(HAPPY_EVENTS);
  });

  it('V2 resumes a native session in a new process and sends only the latest turn', async () => {
    const probe = await setupProbe('success', { firstReply: FIRST_ASSISTANT });
    expect((await sendRunAndWait(probe, transcript(FIRST_USER), FIRST_USER)).status).toBe('succeeded');
    expect((await sendRunAndWait(
      probe,
      transcript(FIRST_USER, FIRST_ASSISTANT, SECOND_USER),
      SECOND_USER,
    )).status).toBe('succeeded');

    const [create, resume] = await readInvocations(probe.logPath);
    expect(create?.argv).toEqual(['run', '--format', 'json']);
    expect(resume?.argv).toEqual(['run', '--format', 'json', '-s', SESSION]);
    expect(resume?.pid).not.toBe(create?.pid);
    expect(resume?.stdinUtf8).toContain(SECOND_USER);
    expect(resume?.stdinUtf8).not.toContain(FIRST_ASSISTANT);
  });

  it('V3 stays fresh without a captured session and reseeds the full transcript', async () => {
    const probe = await setupProbe('success-without-session-id', { firstReply: FIRST_ASSISTANT });
    expect((await sendRunAndWait(probe, transcript(FIRST_USER), FIRST_USER)).status).toBe('succeeded');
    expect((await sendRunAndWait(
      probe,
      transcript(FIRST_USER, FIRST_ASSISTANT, SECOND_USER),
      SECOND_USER,
    )).status).toBe('succeeded');

    const [turn1, turn2] = await readInvocations(probe.logPath);
    expect(turn1?.argv).toEqual(['run', '--format', 'json']);
    expect(turn2?.argv).toEqual(['run', '--format', 'json']);
    expect(turn2?.pid).not.toBe(turn1?.pid);
    expect(turn2?.stdinUtf8).toContain(FIRST_USER);
    expect(turn2?.stdinUtf8).toContain(FIRST_ASSISTANT);
    expect(turn2?.stdinUtf8).toContain(SECOND_USER);
  });

  it('V4 transparently reseeds one stale resume in the same Turn', async () => {
    const probe = await setupProbe('stale-resume', { firstReply: FIRST_ASSISTANT });
    expect((await sendRunAndWait(probe, transcript(FIRST_USER), FIRST_USER)).status).toBe('succeeded');
    const turn2 = await sendRunAndWait(
      probe,
      transcript(FIRST_USER, FIRST_ASSISTANT, SECOND_USER),
      SECOND_USER,
    );
    expect(turn2.status).toBe('succeeded');

    const [create, stale, reseed] = await readInvocations(probe.logPath);
    expect([create?.pid, stale?.pid, reseed?.pid]).toHaveLength(3);
    expect(new Set([create?.pid, stale?.pid, reseed?.pid]).size).toBe(3);
    expect(create?.argv).toEqual(['run', '--format', 'json']);
    expect(stale?.argv).toEqual(['run', '--format', 'json', '-s', SESSION]);
    expect(reseed?.argv).toEqual(['run', '--format', 'json']);
    expect(reseed?.stdinUtf8).toContain(FIRST_ASSISTANT);
    const events = await readRunEvents(turn2.eventsLogPath);
    expect(events.filter((event) => event.event === 'error')).toEqual([]);
    expect(events.some((event) =>
      event.event === 'diagnostic'
      && event.data.type === 'agent_resume_auto_reseed'
      && event.data.stale_session_cleared === true,
    )).toBe(true);
  });

  it('V5 tolerates arbitrary stdout chunks and flushes a final line without newline', async () => {
    const probe = await setupProbe('chunked-success');
    const run = await sendRunAndWait(probe, transcript(FIRST_USER), FIRST_USER);
    expect(run.status).toBe('succeeded');
    const events = agentEvents(await readRunEvents(run.eventsLogPath));
    expect(events).toEqual(HAPPY_EVENTS);
    expect(events.filter((event) => event.type === 'raw')).toEqual([]);
  });

  it('V6 pairs one tool_use and one tool_result without duplicating the completed call', async () => {
    const probe = await setupProbe('tool-success');
    const run = await sendRunAndWait(probe, transcript(FIRST_USER), FIRST_USER);
    expect(run.status).toBe('succeeded');
    const events = agentEvents(await readRunEvents(run.eventsLogPath));
    expect(events.filter((event) => event.type === 'tool_use')).toEqual([{
      type: 'tool_use',
      id: 'call_probe_01',
      name: 'write',
      input: { file_path: 'probe.html', content: '<main>probe</main>' },
    }]);
    expect(events.filter((event) => event.type === 'tool_result')).toEqual([{
      type: 'tool_result',
      toolUseId: 'call_probe_01',
      content: 'ok',
      isError: false,
    }]);
  });

  it('V7 retries one empty output attempt in the same run and reuses identical stdin', async () => {
    const probe = await setupProbe('empty-then-success');
    const run = await sendRunAndWait(probe, transcript(FIRST_USER), FIRST_USER);
    expect(run.status).toBe('succeeded');
    const invocations = await readInvocations(probe.logPath);
    expect(invocations).toHaveLength(2);
    expect(invocations[0]?.pid).not.toBe(invocations[1]?.pid);
    expect(invocations[0]?.stdinSha256).toBe(invocations[1]?.stdinSha256);
    const retry = (await readRunEvents(run.eventsLogPath))
      .filter((event) => event.event === 'run_retry_attempted');
    expect(retry).toHaveLength(1);
    expect(retry[0]?.data.run_id).toBe(run.id);
    expect(Number(retry[0]?.data.retry_delay_ms)).toBeGreaterThanOrEqual(250);
    expect(Number(retry[0]?.data.retry_delay_ms)).toBeLessThanOrEqual(500);
  });

  it('V8 suppresses replay after visible text', async () => {
    const probe = await setupProbe('text-then-transient-error');
    const run = await sendRunAndWait(probe, transcript(FIRST_USER), FIRST_USER);
    expect(run.status).toBe('failed');
    expect(await readInvocations(probe.logPath)).toHaveLength(1);
    const events = await readRunEvents(run.eventsLogPath);
    expect(events.filter((event) => event.event === 'run_retry_attempted')).toEqual([]);
    expect(agentEvents(events).some((event) =>
      event.type === 'text_delta' && event.delta === 'PARTIAL_VISIBLE_SENTINEL',
    )).toBe(true);
  });

  it('V9 suppresses replay after a tool call', async () => {
    const probe = await setupProbe('tool-then-transient-error');
    const run = await sendRunAndWait(probe, transcript(FIRST_USER), FIRST_USER);
    expect(run.status).toBe('failed');
    expect(await readInvocations(probe.logPath)).toHaveLength(1);
    const events = await readRunEvents(run.eventsLogPath);
    expect(events.filter((event) => event.event === 'run_retry_attempted')).toEqual([]);
    expect(agentEvents(events).filter((event) => event.type === 'tool_use')).toHaveLength(1);
  });

  it('V10 cancels a normal hanging process with SIGTERM and never retries', async () => {
    const probe = await setupProbe('hang-until-term');
    const runId = await sendRun(probe, transcript(FIRST_USER), FIRST_USER);
    await waitFor(async () => (await readInvocations(probe.logPath)).length === 1);
    const canceled = await cancelAndWait(probe.url, runId);
    expect(canceled.status).toBe('canceled');
    const records = await readRecords(probe.logPath);
    expect(records.filter((record) => record.kind === 'signal').map((record) => record.signal))
      .toEqual(['SIGTERM']);
    expect((await readRunEvents(canceled.eventsLogPath))
      .filter((event) => event.event === 'run_retry_attempted')).toEqual([]);
  });

  it('V11 escalates to SIGKILL for the process group and reaps its grandchild', async () => {
    process.env.OD_CHAT_RUN_CANCEL_GRACE_MS = '100';
    process.env.OD_CHAT_RUN_CANCEL_FORCE_WAIT_MS = '100';
    const probe = await setupProbe('ignore-term-with-grandchild');
    const runId = await sendRun(probe, transcript(FIRST_USER), FIRST_USER);
    await waitFor(async () => {
      const records = await readRecords(probe.logPath);
      return records.some((record) => record.kind === 'grandchild');
    });
    const beforeCancel = await readRecords(probe.logPath);
    const parentPid = (beforeCancel.find((record) => record.kind === 'invoke') as InvocationRecord).pid;
    const grandchildPid = (beforeCancel.find((record) => record.kind === 'grandchild') as GrandchildRecord).pid;
    const canceled = await cancelAndWait(probe.url, runId);
    expect(canceled.status).toBe('canceled');
    expect(canceled.signal).toBe('SIGKILL');
    await waitFor(() => !isPidAlive(parentPid) && !isPidAlive(grandchildPid));
    expect(isPidAlive(parentPid)).toBe(false);
    expect(isPidAlive(grandchildPid)).toBe(false);
  });

  it('V12 cancels during retry backoff without spawning a second process', async () => {
    const probe = await setupProbe('empty-then-success');
    const runId = await sendRun(probe, transcript(FIRST_USER), FIRST_USER);
    await waitFor(async () => (await readEventsByRunId(probe.url, runId))
      .some((event) => event.event === 'run_retry_attempted'));
    const canceled = await cancelAndWait(probe.url, runId);
    expect(canceled.status).toBe('canceled');
    await delay(650);
    expect(await readInvocations(probe.logPath)).toHaveLength(1);
  });

  async function setupProbe(
    mode: ProbeMode,
    options: { firstReply?: string } = {},
  ): Promise<{
    url: string;
    projectId: string;
    conversationId: string;
    logPath: string;
  }> {
    probeRoot = await mkdtemp(path.join(os.tmpdir(), 'od-ordinary-runtime-probe-'));
    const projectId = `ordinary_probe_${randomUUID()}`;
    const { bin, logPath } = await writeFakeOpencode(
      probeRoot,
      mode,
      projectId,
      options.firstReply,
    );
    clearTelemetryEnv();
    started = await startServer({ port: 0, returnServer: true }) as StartedServer;
    await putConfig(started.url, {
      agentId: 'opencode',
      agentCliEnv: { opencode: { OPENCODE_BIN: bin } },
      telemetry: { metrics: true, content: false, artifactManifest: false },
      privacyDecisionAt: Date.now(),
    });
    const conversationId = await createConversation(started.url, projectId);
    return { url: started.url, projectId, conversationId, logPath };
  }
});

async function writeFakeOpencode(
  root: string,
  mode: ProbeMode,
  projectId: string,
  firstReply = 'PROBE_REPLY_1',
): Promise<{ bin: string; logPath: string }> {
  const bin = path.join(root, 'opencode-probe');
  const logPath = path.join(root, 'probe-invocations.jsonl');
  const statePath = path.join(root, 'probe-attempt.txt');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const MODE = ${JSON.stringify(mode)};
const PROJECT_ID = ${JSON.stringify(projectId)};
const SESSION = ${JSON.stringify(SESSION)};
const FIRST_REPLY = ${JSON.stringify(firstReply)};
const LOG = ${JSON.stringify(logPath)};
const STATE = ${JSON.stringify(statePath)};
const argv = process.argv.slice(2);
const append = (record) => fs.appendFileSync(LOG, JSON.stringify({ ...record, at: Date.now() }) + '\\n');
if (argv.includes('--version')) { process.stdout.write('1.17.7\\n'); process.exit(0); }
if (argv.includes('--help')) { process.stdout.write('opencode run [message..]\\n'); process.exit(0); }
if (argv[0] === 'models') { process.stdout.write('anthropic/claude-sonnet-4-5\\n'); process.exit(0); }
const isTarget = process.cwd().includes(PROJECT_ID) && argv[0] === 'run';
let chunks = [];
process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
process.stdin.on('end', () => {
  const stdin = Buffer.concat(chunks);
  if (!isTarget) {
    happy('background-session', 'Background reply.');
    return;
  }
  let attempt = 0;
  try { attempt = Number(fs.readFileSync(STATE, 'utf8')) || 0; } catch {}
  attempt += 1;
  fs.writeFileSync(STATE, String(attempt));
  append({
    kind: 'invoke', pid: process.pid, ppid: process.ppid, attempt, argv,
    cwd: process.cwd(), stdinUtf8: stdin.toString('utf8'),
    stdinBase64: stdin.toString('base64'), stdinBytes: stdin.byteLength,
    stdinSha256: crypto.createHash('sha256').update(stdin).digest('hex'),
    eofObserved: true,
    allowlistedEnv: {
      OD_PROBE_MODE: MODE,
      OD_CHAT_RUN_CANCEL_GRACE_MS: process.env.OD_CHAT_RUN_CANCEL_GRACE_MS || '',
      OD_CHAT_RUN_CANCEL_FORCE_WAIT_MS: process.env.OD_CHAT_RUN_CANCEL_FORCE_WAIT_MS || '',
    },
  });
  run(attempt);
});
function line(value, newline = true) {
  process.stdout.write(JSON.stringify(value) + (newline ? '\\n' : ''));
}
function start(session = SESSION) {
  line({ type: 'step_start', ...(session ? { sessionID: session } : {}), part: { type: 'step-start' } });
}
function text(value, session = SESSION) {
  line({ type: 'text', ...(session ? { sessionID: session } : {}), part: { type: 'text', text: value } });
}
function finish(session = SESSION, newline = true) {
  line({ type: 'step_finish', ...(session ? { sessionID: session } : {}), part: { type: 'step-finish', tokens: { input: 11, output: 7, reasoning: 0, cache: { read: 5, write: 2 } }, cost: 0 } }, newline);
}
function happy(session = SESSION, reply = 'PROBE_REPLY_1', newline = true) {
  start(session); text(reply, session); finish(session, newline);
}
function toolRunning() {
  line({ type: 'tool_use', sessionID: SESSION, part: { tool: 'write', callID: 'call_probe_01', state: { status: 'running', input: { file_path: 'probe.html', content: '<main>probe</main>' } } } });
}
function streamError() {
  line({ type: 'error', error: { message: 'stream disconnected before completion' } });
}
function run(attempt) {
  if (MODE === 'success') return happy(SESSION, attempt === 1 ? FIRST_REPLY : 'PROBE_REPLY_1');
  if (MODE === 'success-without-session-id') return happy('', attempt === 1 ? FIRST_REPLY : 'PROBE_REPLY_1');
  if (MODE === 'stale-resume') {
    if (argv.includes('-s')) { process.stderr.write('Error: Session not found\\n'); process.exitCode = 0; return; }
    return happy(SESSION, attempt === 1 ? FIRST_REPLY : 'PROBE_REPLY_1');
  }
  if (MODE === 'chunked-success') {
    const one = JSON.stringify({ type: 'step_start', sessionID: SESSION, part: { type: 'step-start' } }) + '\\n';
    process.stdout.write(one.slice(0, 17));
    setTimeout(() => { process.stdout.write(one.slice(17)); text('PROBE_REPLY_1'); finish(SESSION, false); }, 15);
    return;
  }
  if (MODE === 'tool-success') {
    toolRunning();
    line({ type: 'tool_use', sessionID: SESSION, part: { tool: 'write', callID: 'call_probe_01', state: { status: 'completed', input: { file_path: 'probe.html', content: '<main>probe</main>' }, output: 'ok' } } });
    text('PROBE_REPLY_1'); finish(); return;
  }
  if (MODE === 'empty-then-success') {
    if (attempt === 1) return;
    return happy();
  }
  if (MODE === 'text-then-transient-error') {
    start(); text('PARTIAL_VISIBLE_SENTINEL'); streamError(); return;
  }
  if (MODE === 'tool-then-transient-error') {
    start(); toolRunning(); streamError(); return;
  }
  if (MODE === 'hang-until-term') {
    start();
    process.on('SIGTERM', () => { append({ kind: 'signal', pid: process.pid, signal: 'SIGTERM' }); process.exit(143); });
    setInterval(() => {}, 1000); return;
  }
  if (MODE === 'ignore-term-with-grandchild') {
    start();
    process.on('SIGTERM', () => append({ kind: 'signal', pid: process.pid, signal: 'SIGTERM' }));
    const childCode = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
    const child = spawn(process.execPath, ['-e', childCode], { stdio: 'ignore' });
    append({ kind: 'grandchild', pid: child.pid, ppid: process.pid });
    setInterval(() => {}, 1000); return;
  }
  throw new Error('unknown mode ' + MODE);
}
`;
  await writeFile(bin, script, 'utf8');
  await chmod(bin, 0o755);
  return { bin, logPath };
}

function transcript(user: string, assistant?: string, followup?: string): string {
  const sections = [`## user\n${user}`];
  if (assistant !== undefined) sections.push(`## assistant\n${assistant}`);
  if (followup !== undefined) sections.push(`## user\n${followup}`);
  return sections.join('\n\n');
}

async function putConfig(url: string, patch: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${url}/api/app-config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  expect(response.status).toBe(200);
}

async function createConversation(url: string, projectId: string): Promise<string> {
  const response = await fetch(`${url}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: projectId,
      name: 'Ordinary Runtime probe',
      metadata: { kind: 'prototype' },
      skipDiscoveryBrief: true,
    }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { conversationId: string }).conversationId;
}

async function sendRun(
  probe: { url: string; projectId: string; conversationId: string },
  message: string,
  currentPrompt: string,
): Promise<string> {
  const response = await fetch(`${probe.url}/api/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-od-analytics-device-id': 'ordinary-runtime-probe',
      'x-od-analytics-session-id': 'ordinary-runtime-probe-session',
      'x-od-analytics-client-type': 'web',
    },
    body: JSON.stringify({
      projectId: probe.projectId,
      conversationId: probe.conversationId,
      assistantMessageId: `assistant_probe_${randomUUID()}`,
      clientRequestId: `client_probe_${randomUUID()}`,
      agentId: 'opencode',
      message,
      currentPrompt,
    }),
  });
  expect(response.status).toBe(202);
  return ((await response.json()) as { runId: string }).runId;
}

async function sendRunAndWait(
  probe: { url: string; projectId: string; conversationId: string },
  message: string,
  currentPrompt: string,
): Promise<RunStatus> {
  return await waitForRun(probe.url, await sendRun(probe, message, currentPrompt));
}

async function cancelAndWait(url: string, runId: string): Promise<RunStatus> {
  const response = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
  expect(response.status).toBe(200);
  return await waitForRun(url, runId);
}

async function waitForRun(url: string, runId: string): Promise<RunStatus> {
  let latest: RunStatus | null = null;
  await waitFor(async () => {
    const response = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}`);
    expect(response.status).toBe(200);
    latest = await response.json() as RunStatus;
    return ['failed', 'succeeded', 'canceled'].includes(latest.status);
  }, 15_000);
  return latest!;
}

async function readEventsByRunId(url: string, runId: string): Promise<RunEvent[]> {
  const response = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}`);
  if (!response.ok) return [];
  const status = await response.json() as RunStatus;
  return await readRunEvents(status.eventsLogPath);
}

async function readRunEvents(eventsLogPath: string): Promise<RunEvent[]> {
  try {
    return (await readFile(eventsLogPath, 'utf8')).trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as RunEvent);
  } catch {
    return [];
  }
}

function agentEvents(events: RunEvent[]): Array<Record<string, unknown>> {
  return events.filter((event) => event.event === 'agent').map((event) => event.data);
}

async function readRecords(logPath: string): Promise<ProbeRecord[]> {
  try {
    return (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as ProbeRecord);
  } catch {
    return [];
  }
}

async function readInvocations(logPath: string): Promise<InvocationRecord[]> {
  return (await readRecords(logPath)).filter((record): record is InvocationRecord => record.kind === 'invoke');
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries([
    'LANGFUSE_PUBLIC_KEY',
    'LANGFUSE_SECRET_KEY',
    'LANGFUSE_BASE_URL',
    'OPEN_DESIGN_TELEMETRY_RELAY_URL',
    'POSTHOG_KEY',
    'POSTHOG_HOST',
    'OD_CHAT_RUN_CANCEL_GRACE_MS',
    'OD_CHAT_RUN_CANCEL_FORCE_WAIT_MS',
  ].map((key) => [key, process.env[key]]));
}

function restoreEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearTelemetryEnv(): void {
  delete process.env.POSTHOG_KEY;
  delete process.env.POSTHOG_HOST;
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;
  delete process.env.LANGFUSE_BASE_URL;
  delete process.env.OPEN_DESIGN_TELEMETRY_RELAY_URL;
}
