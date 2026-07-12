#!/bin/bash
# Claude renamed the parent subagent tool from Task to Agent. Production code
# must use isParentTaskTool() so either protocol spelling remains supported.
set -euo pipefail

PATTERN="toolName === ['\"](Task|Agent)['\"]"

if command -v rg >/dev/null 2>&1; then
  VIOLATIONS=$(rg "$PATTERN" apps/ packages/ \
    --glob '!**/__tests__/**' \
    --glob '!**/toolNames.ts' \
    -l 2>/dev/null || true)
else
  VIOLATIONS=$(grep -R -l -E "$PATTERN" apps/ packages/ \
    --include='*.ts' \
    --include='*.tsx' \
    --exclude-dir='__tests__' \
    --exclude='toolNames.ts' 2>/dev/null || true)
fi

if [ -n "${VIOLATIONS:-}" ]; then
  echo "ERROR: Hard-coded parent tool-name check found:"
  echo "$VIOLATIONS"
  echo "Use isParentTaskTool(toolName) from shared toolNames utilities."
  exit 1
fi

echo "OK: No hard-coded parent tool-name checks."
