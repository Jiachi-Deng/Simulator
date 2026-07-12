/**
 * Cross-platform resources copy script
 */

import { existsSync, cpSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { areBuildUpdatesDisabled } from "./build-environment";

const ROOT_DIR = join(import.meta.dir, "..");
const ELECTRON_DIR = join(ROOT_DIR, "apps/electron");

const srcDir = join(ELECTRON_DIR, "resources");
const destDir = join(ELECTRON_DIR, "dist/resources");

if (existsSync(srcDir)) {
  cpSync(srcDir, destDir, { recursive: true, force: true });
  console.log("📦 Copied resources to dist");
} else {
  console.log("⚠️ No resources directory found");
}

mkdirSync(destDir, { recursive: true });
writeFileSync(
  join(destDir, "build-policy.json"),
  `${JSON.stringify({ schemaVersion: 1, updatesDisabled: areBuildUpdatesDisabled() }, null, 2)}\n`,
  { mode: 0o644 },
);
console.log("🔒 Wrote build policy marker");
