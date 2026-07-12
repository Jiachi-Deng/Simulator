#!/bin/bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: verify-and-bundle-macos.sh VERSION RELEASE_DIR BUNDLE_DIR" >&2
  exit 2
fi

VERSION=$1
RELEASE_DIR=$2
BUNDLE_DIR=$3
DMG="$RELEASE_DIR/Simulator-arm64.dmg"
ZIP="$RELEASE_DIR/Simulator-arm64.zip"

for artifact in "$DMG" "$ZIP"; do
  [[ -f "$artifact" ]] || { echo "Missing artifact: $artifact" >&2; exit 1; }
done

find "$RELEASE_DIR" -maxdepth 1 -type f \( -iname 'latest*.yml' -o -iname '*.blockmap' \) -print -quit | grep -q . && {
  echo "Updater metadata must not enter an engineering RC: $RELEASE_DIR" >&2
  exit 1
}

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

verify_app() {
  local app=$1
  local plist="$app/Contents/Info.plist"
  local executable_name executable
  [[ -f "$plist" ]] || { echo "Missing Info.plist in $app" >&2; exit 1; }
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")" == "$VERSION" ]]
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")" == "com.lukilabs.craft-agent" ]]
  executable_name=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist")
  executable="$app/Contents/MacOS/$executable_name"
  [[ -x "$executable" ]] || { echo "Missing executable in $app" >&2; exit 1; }
  [[ "$(lipo -archs "$executable")" == "arm64" ]]
  if codesign -dvv "$app" 2>&1 | grep -q '^Authority='; then
    echo "Engineering RC must be unsigned (signing Authority found): $app" >&2
    exit 1
  fi
  while IFS= read -r -d '' file; do
    file -b "$file" | grep -q 'Mach-O' || continue
    [[ "$(lipo -archs "$file")" == "arm64" ]] || { echo "Non-arm64 Mach-O: $file" >&2; exit 1; }
  done < <(find "$app" -type f -print0)
  python3 - "$executable" <<'PY'
import subprocess, sys
result = subprocess.run([sys.argv[1], "--version"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=15)
if result.returncode != 0:
    raise SystemExit(f"minimal smoke failed ({result.returncode}): {result.stdout.decode(errors='replace')}")
PY
}

write_inventory() {
  local app=$1
  local output=$2
  (
    cd "$app"
    find . -type f -print | LC_ALL=C sort | while IFS= read -r path; do
      shasum -a 256 "$path"
    done | sed 's#  \./#  #'
  ) > "$output"
}

DMG_APPS=("$MOUNT"/*.app)
ZIP_APPS=("$UNZIP"/*.app)
[[ ${#DMG_APPS[@]} -eq 1 && -d "${DMG_APPS[0]}" ]] || { echo "DMG must contain one app" >&2; exit 1; }
[[ ${#ZIP_APPS[@]} -eq 1 && -d "${ZIP_APPS[0]}" ]] || { echo "ZIP must contain one app" >&2; exit 1; }
verify_app "${DMG_APPS[0]}"
verify_app "${ZIP_APPS[0]}"
write_inventory "${DMG_APPS[0]}" "$WORK/dmg-files.sha256"
write_inventory "${ZIP_APPS[0]}" "$WORK/zip-files.sha256"
if ! cmp -s "$WORK/dmg-files.sha256" "$WORK/zip-files.sha256"; then
  echo "DMG and ZIP app file inventories differ" >&2
  diff -u "$WORK/dmg-files.sha256" "$WORK/zip-files.sha256" >&2 || true
  exit 1
fi

mkdir -p "$BUNDLE_DIR"
find "$BUNDLE_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp "$DMG" "$ZIP" "$BUNDLE_DIR/"
cp "$WORK/dmg-files.sha256" "$BUNDLE_DIR/packaged-files.sha256"
(
  cd "$BUNDLE_DIR"
  shasum -a 256 "$(basename "$DMG")" "$(basename "$ZIP")" > SHA256SUMS
)

find "$BUNDLE_DIR" -type f \( -iname 'latest*.yml' -o -iname '*.blockmap' \) -print -quit | grep -q . && {
  echo "Updater metadata leaked into bundle" >&2
  exit 1
}
