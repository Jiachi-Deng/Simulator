#!/bin/bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: verify-and-bundle-macos.sh VERSION RELEASE_DIR BUNDLE_DIR" >&2
  exit 2
fi

VERSION=$1
RELEASE_DIR=$2
BUNDLE_DIR=$3
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DMG="$RELEASE_DIR/Simulator-arm64.dmg"
ZIP="$RELEASE_DIR/Simulator-arm64.zip"

for artifact in "$DMG" "$ZIP"; do
  [[ -f "$artifact" ]] || { echo "Missing artifact: $artifact" >&2; exit 1; }
done

assert_no_updater_metadata() {
  local root=$1
  local label=$2
  if find "$root" \( -type f -o -type l \) \( -iname 'latest*.yml' -o -iname 'latest*.yaml' -o -iname '*.blockmap' \) -print -quit | grep -q .; then
    echo "Updater metadata must not enter an engineering RC $label: $root" >&2
    exit 1
  fi
}

python3 "$SCRIPT_DIR/preflight-macos-release-artifact.py" container-tree "$RELEASE_DIR"
assert_no_updater_metadata "$RELEASE_DIR" "release directory"
python3 "$SCRIPT_DIR/preflight-macos-release-artifact.py" dmg "$DMG"
python3 "$SCRIPT_DIR/preflight-macos-release-artifact.py" zip "$ZIP"

assert_lstat_type() {
  local path=$1
  local expected_type=$2
  local label=$3
  python3 - "$path" "$expected_type" "$label" <<'PY'
import os
import stat
import sys

path, expected_type, label = sys.argv[1:]
try:
    metadata = os.lstat(path)
except OSError as error:
    raise SystemExit(f"Missing {label}: {path} ({error})")
if stat.S_ISLNK(metadata.st_mode):
    raise SystemExit(f"Symbolic links are not allowed for {label}: {path}")
matches = {
    "directory": stat.S_ISDIR(metadata.st_mode),
    "regular file": stat.S_ISREG(metadata.st_mode),
}
if not matches[expected_type]:
    raise SystemExit(f"Expected {label} to be a {expected_type}: {path}")
PY
}

WORK=$(mktemp -d)
WORK=$(cd "$WORK" && pwd -P)
MOUNT="$WORK/mount"
UNZIP="$WORK/unzip"
mkdir -p "$MOUNT" "$UNZIP"
cleanup() {
  hdiutil detach "$MOUNT" -quiet 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

hdiutil verify "$DMG"
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNT" -quiet
ditto -x -k "$ZIP" "$UNZIP"
python3 "$SCRIPT_DIR/preflight-macos-release-artifact.py" container-tree "$MOUNT"
python3 "$SCRIPT_DIR/preflight-macos-release-artifact.py" container-tree "$UNZIP"
python3 "$SCRIPT_DIR/verify-macos-container-root.py" dmg "$MOUNT" \
  "$SCRIPT_DIR/../../apps/electron/resources/dmg-background.tiff" \
  "$SCRIPT_DIR/../../apps/electron/resources/icon.icns"
python3 "$SCRIPT_DIR/verify-macos-container-root.py" zip "$UNZIP"
assert_no_updater_metadata "$MOUNT" "DMG mount root"
assert_no_updater_metadata "$UNZIP" "ZIP extraction root"

verify_app() {
  local app=$1
  local signature_evidence=$2
  local plist="$app/Contents/Info.plist"
  local executable_name executable
  assert_lstat_type "$app" "directory" "app bundle root"
  assert_lstat_type "$app/Contents" "directory" "app Contents directory"
  assert_lstat_type "$plist" "regular file" "Info.plist"
  assert_lstat_type "$app/Contents/MacOS" "directory" "app MacOS directory"
  bun "$SCRIPT_DIR/updates-disabled.ts" --app "$app"
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")" == "$VERSION" ]]
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$plist")" == "$VERSION" ]]
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")" == "com.lukilabs.craft-agent" ]]
  executable_name=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist")
  [[ "$executable_name" != */* && "$executable_name" != "." && "$executable_name" != ".." ]] || {
    echo "CFBundleExecutable must be a file name: $executable_name" >&2
    exit 1
  }
  executable="$app/Contents/MacOS/$executable_name"
  assert_lstat_type "$executable" "regular file" "app executable"
  [[ -x "$executable" ]] || { echo "Missing executable in $app" >&2; exit 1; }
  bun "$SCRIPT_DIR/verify-packaged-electron-identity.ts" "$app" "$VERSION"
  bun "$SCRIPT_DIR/../packaged-server-resources.ts" --app "$app"
  "$SCRIPT_DIR/verify-packaged-macos-runtimes.sh" "$app"
  bun "$SCRIPT_DIR/verify-macos-signatures.ts" "$app" "Contents/MacOS/$executable_name" | tee "$signature_evidence"
}

write_inventory() {
  local app=$1
  local inventory=$2
  local raw_inventory=$3
  local checksums=$4
  local verification_code=$5
  python3 "$SCRIPT_DIR/write-app-inventory.py" "$app" "$inventory" --transport-canonicalization-policy macos-dmg-zip-v1 --raw-inventory "$raw_inventory" --spdx-files "$checksums" --spdx-package-verification-code "$verification_code"
}

DMG_APP="$MOUNT/Simulator.app"
ZIP_APP="$UNZIP/Simulator.app"
python3 "$SCRIPT_DIR/preflight-macos-release-artifact.py" tree "$DMG_APP"
python3 "$SCRIPT_DIR/preflight-macos-release-artifact.py" tree "$ZIP_APP"
verify_app "$DMG_APP" "$WORK/dmg-signatures.json"
verify_app "$ZIP_APP" "$WORK/zip-signatures.json"
write_inventory "$DMG_APP" "$WORK/dmg-app-inventory.jsonl" "$WORK/dmg-app-inventory.raw.jsonl" "$WORK/dmg-files.sha256" "$WORK/dmg-package-verification-code.txt"
write_inventory "$ZIP_APP" "$WORK/zip-app-inventory.jsonl" "$WORK/zip-app-inventory.raw.jsonl" "$WORK/zip-files.sha256" "$WORK/zip-package-verification-code.txt"
if ! cmp -s "$WORK/dmg-app-inventory.jsonl" "$WORK/zip-app-inventory.jsonl"; then
  echo "DMG and ZIP app filesystem inventories differ" >&2
  diff -u "$WORK/dmg-app-inventory.jsonl" "$WORK/zip-app-inventory.jsonl" >&2 || true
  exit 1
fi
if ! cmp -s "$WORK/dmg-package-verification-code.txt" "$WORK/zip-package-verification-code.txt"; then
  echo "DMG and ZIP app SPDX package verification codes differ" >&2
  diff -u "$WORK/dmg-package-verification-code.txt" "$WORK/zip-package-verification-code.txt" >&2 || true
  exit 1
fi

[[ ! -e "$BUNDLE_DIR" ]] || { echo "Bundle output must start absent: $BUNDLE_DIR" >&2; exit 1; }
mkdir -m 700 "$BUNDLE_DIR"
cp "$DMG" "$ZIP" "$BUNDLE_DIR/"
cp "$WORK/dmg-files.sha256" "$BUNDLE_DIR/packaged-files.sha256"
cp "$WORK/dmg-app-inventory.jsonl" "$BUNDLE_DIR/app-inventory.jsonl"
cp "$WORK/dmg-app-inventory.raw.jsonl" "$BUNDLE_DIR/dmg-app-inventory.raw.jsonl"
cp "$WORK/zip-app-inventory.raw.jsonl" "$BUNDLE_DIR/zip-app-inventory.raw.jsonl"
cp "$WORK/dmg-signatures.json" "$BUNDLE_DIR/dmg-signatures.json"
cp "$WORK/zip-signatures.json" "$BUNDLE_DIR/zip-signatures.json"
cp "$WORK/dmg-package-verification-code.txt" "$BUNDLE_DIR/package-verification-code.txt"
python3 - "$BUNDLE_DIR/transport-normalization-policy.json" <<'PY'
import json
import sys
from pathlib import Path

Path(sys.argv[1]).write_text(json.dumps({
    "schemaVersion": 1,
    "policy": "macos-dmg-zip-v1",
    "canonicalInventory": "app-inventory.jsonl",
    "rawInventories": ["dmg-app-inventory.raw.jsonl", "zip-app-inventory.raw.jsonl"],
    "ignoredExtendedAttributes": [
        "com.apple.cs.CodeDirectory",
        "com.apple.cs.CodeRequirements",
        "com.apple.cs.CodeRequirements-1",
        "com.apple.cs.CodeSignature"
    ],
    "ignoredExtendedAttributeScope": "non-executable regular files only",
    "canonicalSymlinkMode": "0777",
    "signaturePolicy": "unsigned-or-strictly-verified-adhoc",
}, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
(
  cd "$BUNDLE_DIR"
  shasum -a 256 "$(basename "$DMG")" "$(basename "$ZIP")" > SHA256SUMS
)

assert_no_updater_metadata "$BUNDLE_DIR" "bundle"
