#!/usr/bin/env node

import { createPublicKey } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stagingAssert, stagingFail } from "../src/staging-error.mjs";
import {
  buildOpenDesignProductionPackage,
  dryRunOpenDesignCatalogRefresh,
  dryRunOpenDesignProductionPackage,
  refreshOpenDesignProductionCatalog,
  verifyOpenDesignProductionBundle,
} from "./production-package.mjs";

const BUILD_VALUE_OPTIONS = new Set([
  "staging-root",
  "node-bin",
  "node-license",
  "output",
  "release-tag",
  "catalog-sequence",
  "catalog-issued-at",
  "catalog-expires-at",
  "host-version-range",
  "key-id",
  "key-active-from",
  "key-active-until",
  "private-key-file",
  "private-key-env",
  "previous-sequence",
  "previous-issued-at",
  "verification-time",
]);
const VERIFY_VALUE_OPTIONS = new Set([
  "bundle-root",
  "release-tag",
  "key-id",
  "key-active-from",
  "key-active-until",
  "public-key-file",
  "previous-sequence",
  "previous-issued-at",
  "verification-time",
]);
const REFRESH_VALUE_OPTIONS = new Set([
  "bundle-root",
  "output",
  "release-tag",
  "catalog-sequence",
  "catalog-issued-at",
  "catalog-expires-at",
  "key-id",
  "key-active-from",
  "key-active-until",
  "private-key-file",
  "private-key-env",
  "previous-sequence",
  "previous-issued-at",
  "verification-time",
]);

export async function main(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseArguments(argv);
  if (parsed.mode === "verify") {
    const publicKey = await loadEd25519PublicKey(required(parsed.values, "public-key-file"));
    const result = await verifyOpenDesignProductionBundle({
      bundleRoot: required(parsed.values, "bundle-root"),
      releaseTag: required(parsed.values, "release-tag"),
      trustedKey: {
        keyId: required(parsed.values, "key-id"),
        publicKey,
        activeFrom: required(parsed.values, "key-active-from"),
        ...(parsed.values["key-active-until"] === undefined ? {} : { activeUntil: parsed.values["key-active-until"] }),
      },
      priorTrustState: previousTrustState(parsed.values),
      verificationTimeMs: integer(required(parsed.values, "verification-time"), "verification-time", 0),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }

  if (parsed.mode === "refresh") {
    const common = {
      bundleRoot: required(parsed.values, "bundle-root"),
      releaseTag: required(parsed.values, "release-tag"),
      catalogSequence: integer(required(parsed.values, "catalog-sequence"), "catalog-sequence", 1),
      catalogIssuedAt: required(parsed.values, "catalog-issued-at"),
      catalogExpiresAt: required(parsed.values, "catalog-expires-at"),
      keyId: required(parsed.values, "key-id"),
      keyActiveFrom: required(parsed.values, "key-active-from"),
      ...(parsed.values["key-active-until"] === undefined ? {} : { keyActiveUntil: parsed.values["key-active-until"] }),
      priorTrustState: requiredPreviousTrustState(parsed.values),
      ...(parsed.values["verification-time"] === undefined ? {} : { verificationTimeMs: integer(parsed.values["verification-time"], "verification-time", 0) }),
    };
    if (parsed.dryRun) {
      const result = await dryRunOpenDesignCatalogRefresh(common);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return result;
    }
    const result = await refreshOpenDesignProductionCatalog({
      ...common,
      output: required(parsed.values, "output"),
      ...(parsed.values["private-key-file"] === undefined ? {} : { privateKeyFile: parsed.values["private-key-file"] }),
      ...(parsed.values["private-key-env"] === undefined ? {} : { privateKeyEnvName: parsed.values["private-key-env"] }),
      env,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }

  const common = {
    stagingRoot: required(parsed.values, "staging-root"),
    nodeBin: required(parsed.values, "node-bin"),
    nodeLicense: required(parsed.values, "node-license"),
    releaseTag: required(parsed.values, "release-tag"),
    catalogSequence: integer(required(parsed.values, "catalog-sequence"), "catalog-sequence", 1),
    catalogIssuedAt: required(parsed.values, "catalog-issued-at"),
    catalogExpiresAt: required(parsed.values, "catalog-expires-at"),
    hostVersionRange: required(parsed.values, "host-version-range"),
    keyId: required(parsed.values, "key-id"),
    keyActiveFrom: required(parsed.values, "key-active-from"),
    ...(parsed.values["key-active-until"] === undefined ? {} : { keyActiveUntil: parsed.values["key-active-until"] }),
    priorTrustState: previousTrustState(parsed.values),
    ...(parsed.values["verification-time"] === undefined ? {} : { verificationTimeMs: integer(parsed.values["verification-time"], "verification-time", 0) }),
  };
  if (parsed.dryRun) {
    const result = await dryRunOpenDesignProductionPackage(common);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }

  const result = await buildOpenDesignProductionPackage({
    ...common,
    output: required(parsed.values, "output"),
    ...(parsed.values["private-key-file"] === undefined ? {} : { privateKeyFile: parsed.values["private-key-file"] }),
    ...(parsed.values["private-key-env"] === undefined ? {} : { privateKeyEnvName: parsed.values["private-key-env"] }),
    env,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

function parseArguments(argv) {
  stagingAssert(Array.isArray(argv), "PACKAGE_ARGUMENT_INVALID", "arguments must be an array");
  const operationFlags = argv.filter((token) => token === "--verify" || token === "--refresh");
  stagingAssert(operationFlags.length <= 1, "PACKAGE_ARGUMENT_INVALID", "select only one operation mode");
  const mode = operationFlags[0]?.slice(2) ?? "build";
  const dryRunFlags = argv.filter((token) => token === "--dry-run");
  stagingAssert(dryRunFlags.length <= 1, "PACKAGE_ARGUMENT_INVALID", "dry-run may be selected only once");
  const dryRun = dryRunFlags.length === 1;
  stagingAssert(!(mode === "verify" && dryRun), "PACKAGE_ARGUMENT_INVALID", "verify mode cannot be combined with dry-run");
  const allowed = mode === "verify" ? VERIFY_VALUE_OPTIONS : mode === "refresh" ? REFRESH_VALUE_OPTIONS : BUILD_VALUE_OPTIONS;
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    stagingAssert(typeof token === "string" && token.startsWith("--"), "PACKAGE_ARGUMENT_INVALID", "all arguments must use --name syntax");
    const name = token.slice(2);
    if (name === "dry-run" || name === "verify" || name === "refresh") {
      continue;
    }
    stagingAssert(allowed.has(name), "PACKAGE_ARGUMENT_INVALID", `unknown argument: --${name}`);
    stagingAssert(values[name] === undefined, "PACKAGE_ARGUMENT_INVALID", `duplicate argument: --${name}`);
    const value = argv[index + 1];
    stagingAssert(typeof value === "string" && !value.startsWith("--"), "PACKAGE_ARGUMENT_INVALID", `missing value for --${name}`);
    values[name] = value;
    index += 1;
  }
  if (dryRun) {
    stagingAssert(values.output === undefined && values["private-key-file"] === undefined && values["private-key-env"] === undefined, "PACKAGE_ARGUMENT_INVALID", "dry-run forbids output and private-key inputs");
  }
  return { mode, dryRun, values };
}

function previousTrustState(values) {
  if (values["previous-sequence"] === undefined && values["previous-issued-at"] === undefined) return undefined;
  return {
    highestSequence: integer(required(values, "previous-sequence"), "previous-sequence", 0),
    ...(values["previous-issued-at"] === undefined ? {} : { latestIssuedAt: values["previous-issued-at"] }),
  };
}

function requiredPreviousTrustState(values) {
  const state = previousTrustState(values);
  stagingAssert(state !== undefined && state.latestIssuedAt !== undefined, "PACKAGE_ARGUMENT_INVALID", "refresh requires --previous-sequence and --previous-issued-at");
  return state;
}

function required(values, name) {
  const value = values[name];
  stagingAssert(typeof value === "string" && value.length > 0, "PACKAGE_ARGUMENT_INVALID", `required argument is missing: --${name}`);
  return value;
}

function integer(value, name, minimum) {
  stagingAssert(/^(?:0|[1-9]\d*)$/u.test(value), "PACKAGE_ARGUMENT_INVALID", `--${name} must be a decimal integer`);
  const result = Number(value);
  stagingAssert(Number.isSafeInteger(result) && result >= minimum, "PACKAGE_ARGUMENT_INVALID", `--${name} is outside the supported range`);
  return result;
}

async function loadEd25519PublicKey(filename) {
  stagingAssert(path.isAbsolute(filename), "PACKAGE_VERIFY_INVALID", "public key file path must be absolute");
  const info = await lstat(filename).catch(() => stagingFail("PACKAGE_VERIFY_INVALID", "public key file cannot be opened"));
  stagingAssert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size > 0 && info.size <= 64 * 1024, "PACKAGE_VERIFY_INVALID", "public key file is invalid");
  let key;
  try {
    key = createPublicKey({ key: await readFile(filename), format: "pem" });
  } catch {
    stagingFail("PACKAGE_VERIFY_INVALID", "public key is not valid PEM");
  }
  stagingAssert(key.type === "public" && key.asymmetricKeyType === "ed25519", "PACKAGE_VERIFY_INVALID", "public key must be Ed25519");
  const jwk = key.export({ format: "jwk" });
  stagingAssert(jwk.kty === "OKP" && jwk.crv === "Ed25519" && typeof jwk.x === "string", "PACKAGE_VERIFY_INVALID", "public key must be Ed25519");
  return Uint8Array.from(Buffer.from(jwk.x, "base64url"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "PACKAGE_FAILED"}: ${error?.message ?? "production packaging failed"}\n`);
    process.exitCode = 1;
  });
}
