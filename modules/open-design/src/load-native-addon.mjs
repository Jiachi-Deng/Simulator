#!/usr/bin/env node

import { createRequire } from "node:module";
import path from "node:path";

const addonPath = process.argv[2];
if (typeof addonPath !== "string" || !path.isAbsolute(addonPath)) {
  console.error("absolute native addon path is required");
  process.exit(2);
}

try {
  createRequire(import.meta.url)(addonPath);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    nodeVersion: process.version,
    nodeAbi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
  })}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
