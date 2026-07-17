#!/bin/bash
set -euo pipefail
umask 077

if [[ $# -ne 6 ]]; then
  echo "Usage: package-stapled-macos-host.sh APP_PATH OUTPUT_DIR AUTHORITY TEAM_ID BUNDLE_ID ENTITLEMENTS" >&2
  exit 2
fi
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "Stapled Host packaging requires macOS arm64" >&2
  exit 1
fi

APP=$1
OUTPUT=$2
AUTHORITY=$3
TEAM_ID=$4
BUNDLE_ID=$5
ENTITLEMENTS=$6
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)

[[ "$AUTHORITY" == "Developer ID Application: "* ]] || { echo "Expected exact Developer ID Application subject" >&2; exit 1; }
[[ "$TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || { echo "Expected 10-character Team ID" >&2; exit 1; }
[[ -d "$APP" && ! -L "$APP" ]] || { echo "App must be a real directory" >&2; exit 1; }
APP=$(cd "$APP" && pwd -P)
[[ -f "$ENTITLEMENTS" && ! -L "$ENTITLEMENTS" ]] || { echo "Entitlements must be a real file" >&2; exit 1; }
[[ ! -e "$OUTPUT" ]] || { echo "Output must start absent: $OUTPUT" >&2; exit 1; }
mkdir -m 700 "$OUTPUT"
OUTPUT=$(cd "$OUTPUT" && pwd -P)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/simulator-stapled-packaging.XXXXXX")
WORK=$(cd "$WORK" && pwd -P)
BUILD_OUTPUT="$WORK/electron-builder-output"
mkdir -m 700 "$BUILD_OUTPUT"

executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")
[[ "$executable" != */* && "$executable" != . && "$executable" != .. ]]
before="$WORK/before-signatures.json"
after="$WORK/after-signatures.json"
before_tree="$WORK/before-exact-tree.json"
after_tree="$WORK/after-exact-tree.json"
trap 'rm -rf "$WORK"' EXIT
bun "$SCRIPT_DIR/verify-macos-signatures.ts" "$APP" "Contents/MacOS/$executable" \
  --mode developer-id --authority "$AUTHORITY" --team-id "$TEAM_ID" \
  --bundle-id "$BUNDLE_ID" --entitlements "$ENTITLEMENTS" > "$before"
python3 "$SCRIPT_DIR/compare-macos-app-payloads.py" exact-tree "$APP" > "$before_tree"
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose=4 "$APP"

# `--prepackaged` skips application assembly/signing and creates transports from
# the already notarized and stapled app. It must not mutate the app bytes.
(
  cd "$ROOT_DIR/apps/electron"
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  unset CSC_LINK CSC_KEY_PASSWORD CSC_NAME CSC_KEYCHAIN
  "$ROOT_DIR/node_modules/.bin/electron-builder" --config electron-builder.yml --prepackaged "$APP" \
    --mac dmg zip --arm64 --publish never --config.directories.output="$BUILD_OUTPUT"
)

bun "$SCRIPT_DIR/verify-macos-signatures.ts" "$APP" "Contents/MacOS/$executable" \
  --mode developer-id --authority "$AUTHORITY" --team-id "$TEAM_ID" \
  --bundle-id "$BUNDLE_ID" --entitlements "$ENTITLEMENTS" > "$after"
python3 "$SCRIPT_DIR/compare-macos-app-payloads.py" exact-tree "$APP" > "$after_tree"
cmp -s "$before" "$after" || { echo "Packaging mutated the stapled app signature evidence" >&2; exit 1; }
cmp -s "$before_tree" "$after_tree" || { echo "Packaging mutated the stapled app path/type/mode/symlink/file-byte inventory" >&2; exit 1; }

for artifact in Simulator-arm64.dmg Simulator-arm64.zip; do
  source="$BUILD_OUTPUT/$artifact"
  [[ -f "$source" && ! -L "$source" && "$(stat -f %l "$source")" == 1 ]] || {
    echo "Expected prepackaged output is missing or unsafe: $artifact" >&2
    exit 1
  }
  if [[ "$artifact" == Simulator-arm64.dmg ]]; then
    python3 "$SCRIPT_DIR/preflight-macos-release-artifact.py" dmg "$source"
  else
    python3 "$SCRIPT_DIR/preflight-macos-release-artifact.py" zip "$source"
  fi
  cp "$source" "$OUTPUT/$artifact"
  chmod 600 "$OUTPUT/$artifact"
done
unexpected=$(find "$OUTPUT" -mindepth 1 -maxdepth 1 ! -name Simulator-arm64.dmg ! -name Simulator-arm64.zip -print -quit)
[[ -z "$unexpected" ]] || { echo "Unexpected prepackaged output: $unexpected" >&2; exit 1; }
hdiutil verify "$OUTPUT/Simulator-arm64.dmg"
printf '%s\n' "Packaged final DMG and ZIP from the unchanged stapled Developer ID app."
