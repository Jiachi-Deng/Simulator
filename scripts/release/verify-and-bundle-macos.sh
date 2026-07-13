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

assert_no_updater_metadata "$RELEASE_DIR" "release directory"

WORK=$(mktemp -d)
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
assert_no_updater_metadata "$MOUNT" "DMG mount root"
assert_no_updater_metadata "$UNZIP" "ZIP extraction root"

verify_app() {
  local app=$1
  local plist="$app/Contents/Info.plist"
  local executable_name executable
  [[ -f "$plist" ]] || { echo "Missing Info.plist in $app" >&2; exit 1; }
  bun "$SCRIPT_DIR/updates-disabled.ts" --app "$app"
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")" == "$VERSION" ]]
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")" == "com.lukilabs.craft-agent" ]]
  executable_name=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist")
  executable="$app/Contents/MacOS/$executable_name"
  [[ -x "$executable" ]] || { echo "Missing executable in $app" >&2; exit 1; }
  bun "$SCRIPT_DIR/verify-macos-signatures.ts" "$app"
  python3 - "$executable" <<'PY'
import subprocess, sys
result = subprocess.run([sys.argv[1], "--version"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=15)
if result.returncode != 0:
    raise SystemExit(f"minimal smoke failed ({result.returncode}): {result.stdout.decode(errors='replace')}")
PY
}

write_inventory() {
  local app=$1
  local inventory=$2
  local checksums=$3
  python3 "$SCRIPT_DIR/write-app-inventory.py" "$app" "$inventory" --spdx-files "$checksums"
}

DMG_APPS=("$MOUNT"/*.app)
ZIP_APPS=("$UNZIP"/*.app)
[[ ${#DMG_APPS[@]} -eq 1 && -d "${DMG_APPS[0]}" ]] || { echo "DMG must contain one app" >&2; exit 1; }
[[ ${#ZIP_APPS[@]} -eq 1 && -d "${ZIP_APPS[0]}" ]] || { echo "ZIP must contain one app" >&2; exit 1; }
verify_app "${DMG_APPS[0]}"
verify_app "${ZIP_APPS[0]}"
write_inventory "${DMG_APPS[0]}" "$WORK/dmg-app-inventory.jsonl" "$WORK/dmg-files.sha256"
write_inventory "${ZIP_APPS[0]}" "$WORK/zip-app-inventory.jsonl" "$WORK/zip-files.sha256"
if ! cmp -s "$WORK/dmg-app-inventory.jsonl" "$WORK/zip-app-inventory.jsonl"; then
  echo "DMG and ZIP app filesystem inventories differ" >&2
  diff -u "$WORK/dmg-app-inventory.jsonl" "$WORK/zip-app-inventory.jsonl" >&2 || true
  exit 1
fi

mkdir -p "$BUNDLE_DIR"
find "$BUNDLE_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp "$DMG" "$ZIP" "$BUNDLE_DIR/"
cp "$WORK/dmg-files.sha256" "$BUNDLE_DIR/packaged-files.sha256"
cp "$WORK/dmg-app-inventory.jsonl" "$BUNDLE_DIR/app-inventory.jsonl"
(
  cd "$BUNDLE_DIR"
  shasum -a 256 "$(basename "$DMG")" "$(basename "$ZIP")" > SHA256SUMS
)

assert_no_updater_metadata "$BUNDLE_DIR" "bundle"
