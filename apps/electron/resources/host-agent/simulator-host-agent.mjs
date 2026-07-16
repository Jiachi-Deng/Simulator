#!/usr/bin/env node

// src/shim.ts
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { lstat, readFile, realpath } from "node:fs/promises";

// ../host-agent-contract/src/constants.ts
var HOST_AGENT_CONTRACT_VERSION = 2;
var HOST_AGENT_SSE_EVENT = "host-agent.event";
var HOST_AGENT_HEADERS = Object.freeze({
  idempotencyKey: "Idempotency-Key",
  lastEventId: "Last-Event-ID"
});
var HOST_AGENT_ENV = Object.freeze({
  url: "SIMULATOR_HOST_AGENT_URL",
  tokenFile: "SIMULATOR_HOST_AGENT_TOKEN_FILE",
  shimPath: "SIMULATOR_HOST_AGENT_SHIM_PATH",
  contractVersion: "SIMULATOR_HOST_AGENT_CONTRACT_VERSION"
});
var HOST_AGENT_ENV_CONTRACT_VERSION = "2";
var HOST_AGENT_RUN_HANDLE_PATTERN = /^run_[0-9a-f]{32}$/;
function routeRunHandle(runHandle) {
  if (!HOST_AGENT_RUN_HANDLE_PATTERN.test(runHandle)) {
    throw new TypeError("Host Agent run handle must match run_[0-9a-f]{32}");
  }
  return runHandle;
}
var HOST_AGENT_ROUTES = Object.freeze({
  capabilities: "/v2/capabilities",
  runs: "/v2/runs",
  run: (runHandle) => `/v2/runs/${routeRunHandle(runHandle)}`,
  events: (runHandle) => `/v2/runs/${routeRunHandle(runHandle)}/events`,
  cancel: (runHandle) => `/v2/runs/${routeRunHandle(runHandle)}/cancel`
});
var MiB = 1024 * 1024;
var KiB = 1024;
var HOST_AGENT_LIMITS = Object.freeze({
  maxRequestBodyBytes: 2 * MiB,
  maxPromptBytes: 2 * MiB,
  maxWorkingDirectoryBytes: 4 * KiB,
  maxEventBytes: 256 * KiB,
  maxDeltaBytes: 64 * KiB,
  maxReplayEvents: 1024,
  maxReplayBytes: 8 * MiB,
  messagePortCreditBytes: 2 * MiB,
  terminalControlReserveBytes: 64 * KiB,
  maxSseSubscribersPerGrant: 2,
  maxSocketsPerGrant: 8,
  maxConcurrentHttpRequestsPerGrant: 4,
  maxConcurrentModuleRuns: 1,
  heartbeatIntervalMs: 1e4,
  maxRunDurationMs: 30 * 60000,
  workerHeapBytes: 64 * MiB,
  workerRssGateBytes: 128 * MiB,
  workerCrashWindowMs: 5 * 60000,
  maxWorkerCrashesPerWindow: 3,
  maxStartupP95Ms: 250,
  tombstoneMinRetentionMs: 24 * 60 * 60000,
  maxIdempotencyKeyBytes: 128,
  maxErrorMessageBytes: 1024,
  maxActivityLabelBytes: 4096
});
var HOST_AGENT_RUN_STATES = [
  "accepted",
  "starting",
  "running",
  "completed",
  "failed",
  "interrupted",
  "closing",
  "closed"
];
var HOST_AGENT_TERMINAL_RUN_STATES = ["completed", "failed", "interrupted"];
var HOST_AGENT_EVENT_TYPES = [
  "run.accepted",
  "turn.started",
  "message.delta",
  "reasoning.delta",
  "activity",
  "presentation.item",
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
  "run.closed"
];
var HOST_AGENT_PRESENTATION_KINDS = ["text", "image", "file", "preview"];
var HOST_AGENT_ACTIVITY_PHASES = ["started", "finished"];
var HOST_AGENT_ACTIVITY_KINDS = ["runtime", "tool"];
var HOST_AGENT_TURN_FAILURE_CODES = [
  "RUNTIME_UNAVAILABLE",
  "TOOL_BOUNDARY_UNAVAILABLE",
  "RUN_TIMEOUT",
  "BROKER_DISCONNECTED",
  "INTERNAL_ERROR"
];
var HOST_AGENT_INTERRUPTION_REASONS = [
  "CLIENT_CANCELLED",
  "CRAFT_TURN_PREEMPTED",
  "BROKER_DISCONNECTED",
  "RUN_TIMEOUT",
  "HOST_SHUTDOWN"
];
var HOST_AGENT_ERROR_CODES = [
  "INVALID_REQUEST",
  "INVALID_CONTRACT_VERSION",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "RUN_NOT_FOUND",
  "RUN_ACTIVE",
  "IDEMPOTENCY_CONFLICT",
  "REPLAY_UNAVAILABLE",
  "PAYLOAD_TOO_LARGE",
  "RATE_LIMITED",
  "CRAFT_TURN_ACTIVE",
  "RUNTIME_UNAVAILABLE",
  "TOOL_BOUNDARY_UNAVAILABLE",
  "BROKER_DISCONNECTED",
  "RUN_TIMEOUT",
  "CLEANUP_FAILED",
  "INTERNAL_ERROR"
];
var HOST_AGENT_ERROR_DEFINITIONS = Object.freeze({
  INVALID_REQUEST: { httpStatus: 400, retryable: false, message: "The request is invalid." },
  INVALID_CONTRACT_VERSION: { httpStatus: 400, retryable: false, message: "The contract version is not supported." },
  UNAUTHORIZED: { httpStatus: 401, retryable: false, message: "Authentication failed." },
  FORBIDDEN: { httpStatus: 403, retryable: false, message: "The operation is not permitted." },
  RUN_NOT_FOUND: { httpStatus: 404, retryable: false, message: "The run was not found." },
  RUN_ACTIVE: { httpStatus: 409, retryable: true, message: "A module run is already active." },
  IDEMPOTENCY_CONFLICT: { httpStatus: 409, retryable: false, message: "The idempotency key was already used for a different request." },
  REPLAY_UNAVAILABLE: { httpStatus: 409, retryable: false, message: "The requested event replay is no longer available." },
  PAYLOAD_TOO_LARGE: { httpStatus: 413, retryable: false, message: "The request payload is too large." },
  RATE_LIMITED: { httpStatus: 429, retryable: true, message: "The Host Agent capacity limit was reached." },
  CRAFT_TURN_ACTIVE: { httpStatus: 409, retryable: true, message: "A visible Craft turn has priority." },
  RUNTIME_UNAVAILABLE: { httpStatus: 503, retryable: true, message: "The Host runtime is unavailable." },
  TOOL_BOUNDARY_UNAVAILABLE: { httpStatus: 503, retryable: false, message: "The required tool boundary is unavailable." },
  BROKER_DISCONNECTED: { httpStatus: 503, retryable: true, message: "The Host Agent broker disconnected." },
  RUN_TIMEOUT: { httpStatus: 504, retryable: true, message: "The run exceeded its time limit." },
  CLEANUP_FAILED: { httpStatus: 500, retryable: false, message: "The run could not be safely closed." },
  INTERNAL_ERROR: { httpStatus: 500, retryable: false, message: "The Host Agent failed." }
});
var HOST_AGENT_RUN_TRANSITIONS = Object.freeze({
  accepted: Object.freeze(["starting", "interrupted"]),
  starting: Object.freeze(["running", "failed", "interrupted"]),
  running: Object.freeze(["completed", "failed", "interrupted"]),
  completed: Object.freeze(["closing"]),
  failed: Object.freeze(["closing"]),
  interrupted: Object.freeze(["closing"]),
  closing: Object.freeze(["closed"]),
  closed: Object.freeze([])
});
// ../host-agent-contract/src/validators.ts
class HostAgentContractValidationError extends TypeError {
  code;
  path;
  constructor(code, path, message) {
    super(`${path}: ${message}`);
    this.code = code;
    this.path = path;
    this.name = "HostAgentContractValidationError";
  }
}
var encoder = new TextEncoder;
var runStates = new Set(HOST_AGENT_RUN_STATES);
var terminalRunStates = new Set(HOST_AGENT_TERMINAL_RUN_STATES);
var eventTypes = new Set(HOST_AGENT_EVENT_TYPES);
var errorCodes = new Set(HOST_AGENT_ERROR_CODES);
var activityPhases = new Set(HOST_AGENT_ACTIVITY_PHASES);
var activityKinds = new Set(HOST_AGENT_ACTIVITY_KINDS);
var presentationKinds = new Set(HOST_AGENT_PRESENTATION_KINDS);
var turnFailureCodes = new Set(HOST_AGENT_TURN_FAILURE_CODES);
var interruptionReasons = new Set(HOST_AGENT_INTERRUPTION_REASONS);
var MAX_CLOSED_JSON_DEPTH = 64;
var MAX_CLOSED_JSON_NODES = 1e5;
function invalid(code, path, message) {
  throw new HostAgentContractValidationError(code, path, message);
}
function assertWellFormedUnicode(value, path = "$") {
  for (let index = 0;index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 55296 && unit <= 56319) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 56320 && next <= 57343)) {
        invalid("INVALID_VALUE", path, "string contains an unpaired UTF-16 surrogate");
      }
      index += 1;
    } else if (unit >= 56320 && unit <= 57343) {
      invalid("INVALID_VALUE", path, "string contains an unpaired UTF-16 surrogate");
    }
  }
}
function utf8ByteLength(value, path = "$") {
  assertWellFormedUnicode(value, path);
  return encoder.encode(value).byteLength;
}
function snapshotClosedJson(input, path, depth, context) {
  context.nodes += 1;
  if (context.nodes > MAX_CLOSED_JSON_NODES)
    invalid("LIMIT_EXCEEDED", path, "JSON value has too many nodes");
  if (depth > MAX_CLOSED_JSON_DEPTH)
    invalid("LIMIT_EXCEEDED", path, "JSON value is too deeply nested");
  if (input === null || typeof input === "boolean")
    return input;
  if (typeof input === "string") {
    assertWellFormedUnicode(input, path);
    return input;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input))
      invalid("NON_JSON_VALUE", path, "number must be finite");
    return input;
  }
  if (typeof input !== "object")
    invalid("NON_JSON_VALUE", path, "value must be closed JSON data");
  if (context.active.has(input))
    invalid("NON_JSON_VALUE", path, "cyclic JSON data is not allowed");
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(input);
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    invalid("NON_JSON_VALUE", path, "object could not be safely inspected");
  }
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) => typeof key !== "string")) {
    invalid("NON_JSON_VALUE", path, "symbol properties are not allowed");
  }
  context.active.add(input);
  try {
    if (Array.isArray(input)) {
      if (prototype !== Array.prototype)
        invalid("NON_JSON_VALUE", path, "array must use the built-in Array prototype");
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value") || lengthDescriptor.value !== input.length) {
        invalid("NON_JSON_VALUE", path, "array length descriptor is invalid");
      }
      const expectedKeys = new Set(["length", ...Array.from({ length: input.length }, (_, index) => String(index))]);
      if (ownKeys.some((key) => typeof key !== "string" || !expectedKeys.has(key)) || ownKeys.length !== expectedKeys.size) {
        invalid("NON_JSON_VALUE", path, "array must be dense and contain no extra properties");
      }
      const result2 = [];
      for (let index = 0;index < input.length; index += 1) {
        const descriptor = descriptors[index];
        if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.get || descriptor.set || !descriptor.enumerable) {
          invalid("NON_JSON_VALUE", `${path}[${index}]`, "array entries must be enumerable data properties");
        }
        result2.push(snapshotClosedJson(descriptor.value, `${path}[${index}]`, depth + 1, context));
      }
      return result2;
    }
    if (prototype !== Object.prototype && prototype !== null) {
      invalid("NON_JSON_VALUE", path, "object must use Object.prototype or a null prototype");
    }
    const result = Object.create(null);
    for (const key of ownKeys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.get || descriptor.set || !descriptor.enumerable) {
        invalid("NON_JSON_VALUE", `${path}.${key}`, "object fields must be enumerable data properties");
      }
      result[key] = snapshotClosedJson(descriptor.value, `${path}.${key}`, depth + 1, context);
    }
    return result;
  } finally {
    context.active.delete(input);
  }
}
function assertClosedJsonValue(input, path = "$") {
  snapshotClosedJson(input, path, 0, { active: new WeakSet, nodes: 0 });
}
function rootObject(input) {
  const value = snapshotClosedJson(input, "$", 0, { active: new WeakSet, nodes: 0 });
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    invalid("INVALID_TYPE", "$", "value must be an object");
  }
  return value;
}
function objectField(object, key, path) {
  const value = object[key];
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    invalid("INVALID_TYPE", path, "value must be an object");
  }
  return value;
}
function exactKeys(object, required, optional = [], path = "$") {
  const keys = Object.keys(object);
  const allowed = new Set([...required, ...optional]);
  const unknown = keys.find((key) => !allowed.has(key));
  if (unknown)
    invalid("UNKNOWN_FIELD", `${path}.${unknown}`, "unknown field");
  const missing = required.find((key) => !Object.hasOwn(object, key));
  if (missing)
    invalid("MISSING_FIELD", `${path}.${missing}`, "required field is missing");
}
function stringField(object, key, path = `$.${key}`) {
  const value = object[key];
  if (typeof value !== "string")
    invalid("INVALID_TYPE", path, "value must be a string");
  return value;
}
function booleanField(object, key, path = `$.${key}`) {
  const value = object[key];
  if (typeof value !== "boolean")
    invalid("INVALID_TYPE", path, "value must be a boolean");
  return value;
}
function safeIntegerField(object, key, path = `$.${key}`) {
  const value = object[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalid("INVALID_TYPE", path, "value must be a non-negative safe integer");
  }
  return value;
}
function positiveIntegerField(object, key, path = `$.${key}`) {
  const value = safeIntegerField(object, key, path);
  if (value === 0)
    invalid("INVALID_VALUE", path, "value must be positive");
  return value;
}
function parseVersion(object) {
  const version = safeIntegerField(object, "contractVersion");
  if (version !== HOST_AGENT_CONTRACT_VERSION) {
    invalid("INVALID_VALUE", "$.contractVersion", `value must be ${HOST_AGENT_CONTRACT_VERSION}`);
  }
}
function boundedString(value, path, options) {
  const bytes = utf8ByteLength(value, path);
  if (bytes < (options.minBytes ?? 0))
    invalid("INVALID_VALUE", path, "string is too short");
  if (bytes > options.maxBytes)
    invalid("LIMIT_EXCEEDED", path, `string exceeds ${options.maxBytes} UTF-8 bytes`);
  if (options.rejectNul && value.includes("\x00"))
    invalid("INVALID_VALUE", path, "NUL is not allowed");
  if (options.rejectControls && /[\u0000-\u001f\u007f]/u.test(value)) {
    invalid("INVALID_VALUE", path, "control characters are not allowed");
  }
  return value;
}
function parseRunHandle(input) {
  if (typeof input !== "string" || !HOST_AGENT_RUN_HANDLE_PATTERN.test(input)) {
    invalid("INVALID_VALUE", "$", "run handle must match run_[0-9a-f]{32}");
  }
  return input;
}
function parseOpaqueId(input, path) {
  if (typeof input !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input)) {
    invalid("INVALID_VALUE", path, "identifier must be a canonical route-safe ID");
  }
  return input;
}
function isHostAgentRunState(input) {
  return typeof input === "string" && runStates.has(input);
}
function isHostAgentTerminalRunState(input) {
  return typeof input === "string" && terminalRunStates.has(input);
}
function parseHostAgentRunSnapshot(input) {
  const object = rootObject(input);
  exactKeys(object, ["contractVersion", "runHandle", "state", "createdAt", "updatedAt"], ["terminalAt", "closedAt"]);
  parseVersion(object);
  const runHandle = parseRunHandle(stringField(object, "runHandle"));
  const stateValue = stringField(object, "state");
  if (!isHostAgentRunState(stateValue))
    invalid("INVALID_VALUE", "$.state", "unknown run state");
  const state = stateValue;
  const createdAt = safeIntegerField(object, "createdAt");
  const updatedAt = safeIntegerField(object, "updatedAt");
  if (updatedAt < createdAt)
    invalid("INVALID_VALUE", "$.updatedAt", "updatedAt must not precede createdAt");
  const hasTerminalAt = Object.hasOwn(object, "terminalAt");
  const hasClosedAt = Object.hasOwn(object, "closedAt");
  const requiresTerminal = isHostAgentTerminalRunState(state) || state === "closing" || state === "closed";
  if (requiresTerminal !== hasTerminalAt) {
    invalid("INVALID_VALUE", "$.terminalAt", requiresTerminal ? "terminalAt is required for this state" : "terminalAt is forbidden for this state");
  }
  if (state === "closed" !== hasClosedAt) {
    invalid("INVALID_VALUE", "$.closedAt", state === "closed" ? "closedAt is required for closed state" : "closedAt is forbidden before closed state");
  }
  const terminalAt = hasTerminalAt ? safeIntegerField(object, "terminalAt") : undefined;
  const closedAt = hasClosedAt ? safeIntegerField(object, "closedAt") : undefined;
  if (terminalAt !== undefined && (terminalAt < createdAt || updatedAt < terminalAt)) {
    invalid("INVALID_VALUE", "$.terminalAt", "terminalAt must be within the run timestamp range");
  }
  if (closedAt !== undefined && (terminalAt === undefined || closedAt < terminalAt || updatedAt < closedAt)) {
    invalid("INVALID_VALUE", "$.closedAt", "closedAt must follow terminalAt and not exceed updatedAt");
  }
  return {
    contractVersion: HOST_AGENT_CONTRACT_VERSION,
    runHandle,
    state,
    createdAt,
    updatedAt,
    ...terminalAt === undefined ? {} : { terminalAt },
    ...closedAt === undefined ? {} : { closedAt }
  };
}
function parseEventBase(object) {
  exactKeys(object, ["contractVersion", "eventId", "sequence", "runHandle", "occurredAt", "type", "data"]);
  parseVersion(object);
  const eventId = stringField(object, "eventId");
  const sequence = positiveIntegerField(object, "sequence");
  if (eventId !== String(sequence))
    invalid("INVALID_VALUE", "$.eventId", "eventId must be the canonical decimal sequence");
  const type = stringField(object, "type");
  if (!eventTypes.has(type))
    invalid("INVALID_VALUE", "$.type", "unknown event type");
  return {
    eventId,
    sequence,
    runHandle: parseRunHandle(stringField(object, "runHandle")),
    occurredAt: safeIntegerField(object, "occurredAt"),
    type,
    data: objectField(object, "data", "$.data")
  };
}
function parseDelta(data) {
  exactKeys(data, ["delta"], [], "$.data");
  const delta = boundedString(stringField(data, "delta", "$.data.delta"), "$.data.delta", {
    minBytes: 1,
    maxBytes: HOST_AGENT_LIMITS.maxDeltaBytes,
    rejectNul: true
  });
  return { delta };
}
var failureRetryability = {
  RUNTIME_UNAVAILABLE: true,
  TOOL_BOUNDARY_UNAVAILABLE: false,
  RUN_TIMEOUT: true,
  BROKER_DISCONNECTED: true,
  INTERNAL_ERROR: false
};
var interruptionRetryability = {
  CLIENT_CANCELLED: false,
  CRAFT_TURN_PREEMPTED: true,
  BROKER_DISCONNECTED: true,
  RUN_TIMEOUT: true,
  HOST_SHUTDOWN: true
};
function parseHostAgentEvent(input) {
  const object = rootObject(input);
  const base = parseEventBase(object);
  const common = {
    contractVersion: HOST_AGENT_CONTRACT_VERSION,
    eventId: base.eventId,
    sequence: base.sequence,
    runHandle: base.runHandle,
    occurredAt: base.occurredAt
  };
  let event;
  switch (base.type) {
    case "run.accepted":
    case "turn.started":
    case "run.closed": {
      exactKeys(base.data, [], [], "$.data");
      event = { ...common, type: base.type, data: {} };
      break;
    }
    case "message.delta":
    case "reasoning.delta":
      event = { ...common, type: base.type, data: parseDelta(base.data) };
      break;
    case "activity": {
      exactKeys(base.data, ["phase", "kind"], ["label"], "$.data");
      const phase = stringField(base.data, "phase", "$.data.phase");
      const kind = stringField(base.data, "kind", "$.data.kind");
      if (!activityPhases.has(phase))
        invalid("INVALID_VALUE", "$.data.phase", "unknown activity phase");
      if (!activityKinds.has(kind))
        invalid("INVALID_VALUE", "$.data.kind", "unknown activity kind");
      const label = Object.hasOwn(base.data, "label") ? boundedString(stringField(base.data, "label", "$.data.label"), "$.data.label", {
        minBytes: 1,
        maxBytes: HOST_AGENT_LIMITS.maxActivityLabelBytes,
        rejectNul: true
      }) : undefined;
      event = {
        ...common,
        type: "activity",
        data: { phase, kind, ...label === undefined ? {} : { label } }
      };
      break;
    }
    case "presentation.item": {
      exactKeys(base.data, ["itemId", "kind"], ["title", "text", "uri", "mediaType"], "$.data");
      const itemId = parseOpaqueId(base.data.itemId, "$.data.itemId");
      const kind = stringField(base.data, "kind", "$.data.kind");
      if (!presentationKinds.has(kind))
        invalid("INVALID_VALUE", "$.data.kind", "unknown presentation kind");
      const optionalText = (key, maxBytes) => Object.hasOwn(base.data, key) ? boundedString(stringField(base.data, key, `$.data.${key}`), `$.data.${key}`, { minBytes: 1, maxBytes, rejectNul: true }) : undefined;
      const title = optionalText("title", 4096);
      const text = optionalText("text", HOST_AGENT_LIMITS.maxEventBytes);
      const uri = optionalText("uri", 8192);
      const mediaType = Object.hasOwn(base.data, "mediaType") ? boundedString(stringField(base.data, "mediaType", "$.data.mediaType"), "$.data.mediaType", { minBytes: 1, maxBytes: 256, rejectControls: true }) : undefined;
      if (mediaType !== undefined && !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mediaType)) {
        invalid("INVALID_VALUE", "$.data.mediaType", "mediaType must be a canonical media type");
      }
      event = {
        ...common,
        type: "presentation.item",
        data: {
          itemId,
          kind,
          ...title === undefined ? {} : { title },
          ...text === undefined ? {} : { text },
          ...uri === undefined ? {} : { uri },
          ...mediaType === undefined ? {} : { mediaType }
        }
      };
      break;
    }
    case "turn.completed": {
      exactKeys(base.data, [], ["finalText"], "$.data");
      const finalText = Object.hasOwn(base.data, "finalText") ? boundedString(stringField(base.data, "finalText", "$.data.finalText"), "$.data.finalText", {
        maxBytes: HOST_AGENT_LIMITS.maxEventBytes,
        rejectNul: true
      }) : undefined;
      event = { ...common, type: "turn.completed", data: finalText === undefined ? {} : { finalText } };
      break;
    }
    case "turn.failed": {
      exactKeys(base.data, ["code", "retryable"], [], "$.data");
      const code = stringField(base.data, "code", "$.data.code");
      if (!turnFailureCodes.has(code))
        invalid("INVALID_VALUE", "$.data.code", "unknown turn failure code");
      const retryable = booleanField(base.data, "retryable", "$.data.retryable");
      if (retryable !== failureRetryability[code]) {
        invalid("INVALID_VALUE", "$.data.retryable", "retryable does not match the public failure code");
      }
      event = { ...common, type: "turn.failed", data: { code, retryable } };
      break;
    }
    case "turn.interrupted": {
      exactKeys(base.data, ["reason", "retryable"], [], "$.data");
      const reason = stringField(base.data, "reason", "$.data.reason");
      if (!interruptionReasons.has(reason))
        invalid("INVALID_VALUE", "$.data.reason", "unknown interruption reason");
      const retryable = booleanField(base.data, "retryable", "$.data.retryable");
      if (retryable !== interruptionRetryability[reason]) {
        invalid("INVALID_VALUE", "$.data.retryable", "retryable does not match the interruption reason");
      }
      event = { ...common, type: "turn.interrupted", data: { reason, retryable } };
      break;
    }
    default:
      invalid("INVALID_VALUE", "$.type", "unknown event type");
  }
  if (encoder.encode(JSON.stringify(event)).byteLength > HOST_AGENT_LIMITS.maxEventBytes) {
    invalid("LIMIT_EXCEEDED", "$", `encoded event exceeds ${HOST_AGENT_LIMITS.maxEventBytes} UTF-8 bytes`);
  }
  return event;
}
function parseHostAgentErrorResponse(input) {
  const object = rootObject(input);
  exactKeys(object, ["contractVersion", "error"]);
  parseVersion(object);
  const error = objectField(object, "error", "$.error");
  exactKeys(error, ["code", "message", "retryable"], [], "$.error");
  const code = stringField(error, "code", "$.error.code");
  if (!errorCodes.has(code))
    invalid("INVALID_VALUE", "$.error.code", "unknown public error code");
  const definition = HOST_AGENT_ERROR_DEFINITIONS[code];
  const message = boundedString(stringField(error, "message", "$.error.message"), "$.error.message", {
    minBytes: 1,
    maxBytes: HOST_AGENT_LIMITS.maxErrorMessageBytes,
    rejectControls: true
  });
  const retryable = booleanField(error, "retryable", "$.error.retryable");
  if (message !== definition.message || retryable !== definition.retryable) {
    invalid("INVALID_VALUE", "$.error", "message and retryable must match the fixed public error definition");
  }
  return {
    contractVersion: HOST_AGENT_CONTRACT_VERSION,
    error: { code, message, retryable }
  };
}

// ../host-agent-contract/src/canonical.ts
var encoder2 = new TextEncoder;
// ../host-agent-contract/src/node.ts
var decoder = new TextDecoder("utf-8", { fatal: true });
var encoder3 = new TextEncoder;
function bytesView(input, path = "$") {
  if (!(input instanceof Uint8Array)) {
    throw new HostAgentContractValidationError("INVALID_TYPE", path, "value must be a Uint8Array");
  }
  return input;
}
function decodeHostAgentUtf8Strict(input, maxBytes) {
  const bytes = bytesView(input);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("maxBytes must be a non-negative safe integer");
  }
  if (bytes.byteLength > maxBytes) {
    throw new HostAgentContractValidationError("LIMIT_EXCEEDED", "$", `input exceeds ${maxBytes} bytes`);
  }
  if (bytes.byteLength >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) {
    throw new HostAgentContractValidationError("INVALID_VALUE", "$", "a UTF-8 BOM is not allowed");
  }
  try {
    return decoder.decode(bytes);
  } catch {
    throw new HostAgentContractValidationError("INVALID_VALUE", "$", "input is not valid UTF-8");
  }
}
function parseHostAgentJsonBytes(input, maxBytes) {
  const text = decodeHostAgentUtf8Strict(input, maxBytes);
  if (text.length === 0) {
    throw new HostAgentContractValidationError("INVALID_VALUE", "$", "JSON input must not be empty");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HostAgentContractValidationError("INVALID_VALUE", "$", "input is not valid JSON");
  }
  assertClosedJsonValue(value);
  return value;
}

// src/shim.ts
var REQUEST_TIMEOUT_MS = 1e4;
var CLEANUP_TIMEOUT_MS = 5000;
var TERMINAL_CLOSE_TIMEOUT_MS = 15000;
var MAX_CREATE_ATTEMPTS = 3;
var MAX_SSE_RECONNECTS = 3;
var MAX_HTTP_RESPONSE_BYTES = 512 * 1024;
var MAX_SSE_FRAME_BYTES = HOST_AGENT_LIMITS.maxEventBytes + 1024;

class ShimError extends Error {
  publicCode;
  constructor(publicCode) {
    super(publicCode);
    this.publicCode = publicCode;
    this.name = "ShimError";
  }
}

class HttpShimError extends ShimError {
  retryable;
  constructor(publicCode, retryable) {
    super(publicCode);
    this.retryable = retryable;
    this.name = "HttpShimError";
  }
}
async function runHostAgentShim(options) {
  if (options.argv.length === 1 && options.argv[0] === "--version") {
    await write(options.stdout, `simulator-host-agent ${HOST_AGENT_CONTRACT_VERSION}
`);
    return 0;
  }
  if (options.argv.length !== 0) {
    diagnostic(options.stderr, "INVALID_ARGUMENTS");
    return 2;
  }
  let runHandle;
  let terminal = false;
  let closed = false;
  let terminalType;
  let terminalEvent;
  let closedEvent;
  let environment;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  try {
    environment = await validateEnvironment(options);
    const prompt = await readPrompt(options.stdin, options.signal);
    const body = JSON.stringify({
      contractVersion: HOST_AGENT_CONTRACT_VERSION,
      prompt,
      workingDirectory: options.cwd
    });
    if (Buffer.byteLength(body, "utf8") > HOST_AGENT_LIMITS.maxRequestBodyBytes) {
      throw new ShimError("PAYLOAD_TOO_LARGE");
    }
    const idempotencyKey = `shim-${randomBytes(24).toString("hex")}`;
    const created = await createRunWithRecovery(fetchImpl, environment, body, idempotencyKey, options.signal);
    runHandle = created.runHandle;
    const state = {
      runHandle,
      nextSequence: 1,
      phase: "awaiting-accepted"
    };
    let closePromise;
    let terminalFailure;
    let rejectTerminalFailure;
    const terminalFailurePromise = new Promise((_resolve, reject) => {
      rejectTerminalFailure = reject;
    });
    let terminalCloseTimer;
    const streamController = new AbortController;
    const streamSignal = AbortSignal.any([options.signal, streamController.signal]);
    let reconnects = 0;
    const failTerminalCleanup = () => {
      if (terminalFailure)
        return;
      terminalFailure = new ShimError("CLEANUP_FAILED");
      rejectTerminalFailure(terminalFailure);
      streamController.abort(terminalFailure);
    };
    try {
      while (!closed) {
        try {
          await Promise.race([consumeEventStream({
            fetchImpl,
            environment,
            state,
            signal: streamSignal,
            onEvent: async (event) => {
              validateEventTransition(state, event);
              if (isTerminal(event)) {
                terminal = true;
                terminalType = event.type;
                terminalEvent = event;
                const closeTimeoutMs = validatedTerminalCloseTimeout(options.terminalCloseTimeoutMs);
                const closeController = new AbortController;
                const closeSignal = AbortSignal.any([options.signal, closeController.signal]);
                terminalCloseTimer = setTimeout(() => {
                  failTerminalCleanup();
                  closeController.abort(terminalFailure);
                }, closeTimeoutMs);
                closePromise ??= closeRun(fetchImpl, environment, runHandle, closeSignal);
                closePromise.then((snapshot) => {
                  if (snapshot.runHandle !== runHandle || snapshot.state !== "closed") {
                    failTerminalCleanup();
                  }
                }, () => {
                  failTerminalCleanup();
                });
              } else if (event.type === "run.closed") {
                closed = true;
                closedEvent = event;
              } else {
                await write(options.stdout, `${JSON.stringify(event)}
`);
              }
            }
          }), terminalFailurePromise]);
          if (!closed)
            throw new ShimError("BROKER_DISCONNECTED");
        } catch (error) {
          if (terminalFailure)
            throw terminalFailure;
          if (options.signal.aborted)
            throw error;
          if (error instanceof HttpShimError && error.publicCode === "REPLAY_UNAVAILABLE")
            throw error;
          if (closed || reconnects >= MAX_SSE_RECONNECTS)
            throw error;
          reconnects += 1;
          await delay(50 * reconnects, options.signal);
        }
      }
    } finally {
      if (terminalCloseTimer)
        clearTimeout(terminalCloseTimer);
    }
    if (!terminal || !terminalType || !terminalEvent || !closedEvent || !closePromise) {
      throw new ShimError("INVALID_EVENT_ORDER");
    }
    const closeSnapshot = await closePromise.catch(() => {
      throw new ShimError("CLEANUP_FAILED");
    });
    if (closeSnapshot.runHandle !== runHandle || closeSnapshot.state !== "closed") {
      throw new ShimError("CLEANUP_FAILED");
    }
    await write(options.stdout, `${JSON.stringify(terminalEvent)}
`);
    await write(options.stdout, `${JSON.stringify(closedEvent)}
`);
    return terminalType === "turn.completed" ? 0 : terminalType === "turn.interrupted" ? 2 : 1;
  } catch (error) {
    if (environment && runHandle && !closed && !terminal) {
      await bestEffortCancelAndClose(fetchImpl, environment, runHandle);
    }
    diagnostic(options.stderr, options.signal.aborted ? "CANCELLED" : publicDiagnostic(error));
    return options.signal.aborted ? 143 : 1;
  }
}
function validatedTerminalCloseTimeout(value) {
  if (value === undefined)
    return TERMINAL_CLOSE_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 10 || value > TERMINAL_CLOSE_TIMEOUT_MS) {
    throw new TypeError("terminalCloseTimeoutMs must be an integer within the closed test range");
  }
  return value;
}
async function validateEnvironment(options) {
  if (options.env.SIMULATOR_HOST_AGENT_CONTRACT_VERSION !== HOST_AGENT_ENV_CONTRACT_VERSION) {
    throw new ShimError("INVALID_CONTRACT_VERSION");
  }
  const rawUrl = requiredEnvironment(options.env, "SIMULATOR_HOST_AGENT_URL");
  const tokenPath = requiredEnvironment(options.env, "SIMULATOR_HOST_AGENT_TOKEN_FILE");
  const shimPath = requiredEnvironment(options.env, "SIMULATOR_HOST_AGENT_SHIM_PATH");
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !url.port) {
    throw new ShimError("INVALID_HOST_URL");
  }
  const [actualEntry, expectedEntry] = await Promise.all([
    realpath(options.entryPath),
    realpath(shimPath)
  ]);
  const left = Buffer.from(actualEntry);
  const right = Buffer.from(expectedEntry);
  if (left.byteLength !== right.byteLength || !timingSafeEqual(left, right)) {
    throw new ShimError("INVALID_SHIM_PATH");
  }
  const shimStat = await lstat(expectedEntry);
  if (!shimStat.isFile() || shimStat.isSymbolicLink())
    throw new ShimError("INVALID_SHIM_PATH");
  if (!tokenPath.startsWith("/"))
    throw new ShimError("INVALID_TOKEN_FILE");
  const tokenStat = await lstat(tokenPath);
  if (!tokenStat.isFile() || tokenStat.isSymbolicLink())
    throw new ShimError("INVALID_TOKEN_FILE");
  if (typeof process.getuid === "function" && tokenStat.uid !== process.getuid()) {
    throw new ShimError("INVALID_TOKEN_FILE");
  }
  if (process.platform !== "win32" && (tokenStat.mode & 63) !== 0) {
    throw new ShimError("INVALID_TOKEN_FILE");
  }
  const tokenBytes = await readFile(tokenPath);
  if (tokenBytes.byteLength < 16 || tokenBytes.byteLength > 513)
    throw new ShimError("INVALID_TOKEN_FILE");
  const token = new TextDecoder("utf-8", { fatal: true }).decode(tokenBytes).replace(/\n$/u, "");
  if (Buffer.byteLength(token, "utf8") < 16 || Buffer.byteLength(token, "utf8") > 512 || /[\u0000-\u0020\u007f]/u.test(token)) {
    throw new ShimError("INVALID_TOKEN_FILE");
  }
  return { baseUrl: url.origin, token };
}
function requiredEnvironment(env, key) {
  const value = env[key];
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 4096) {
    throw new ShimError("INVALID_ENVIRONMENT");
  }
  return value;
}
async function readPrompt(stream, signal) {
  const chunks = [];
  let bytes = 0;
  for await (const raw of stream) {
    if (signal.aborted)
      throw new ShimError("CANCELLED");
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > HOST_AGENT_LIMITS.maxPromptBytes)
      throw new ShimError("PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  if (signal.aborted)
    throw new ShimError("CANCELLED");
  const input = Buffer.concat(chunks, bytes);
  if (input.byteLength === 0)
    throw new ShimError("INVALID_PROMPT");
  if (input[0] === 239 && input[1] === 187 && input[2] === 191)
    throw new ShimError("INVALID_PROMPT");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw new ShimError("INVALID_PROMPT");
  }
}
async function createRunWithRecovery(fetchImpl, environment, body, idempotencyKey, signal) {
  let lastError;
  for (let attempt = 1;attempt <= MAX_CREATE_ATTEMPTS; attempt += 1) {
    try {
      return await requestSnapshot(fetchImpl, environment, "/v2/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Idempotency-Key": idempotencyKey
        },
        body,
        signal
      });
    } catch (error) {
      lastError = error;
      if (signal.aborted || error instanceof HttpShimError && !error.retryable)
        throw error;
      if (attempt < MAX_CREATE_ATTEMPTS)
        await delay(50 * attempt, signal);
    }
  }
  throw lastError ?? new ShimError("RUNTIME_UNAVAILABLE");
}
async function consumeEventStream(input) {
  const headers = authorizationHeaders(input.environment);
  if (input.state.lastEventId !== undefined)
    headers["last-event-id"] = input.state.lastEventId;
  const response = await fetchWithTimeout(input.fetchImpl, `${input.environment.baseUrl}/v2/runs/${input.state.runHandle}/events`, {
    method: "GET",
    headers,
    signal: input.signal
  }, REQUEST_TIMEOUT_MS, false);
  if (!response.ok)
    throw await responseError(response);
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
    throw new ShimError("INVALID_EVENT_STREAM");
  }
  if (!response.body)
    throw new ShimError("BROKER_DISCONNECTED");
  const reader = response.body.getReader();
  const decoder2 = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  try {
    while (true) {
      const { value, done } = await readStreamChunk(reader, input.signal);
      if (done)
        break;
      try {
        buffered += decoder2.decode(value, { stream: true });
      } catch {
        throw new ShimError("INVALID_EVENT_STREAM");
      }
      if (Buffer.byteLength(buffered, "utf8") > MAX_SSE_FRAME_BYTES)
        throw new ShimError("INVALID_EVENT_STREAM");
      let boundary;
      while ((boundary = buffered.indexOf(`

`)) >= 0) {
        const frame = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        if (frame.startsWith(":"))
          continue;
        const event = parseSseFrame(frame);
        await input.onEvent(event);
      }
    }
    try {
      buffered += decoder2.decode();
    } catch {
      throw new ShimError("INVALID_EVENT_STREAM");
    }
    if (buffered.length !== 0)
      throw new ShimError("BROKER_DISCONNECTED");
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}
async function readStreamChunk(reader, signal) {
  if (signal.aborted)
    throw abortReason(signal);
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result) => {
      if (settled)
        return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve(result);
    };
    const fail = (error) => {
      if (settled)
        return;
      settled = true;
      signal.removeEventListener("abort", abort);
      reject(error);
    };
    const abort = () => {
      reader.cancel(signal.reason).catch(() => {
        return;
      });
      fail(abortReason(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then(finish, fail);
  });
}
function abortReason(signal) {
  return signal.reason instanceof Error ? signal.reason : new ShimError("CANCELLED");
}
function parseSseFrame(frame) {
  if (Buffer.byteLength(frame, "utf8") > MAX_SSE_FRAME_BYTES || frame.includes("\r")) {
    throw new ShimError("INVALID_EVENT_STREAM");
  }
  const fields = new Map;
  for (const line of frame.split(`
`)) {
    const separator = line.indexOf(":");
    if (separator < 1)
      throw new ShimError("INVALID_EVENT_STREAM");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).replace(/^ /u, "");
    if (!["id", "event", "data"].includes(key) || fields.has(key))
      throw new ShimError("INVALID_EVENT_STREAM");
    fields.set(key, value);
  }
  if (fields.get("event") !== HOST_AGENT_SSE_EVENT || !fields.has("id") || !fields.has("data")) {
    throw new ShimError("INVALID_EVENT_STREAM");
  }
  const raw = Buffer.from(fields.get("data"), "utf8");
  const event = parseHostAgentEvent(parseHostAgentJsonBytes(raw, HOST_AGENT_LIMITS.maxEventBytes));
  if (event.eventId !== fields.get("id"))
    throw new ShimError("INVALID_EVENT_STREAM");
  return event;
}
function validateEventTransition(state, event) {
  if (event.runHandle !== state.runHandle || event.sequence !== state.nextSequence || event.eventId !== String(event.sequence)) {
    throw new ShimError("INVALID_EVENT_ORDER");
  }
  switch (state.phase) {
    case "awaiting-accepted":
      if (event.type !== "run.accepted")
        throw new ShimError("INVALID_EVENT_ORDER");
      state.phase = "awaiting-started";
      break;
    case "awaiting-started":
      if (event.type !== "turn.started")
        throw new ShimError("INVALID_EVENT_ORDER");
      state.phase = "streaming";
      break;
    case "streaming":
      if (event.type === "run.accepted" || event.type === "turn.started" || event.type === "run.closed") {
        throw new ShimError("INVALID_EVENT_ORDER");
      }
      if (isTerminal(event)) {
        state.terminalType = event.type;
        state.phase = "terminal";
      }
      break;
    case "terminal":
      if (event.type !== "run.closed")
        throw new ShimError("INVALID_EVENT_ORDER");
      state.phase = "closed";
      break;
    case "closed":
      throw new ShimError("INVALID_EVENT_ORDER");
  }
  state.lastEventId = event.eventId;
  state.nextSequence += 1;
}
function isTerminal(event) {
  return event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.interrupted";
}
async function closeRun(fetchImpl, environment, runHandle, signal) {
  return requestSnapshot(fetchImpl, environment, `/v2/runs/${runHandle}`, {
    method: "DELETE",
    headers: {},
    signal
  });
}
async function bestEffortCancelAndClose(fetchImpl, environment, runHandle) {
  const timeout = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
  try {
    await requestSnapshot(fetchImpl, environment, `/v2/runs/${runHandle}/cancel`, {
      method: "POST",
      headers: {},
      signal: timeout
    });
  } catch {}
  try {
    await requestSnapshot(fetchImpl, environment, `/v2/runs/${runHandle}`, {
      method: "DELETE",
      headers: {},
      signal: timeout
    });
  } catch {}
}
async function requestSnapshot(fetchImpl, environment, path, init) {
  const response = await fetchWithTimeout(fetchImpl, `${environment.baseUrl}${path}`, {
    ...init,
    headers: { ...authorizationHeaders(environment), ...init.headers ?? {} }
  }, REQUEST_TIMEOUT_MS);
  const bytes = await readResponseBytes(response, MAX_HTTP_RESPONSE_BYTES);
  if (!response.ok)
    throw parseResponseError(bytes);
  return parseHostAgentRunSnapshot(parseHostAgentJsonBytes(bytes, MAX_HTTP_RESPONSE_BYTES));
}
async function responseError(response) {
  return parseResponseError(await readResponseBytes(response, MAX_HTTP_RESPONSE_BYTES));
}
function parseResponseError(bytes) {
  try {
    const parsed = parseHostAgentErrorResponse(parseHostAgentJsonBytes(bytes, MAX_HTTP_RESPONSE_BYTES));
    return new HttpShimError(parsed.error.code, parsed.error.retryable);
  } catch {
    return new HttpShimError("INVALID_HOST_RESPONSE", false);
  }
}
async function readResponseBytes(response, maxBytes) {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maxBytes)
    throw new ShimError("INVALID_HOST_RESPONSE");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes)
    throw new ShimError("INVALID_HOST_RESPONSE");
  return bytes;
}
function authorizationHeaders(environment) {
  return { Authorization: `Bearer ${environment.token}` };
}
async function fetchWithTimeout(fetchImpl, url, init, timeoutMs, applyTimeout = true) {
  const signal = applyTimeout ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : init.signal;
  return fetchImpl(url, { ...init, signal });
}
async function write(stream, value) {
  if (stream.write(value))
    return;
  await once(stream, "drain");
}
function diagnostic(stream, code) {
  const safe = /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "INTERNAL_ERROR";
  stream.write(`[simulator-host-agent] ${safe}
`);
}
function publicDiagnostic(error) {
  return error instanceof ShimError ? error.publicCode : "RUNTIME_UNAVAILABLE";
}
async function delay(ms, signal) {
  if (signal.aborted)
    throw new ShimError("CANCELLED");
  await new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new ShimError("CANCELLED"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

// src/main.ts
var controller = new AbortController;
var abort = () => controller.abort();
process.once("SIGTERM", abort);
process.once("SIGINT", abort);
try {
  process.exitCode = await runHostAgentShim({
    argv: process.argv.slice(2),
    entryPath: process.argv[1] ?? "",
    cwd: process.cwd(),
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    signal: controller.signal
  });
} catch {
  process.stderr.write(`[simulator-host-agent] INTERNAL_ERROR
`);
  process.exitCode = controller.signal.aborted ? 143 : 1;
} finally {
  process.off("SIGTERM", abort);
  process.off("SIGINT", abort);
}
