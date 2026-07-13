#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { stagingAssert, stagingFail } from "./staging-error.mjs";

export async function smokeLoopback({ daemonUrl, webUrl, timeoutMs = 30_000, pollMs = 250, request = fetch, sleep = defaultSleep } = {}) {
  const daemon = assertLoopbackUrl(daemonUrl, "daemon");
  const web = assertLoopbackUrl(webUrl, "web");
  stagingAssert(Number.isInteger(timeoutMs) && timeoutMs > 0, "SMOKE_ARGUMENT_INVALID", "timeoutMs must be a positive integer");
  stagingAssert(Number.isInteger(pollMs) && pollMs > 0 && pollMs <= timeoutMs, "SMOKE_ARGUMENT_INVALID", "pollMs must be a positive integer no greater than timeoutMs");
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() <= deadline) {
    try {
      const result = await probe({ daemon, web, request });
      return { ok: true, ...result };
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
  }
  stagingFail("LOOPBACK_NOT_READY", lastError instanceof Error ? lastError.message : "daemon or web did not become ready");
}

export function assertLoopbackUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    stagingFail("SMOKE_ARGUMENT_INVALID", `${label} URL is invalid`);
  }
  stagingAssert(parsed.protocol === "http:", "SMOKE_ARGUMENT_INVALID", `${label} URL must use http`);
  stagingAssert(!parsed.username && !parsed.password && !parsed.search && !parsed.hash && (parsed.pathname === "/" || parsed.pathname === ""), "SMOKE_ARGUMENT_INVALID", `${label} URL must be a bare loopback origin`);
  stagingAssert(["127.0.0.1", "[::1]", "::1"].includes(parsed.hostname), "SMOKE_NON_LOOPBACK_FORBIDDEN", `${label} URL must use 127.0.0.1 or ::1`);
  return parsed;
}

async function probe({ daemon, web, request }) {
  const [daemonHealth, daemonReady, webHome, webReady] = await Promise.all([
    requestJson(request, new URL("/api/health", daemon), "daemon health"),
    requestJson(request, new URL("/api/ready", daemon), "daemon readiness"),
    requestHtml(request, new URL("/", web), "web root"),
    requestJson(request, new URL("/api/ready", web), "web daemon-proxy readiness"),
  ]);
  assertReadyPayload(daemonHealth, "daemon health");
  assertReadyPayload(daemonReady, "daemon readiness");
  stagingAssert(daemonReady.ready === true, "LOOPBACK_DAEMON_NOT_READY", "daemon /api/ready did not report ready=true");
  assertReadyPayload(webReady, "web daemon-proxy readiness");
  stagingAssert(webReady.ready === true, "LOOPBACK_WEB_PROXY_NOT_READY", "web /api/ready did not report ready=true");
  stagingAssert(daemonHealth.version === daemonReady.version && daemonReady.version === webReady.version, "LOOPBACK_VERSION_MISMATCH", "daemon and web proxy readiness versions do not match");
  return { daemonVersion: daemonReady.version, webStatus: webHome.status };
}

async function requestJson(request, url, label) {
  const response = await request(url, { redirect: "error" });
  stagingAssert(response?.ok === true, "LOOPBACK_HTTP_FAILURE", `${label} returned HTTP ${response?.status ?? "unknown"}`);
  try {
    return await response.json();
  } catch (error) {
    stagingFail("LOOPBACK_INVALID_JSON", `${label} did not return JSON: ${error.message}`);
  }
}

async function requestHtml(request, url, label) {
  const response = await request(url, { redirect: "error" });
  stagingAssert(response?.ok === true, "LOOPBACK_HTTP_FAILURE", `${label} returned HTTP ${response?.status ?? "unknown"}`);
  const contentType = response.headers?.get?.("content-type") ?? "";
  stagingAssert(/^text\/html(?:;|$)/iu.test(contentType), "LOOPBACK_WEB_INVALID", `${label} did not return text/html`);
  return { status: response.status };
}

function assertReadyPayload(payload, label) {
  stagingAssert(payload?.ok === true && typeof payload.version === "string" && payload.version.length > 0, "LOOPBACK_INVALID_PAYLOAD", `${label} did not report ok=true with a version`);
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    stagingAssert(["--daemon-url", "--web-url", "--timeout-ms", "--poll-ms"].includes(token), "ARGUMENT_UNKNOWN", `unknown argument: ${token}`);
    const value = argv[index + 1];
    stagingAssert(typeof value === "string" && value.length > 0 && !value.startsWith("--"), "ARGUMENT_MISSING", `missing value for ${token}`);
    const key = token.slice(2).replaceAll("-", "_");
    stagingAssert(options[key] === undefined, "ARGUMENT_DUPLICATE", `duplicate argument: ${token}`);
    options[key] = value;
  }
  stagingAssert(options.daemon_url && options.web_url, "ARGUMENT_MISSING", "--daemon-url and --web-url are required");
  return options;
}

async function main(argv) {
  const options = parseArguments(argv);
  const timeoutMs = options.timeout_ms == null ? undefined : Number(options.timeout_ms);
  const pollMs = options.poll_ms == null ? undefined : Number(options.poll_ms);
  const result = await smokeLoopback({ daemonUrl: options.daemon_url, webUrl: options.web_url, timeoutMs, pollMs });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
