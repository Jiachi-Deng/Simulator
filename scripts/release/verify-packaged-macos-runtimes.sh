#!/bin/bash
set -euo pipefail
umask 077

if [[ $# -ne 1 ]]; then
  echo "Usage: verify-packaged-macos-runtimes.sh APP_PATH" >&2
  exit 2
fi
if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "Packaged runtime reference verification requires macOS arm64" >&2
  exit 1
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
APP=$1
ENTITLEMENTS="$ROOT_DIR/apps/electron/build/entitlements.mac.plist"
TRUSTED_BUN="$ROOT_DIR/apps/electron/vendor/bun/bun"
TRUSTED_UV="$ROOT_DIR/apps/electron/resources/bin/darwin-arm64/uv"

readonly BUN_BINARY_SHA256="14b0008f960ea480de5d25df5ea0ada0fefa086a15e360ef2d305f44cae8f904"
readonly BUN_BINARY_BYTES="60953744"
readonly UV_BINARY_SHA256="240a5881367c38cbdfac25cad5d8cff2459a730339225e9373028d4453bebe05"
readonly UV_BINARY_BYTES="44269216"

[[ -d "$APP" && ! -L "$APP" ]] || { echo "App bundle must be a real directory: $APP" >&2; exit 1; }
APP=$(cd "$APP" && pwd -P)
[[ -f "$ENTITLEMENTS" && ! -L "$ENTITLEMENTS" ]]

require_trusted_raw() {
  local path=$1
  local expected_bytes=$2
  local expected_sha256=$3
  local label=$4
  [[ -f "$path" && ! -L "$path" && "$(stat -f %l "$path")" == "1" && -x "$path" ]] || {
    echo "$label reference must be one executable regular file: $path" >&2
    exit 1
  }
  [[ "$(stat -f %z "$path")" == "$expected_bytes" ]] || { echo "$label reference size mismatch" >&2; exit 1; }
  [[ "$(shasum -a 256 "$path" | awk '{print $1}')" == "$expected_sha256" ]] || {
    echo "$label reference SHA-256 mismatch" >&2
    exit 1
  }
}

require_trusted_raw "$TRUSTED_BUN" "$BUN_BINARY_BYTES" "$BUN_BINARY_SHA256" "Bun"
require_trusted_raw "$TRUSTED_UV" "$UV_BINARY_BYTES" "$UV_BINARY_SHA256" "uv"
[[ "$("$TRUSTED_BUN" --version)" == "1.3.10" ]]
[[ "$("$TRUSTED_BUN" --revision)" == "1.3.10+30e609e08" ]]
[[ "$("$TRUSTED_UV" --version)" == "uv 0.10.6 (a91bcf268 2026-02-24)" ]]

WORK=$(mktemp -d)
WORK=$(cd "$WORK" && pwd -P)
cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

verify_runtime() {
  local relative_path=$1
  local trusted_raw=$2
  local identifier_prefix=$3
  local evidence_name=$4
  local packaged="$APP/$relative_path"
  local reference_dir="$WORK/$evidence_name-reference"
  local reference="$reference_dir/$identifier_prefix"
  local signature_output identifier packaged_cdhash packaged_cdhash_full reference_output reference_identifier reference_cdhash reference_cdhash_full

  python3 - "$packaged" "$relative_path" <<'PY'
import os
import stat
import struct
import sys

path, label = sys.argv[1:]
metadata = os.lstat(path)
if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
    raise SystemExit(f"Packaged runtime must be a real regular file: {label}")
if metadata.st_nlink != 1:
    raise SystemExit(f"Packaged runtime must not be hard linked: {label}")
if metadata.st_mode & 0o111 == 0:
    raise SystemExit(f"Packaged runtime must be executable: {label}")
with open(path, "rb") as handle:
    header = handle.read(16)
if len(header) != 16:
    raise SystemExit(f"Packaged runtime is truncated: {label}")
magic, cpu_type, _cpu_subtype, file_type = struct.unpack("<IIII", header)
if magic != 0xFEEDFACF or cpu_type != 0x0100000C or file_type != 2:
    raise SystemExit(f"Packaged runtime must be a thin arm64 Mach-O EXECUTE: {label}")
PY

  codesign --verify --strict --verbose=4 "$packaged"
  signature_output=$(codesign -d --verbose=4 "$packaged" 2>&1)
  [[ "$signature_output" == *$'Signature=adhoc'* ]]
  [[ "$signature_output" == *$'TeamIdentifier=not set'* ]]
  [[ "$signature_output" == *$'Hash type=sha256'* ]]
  [[ "$signature_output" == *'flags=0x10002(adhoc,runtime)'* ]]
  identifier=$(printf '%s\n' "$signature_output" | sed -n 's/^Identifier=//p')
  [[ "$identifier" =~ ^${identifier_prefix}-[0-9a-f]{40}$ ]] || {
    echo "Unexpected packaged runtime identifier for $relative_path: $identifier" >&2
    exit 1
  }
  packaged_cdhash=$(printf '%s\n' "$signature_output" | sed -n 's/^CDHash=//p')
  [[ "$packaged_cdhash" =~ ^[0-9a-f]{40}$ ]]
  packaged_cdhash_full=$(printf '%s\n' "$signature_output" | sed -n 's/^CandidateCDHashFull sha256=//p')
  [[ "$packaged_cdhash_full" =~ ^[0-9a-f]{64}$ ]]

  mkdir -m 700 "$reference_dir"
  cp "$trusted_raw" "$reference"
  chmod 700 "$reference"
  codesign --force --sign - --timestamp=none --options runtime \
    --entitlements "$ENTITLEMENTS" "$reference"
  codesign --verify --strict --verbose=4 "$reference"
  reference_output=$(codesign -d --verbose=4 "$reference" 2>&1)
  reference_identifier=$(printf '%s\n' "$reference_output" | sed -n 's/^Identifier=//p')
  [[ "$reference_identifier" =~ ^${identifier_prefix}-[0-9a-f]{40}$ ]] || {
    echo "Unexpected independently derived runtime identifier for $relative_path: $reference_identifier" >&2
    exit 1
  }
  [[ "$reference_identifier" == "$identifier" ]] || {
    echo "Independently derived identifier mismatch for $relative_path" >&2
    exit 1
  }
  reference_cdhash=$(printf '%s\n' "$reference_output" | sed -n 's/^CDHash=//p')
  reference_cdhash_full=$(printf '%s\n' "$reference_output" | sed -n 's/^CandidateCDHashFull sha256=//p')
  [[ "$reference_cdhash" == "$packaged_cdhash" ]] || {
    echo "Reference CDHash mismatch for $relative_path" >&2
    exit 1
  }
  [[ "$reference_cdhash_full" == "$packaged_cdhash_full" ]] || {
    echo "Reference full SHA-256 CDHash mismatch for $relative_path" >&2
    exit 1
  }
  if ! cmp -s "$reference" "$packaged"; then
    echo "Reference-signed bytes mismatch for $relative_path" >&2
    shasum -a 256 "$reference" "$packaged" >&2
    exit 1
  fi
  printf '%s\t%s\t%s\n' "$relative_path" "$packaged_cdhash_full" "$(shasum -a 256 "$packaged" | awk '{print $1}')"
}

verify_runtime "Contents/Resources/app/vendor/bun/bun" "$TRUSTED_BUN" "bun" "bun"
verify_runtime "Contents/Resources/app/resources/bin/darwin-arm64/uv" "$TRUSTED_UV" "uv" "uv"
verify_runtime "Contents/Resources/app/dist/resources/bin/darwin-arm64/uv" "$TRUSTED_UV" "uv" "dist-uv"
printf '%s\n' "Packaged macOS runtimes exactly match independently reference-signed pinned inputs."
