#!/bin/bash
# Guard typed Electron transport boundaries. Raw sends are limited to wrappers
# that intentionally bridge legacy or isolated preload channels.
set -euo pipefail

if command -v rg >/dev/null 2>&1; then
  VIOLATIONS=$(rg 'webContents\.send\(' apps/electron/src/main/ \
    --glob '!**/window-manager.ts' \
    --glob '!**/browser-pane-manager.ts' \
    --glob '!**/module-view-manager.ts' \
    --glob '!**/menu.ts' \
    -l 2>/dev/null || true)
else
  VIOLATIONS=$(grep -R -l -E 'webContents\.send\(' apps/electron/src/main/ \
    --include='*.ts' \
    --include='*.tsx' \
    --exclude='window-manager.ts' \
    --exclude='browser-pane-manager.ts' \
    --exclude='module-view-manager.ts' \
    --exclude='menu.ts' 2>/dev/null || true)
fi

if [ -n "${VIOLATIONS:-}" ]; then
  echo "ERROR: Raw webContents.send() found outside approved wrappers:"
  echo "$VIOLATIONS"
  echo "Use RpcServer.push()/pushTyped() with explicit PushTarget routing."
  exit 1
fi

echo "OK: No raw webContents.send() outside approved wrappers."
