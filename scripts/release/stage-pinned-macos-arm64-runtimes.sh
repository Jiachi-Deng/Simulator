#!/bin/bash
set -euo pipefail
umask 077

if [[ $# -ne 0 ]]; then
  echo "stage-pinned-macos-arm64-runtimes.sh accepts no arguments" >&2
  exit 2
fi

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "Pinned packaged runtime staging requires macOS arm64" >&2
  exit 1
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
ELECTRON_DIR="$ROOT_DIR/apps/electron"

readonly BUN_ASSET_URL="https://github.com/oven-sh/bun/releases/download/bun-v1.3.10/bun-darwin-aarch64.zip"
readonly BUN_ASSET_SHA256="82034e87c9d9b4398ea619aee2eed5d2a68c8157e9a6ae2d1052d84d533ccd8d"
readonly BUN_ASSET_BYTES="22289708"
readonly BUN_BINARY_SHA256="14b0008f960ea480de5d25df5ea0ada0fefa086a15e360ef2d305f44cae8f904"
readonly BUN_BINARY_BYTES="60953744"
readonly BUN_VERSION="1.3.10"
readonly BUN_REVISION="1.3.10+30e609e08"

readonly UV_ASSET_URL="https://github.com/astral-sh/uv/releases/download/0.10.6/uv-aarch64-apple-darwin.tar.gz"
readonly UV_ASSET_SHA256="3993249d8f51deaf34cfce037e57e294e82267ff1f9dc45b7983a17afaf065b4"
readonly UV_ASSET_BYTES="19303315"
readonly UV_BINARY_SHA256="240a5881367c38cbdfac25cad5d8cff2459a730339225e9373028d4453bebe05"
readonly UV_BINARY_BYTES="44269216"
readonly UV_VERSION_OUTPUT="uv 0.10.6 (a91bcf268 2026-02-24)"

readonly BUN_TARGET="$ELECTRON_DIR/vendor/bun/bun"
readonly UV_TARGET="$ELECTRON_DIR/resources/bin/darwin-arm64/uv"

require_exact_file() {
  local path=$1
  local expected_bytes=$2
  local expected_sha256=$3
  local label=$4

  [[ -f "$path" && ! -L "$path" ]] || { echo "$label must be a real regular file: $path" >&2; return 1; }
  [[ "$(stat -f %l "$path")" == "1" ]] || { echo "$label must not be hard linked: $path" >&2; return 1; }
  [[ "$(stat -f %z "$path")" == "$expected_bytes" ]] || { echo "$label size mismatch: $path" >&2; return 1; }
  [[ "$(shasum -a 256 "$path" | awk '{print $1}')" == "$expected_sha256" ]] || {
    echo "$label SHA-256 mismatch: $path" >&2
    return 1
  }
  [[ -x "$path" ]] || { echo "$label must be executable: $path" >&2; return 1; }
}

require_bun_identity() {
  local path=$1
  require_exact_file "$path" "$BUN_BINARY_BYTES" "$BUN_BINARY_SHA256" "Pinned Bun"
  [[ "$("$path" --version)" == "$BUN_VERSION" ]] || { echo "Pinned Bun version mismatch" >&2; return 1; }
  [[ "$("$path" --revision)" == "$BUN_REVISION" ]] || { echo "Pinned Bun revision mismatch" >&2; return 1; }
}

require_uv_identity() {
  local path=$1
  require_exact_file "$path" "$UV_BINARY_BYTES" "$UV_BINARY_SHA256" "Pinned uv"
  [[ "$("$path" --version)" == "$UV_VERSION_OUTPUT" ]] || { echo "Pinned uv version mismatch" >&2; return 1; }
}

download_exact() {
  local url=$1
  local max_bytes=$2
  local expected_bytes=$3
  local expected_sha256=$4
  local output=$5
  local label=$6

  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --location \
    --retry 3 --retry-all-errors --max-filesize "$max_bytes" --silent --show-error \
    "$url" --output "$output"
  [[ -f "$output" && ! -L "$output" && "$(stat -f %l "$output")" == "1" ]]
  [[ "$(stat -f %z "$output")" == "$expected_bytes" ]] || { echo "$label archive size mismatch" >&2; exit 1; }
  printf '%s  %s\n' "$expected_sha256" "$output" | shasum -a 256 -c -
}

WORK=$(mktemp -d)
WORK=$(cd "$WORK" && pwd -P)
cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$(dirname "$BUN_TARGET")" "$(dirname "$UV_TARGET")"
[[ -d "$(dirname "$BUN_TARGET")" && ! -L "$(dirname "$BUN_TARGET")" ]]
[[ -d "$(dirname "$UV_TARGET")" && ! -L "$(dirname "$UV_TARGET")" ]]

bun_source="${TRUSTED_BUN:-}"
if [[ -n "$bun_source" ]]; then
  [[ "$bun_source" == /* ]] || { echo "TRUSTED_BUN must be an absolute path" >&2; exit 1; }
  require_bun_identity "$bun_source"
elif require_bun_identity "$BUN_TARGET" 2>/dev/null; then
  bun_source=$BUN_TARGET
else
  bun_archive="$WORK/bun-darwin-aarch64.zip"
  download_exact "$BUN_ASSET_URL" 30000000 "$BUN_ASSET_BYTES" "$BUN_ASSET_SHA256" "$bun_archive" "Pinned Bun"
  [[ "$(unzip -Z1 "$bun_archive")" == $'bun-darwin-aarch64/\nbun-darwin-aarch64/bun' ]] || {
    echo "Pinned Bun archive closure mismatch" >&2
    exit 1
  }
  mkdir -m 700 "$WORK/bun"
  ditto -x -k "$bun_archive" "$WORK/bun"
  bun_source="$WORK/bun/bun-darwin-aarch64/bun"
  chmod 500 "$bun_source"
  require_bun_identity "$bun_source"
fi

if [[ "$bun_source" != "$BUN_TARGET" ]]; then
  rm -f "$BUN_TARGET"
  install -m 755 "$bun_source" "$BUN_TARGET"
fi
require_bun_identity "$BUN_TARGET"

if ! require_uv_identity "$UV_TARGET" 2>/dev/null; then
  uv_archive="$WORK/uv-aarch64-apple-darwin.tar.gz"
  download_exact "$UV_ASSET_URL" 25000000 "$UV_ASSET_BYTES" "$UV_ASSET_SHA256" "$uv_archive" "Pinned uv"
  python3 - "$uv_archive" <<'PY'
import stat
import sys
import tarfile

expected = [
    ("uv-aarch64-apple-darwin", "directory", 0, 0o755),
    ("uv-aarch64-apple-darwin/uvx", "regular", 336512, 0o755),
    ("uv-aarch64-apple-darwin/uv", "regular", 44269216, 0o755),
]
with tarfile.open(sys.argv[1], "r:gz") as archive:
    actual = []
    for member in archive.getmembers():
        kind = "directory" if member.isdir() else "regular" if member.isfile() else "unsupported"
        actual.append((member.name.rstrip("/"), kind, member.size, stat.S_IMODE(member.mode)))
if actual != expected:
    raise SystemExit(f"Pinned uv archive closure mismatch: {actual!r}")
PY
  mkdir -m 700 "$WORK/uv"
  tar -xzf "$uv_archive" -C "$WORK/uv"
  uv_source="$WORK/uv/uv-aarch64-apple-darwin/uv"
  chmod 500 "$uv_source"
  require_uv_identity "$uv_source"
  rm -f "$UV_TARGET"
  install -m 755 "$uv_source" "$UV_TARGET"
fi
require_uv_identity "$UV_TARGET"

printf '%s\n' "Pinned macOS arm64 packaged runtimes staged and verified."
