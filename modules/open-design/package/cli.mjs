#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildOpenDesignDevelopmentPackage } from "./open-design-package.mjs";

function parseArguments(argv) {
  const values = {};
  let developmentLocalOnly = false;
  const allowed = new Set(["staging-root", "node-bin", "node-license", "vela-platform-package-root", "vela-platform-tarball", "catalog-issued-at", "output"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--development-local-only") {
      if (developmentLocalOnly) throw new Error("ARGUMENT_DUPLICATE: duplicate --development-local-only");
      developmentLocalOnly = true;
      continue;
    }
    if (!token?.startsWith("--") || !allowed.has(token.slice(2))) throw new Error(`ARGUMENT_UNKNOWN: unknown argument: ${token}`);
    const name = token.slice(2);
    if (Object.hasOwn(values, name)) throw new Error(`ARGUMENT_DUPLICATE: duplicate argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`ARGUMENT_MISSING: missing value for ${token}`);
    values[name] = value;
    index += 1;
  }
  for (const name of allowed) if (!values[name]) throw new Error(`ARGUMENT_MISSING: required argument: --${name}`);
  return { values, developmentLocalOnly };
}

async function main(argv) {
  const options = parseArguments(argv);
  const result = await buildOpenDesignDevelopmentPackage({
    stagingRoot: options.values["staging-root"],
    nodeBin: options.values["node-bin"],
    nodeLicense: options.values["node-license"],
    velaPlatformPackageRoot: options.values["vela-platform-package-root"],
    velaPlatformTarball: options.values["vela-platform-tarball"],
    catalogIssuedAt: options.values["catalog-issued-at"],
    output: options.values.output,
    developmentLocalOnly: options.developmentLocalOnly,
    allowUnreviewedLocalArtifact: process.env.SIMULATOR_ALLOW_UNREVIEWED_LOCAL_ARTIFACT === "1",
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
