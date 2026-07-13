import assert from "node:assert/strict";
import test from "node:test";

import { assertLoopbackUrl, smokeLoopback } from "../src/smoke-loopback.mjs";

function response(body, { contentType = "application/json", status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? contentType : null },
    json: async () => body,
  };
}

test("accepts a loopback daemon and standalone web sidecar readiness contract", async () => {
  const calls = [];
  const request = async (url) => {
    calls.push(url.toString());
    if (url.pathname === "/") return response(null, { contentType: "text/html; charset=utf-8" });
    if (url.pathname === "/api/health") return response({ ok: true, version: "0.14.1" });
    return response({ ok: true, ready: true, version: "0.14.1" });
  };
  const result = await smokeLoopback({ daemonUrl: "http://127.0.0.1:7456", webUrl: "http://127.0.0.1:7457", request });
  assert.deepEqual(result, { ok: true, daemonVersion: "0.14.1", webStatus: 200 });
  assert.equal(calls.length, 4);
});

test("refuses non-loopback readiness targets before network I/O", () => {
  assert.throws(() => assertLoopbackUrl("http://example.com", "web"), { code: "SMOKE_NON_LOOPBACK_FORBIDDEN" });
  assert.throws(() => assertLoopbackUrl("https://127.0.0.1", "web"), { code: "SMOKE_ARGUMENT_INVALID" });
});
