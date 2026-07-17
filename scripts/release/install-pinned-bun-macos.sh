#!/bin/bash
set -euo pipefail
umask 077

if [[ $# -ne 0 || -z "${RUNNER_TEMP:-}" || -z "${GITHUB_ENV:-}" || -z "${GITHUB_PATH:-}" ]]; then
  echo "install-pinned-bun-macos.sh requires GitHub Actions environment files and no arguments" >&2
  exit 2
fi

readonly BUN_ASSET_URL="https://github.com/oven-sh/bun/releases/download/bun-v1.3.10/bun-darwin-aarch64.zip"
readonly BUN_ASSET_SHA256="82034e87c9d9b4398ea619aee2eed5d2a68c8157e9a6ae2d1052d84d533ccd8d"
readonly BUN_ASSET_BYTES="22289708"
readonly BUN_BINARY_SHA256="14b0008f960ea480de5d25df5ea0ada0fefa086a15e360ef2d305f44cae8f904"
readonly BUN_BINARY_BYTES="60953744"
readonly BUN_REVISION="1.3.10+30e609e08"

tool_root="$RUNNER_TEMP/simulator-pinned-bun-1.3.10"
test ! -e "$tool_root"
mkdir -m 700 "$tool_root"
archive="$tool_root/bun-darwin-aarch64.zip"
curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --location \
  --retry 3 --retry-all-errors --max-filesize 30000000 --silent --show-error \
  "$BUN_ASSET_URL" --output "$archive"
test -f "$archive"
test ! -L "$archive"
test "$(stat -f %l "$archive")" = 1
test "$(stat -f %z "$archive")" = "$BUN_ASSET_BYTES"
printf '%s  %s\n' "$BUN_ASSET_SHA256" "$archive" | shasum -a 256 -c -

extract_root="$tool_root/extracted"
mkdir -m 700 "$extract_root"
ditto -x -k "$archive" "$extract_root"
bun_binary="$extract_root/bun-darwin-aarch64/bun"
test -f "$bun_binary"
test ! -L "$bun_binary"
test "$(stat -f %l "$bun_binary")" = 1
test "$(stat -f %z "$bun_binary")" = "$BUN_BINARY_BYTES"
printf '%s  %s\n' "$BUN_BINARY_SHA256" "$bun_binary" | shasum -a 256 -c -
test "$(find "$extract_root" -mindepth 1 -print | wc -l | tr -d ' ')" = 2
chmod 500 "$bun_binary"
test "$("$bun_binary" --version)" = "1.3.10"
test "$("$bun_binary" --revision)" = "$BUN_REVISION"

printf 'TRUSTED_BUN=%s\n' "$bun_binary" >> "$GITHUB_ENV"
printf '%s\n' "$(dirname "$bun_binary")" >> "$GITHUB_PATH"
