#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$(dirname "$ELECTRON_DIR")")"

# Helper function to check required file/directory exists
require_path() {
    local path="$1"
    local description="$2"
    local hint="$3"

    if [ ! -e "$path" ]; then
        echo "ERROR: $description not found at $path"
        [ -n "$hint" ] && echo "$hint"
        exit 1
    fi
}

# Parse arguments
ARCH="arm64"
UNSIGNED=false

show_help() {
    cat << EOF
Usage: build-dmg.sh [arm64|x64] [--unsigned]

Arguments:
  arm64|x64    Target architecture (default: arm64)
  --unsigned   Disable code-signing identity discovery for a local artifact

Environment variables (from .env or environment):
  APPLE_SIGNING_IDENTITY    - Code signing identity
  APPLE_ID                  - Apple ID for notarization
  APPLE_TEAM_ID             - Apple Team ID
  APPLE_APP_SPECIFIC_PASSWORD - App-specific password
EOF
    exit 0
}

while [[ $# -gt 0 ]]; do
    case $1 in
        arm64|x64)     ARCH="$1"; shift ;;
        --unsigned)    UNSIGNED=true; shift ;;
        -h|--help)     show_help ;;
        *)
            echo "Unknown option: $1"
            echo "Run with --help for usage"
            exit 1
            ;;
    esac
done

HOST_ARCH=$(uname -m)
case "$HOST_ARCH" in
    arm64|aarch64) HOST_ARCH="arm64" ;;
    x86_64) HOST_ARCH="x64" ;;
    *)
        echo "ERROR: Unsupported macOS host architecture: $HOST_ARCH"
        exit 1
        ;;
esac
if [ "$HOST_ARCH" != "$ARCH" ]; then
    echo "ERROR: Cross-architecture packaging is disabled because native dependencies"
    echo "       such as ripgrep are installed for the host architecture."
    echo "       Run this build on a ${ARCH} macOS host."
    exit 1
fi

# Configuration
BUN_VERSION="bun-v1.3.10"  # Keep aligned with the public CI toolchain.

echo "=== Building Simulator DMG (${ARCH}) using electron-builder ==="
if [ "$UNSIGNED" = true ]; then
    echo "Code signing identity discovery is disabled for this local artifact."
fi

# 1. Clean previous build artifacts
echo "Cleaning previous builds..."
rm -rf "$ELECTRON_DIR/vendor"
rm -rf "$ELECTRON_DIR/node_modules/@anthropic-ai"
rm -rf "$ELECTRON_DIR/packages"
rm -rf "$ELECTRON_DIR/release"

# 2. Install dependencies
echo "Installing dependencies..."
cd "$ROOT_DIR"
bun install --frozen-lockfile

# 3. Download Bun binary with checksum verification
echo "Downloading Bun ${BUN_VERSION} for darwin-${ARCH}..."
mkdir -p "$ELECTRON_DIR/vendor/bun"
BUN_DOWNLOAD="bun-darwin-$([ "$ARCH" = "arm64" ] && echo "aarch64" || echo "x64")"

# Create temp directory to avoid race conditions
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Download binary and checksums
curl -fSL "https://github.com/oven-sh/bun/releases/download/${BUN_VERSION}/${BUN_DOWNLOAD}.zip" -o "$TEMP_DIR/${BUN_DOWNLOAD}.zip"
curl -fSL "https://github.com/oven-sh/bun/releases/download/${BUN_VERSION}/SHASUMS256.txt" -o "$TEMP_DIR/SHASUMS256.txt"

# Verify checksum
echo "Verifying checksum..."
cd "$TEMP_DIR"
grep "${BUN_DOWNLOAD}.zip" SHASUMS256.txt | shasum -a 256 -c -
cd - > /dev/null

# Extract and install
unzip -o "$TEMP_DIR/${BUN_DOWNLOAD}.zip" -d "$TEMP_DIR"
cp "$TEMP_DIR/${BUN_DOWNLOAD}/bun" "$ELECTRON_DIR/vendor/bun/"
chmod +x "$ELECTRON_DIR/vendor/bun/bun"

# 4. Copy SDK from root node_modules (monorepo hoisting)
# Note: The SDK is hoisted to root node_modules by the package manager.
# We copy it here because electron-builder only sees apps/electron/.
#
# Since SDK 0.2.113 the SDK split into a thin core + per-platform binary
# package. We bundle:
#   1. The core (`claude-agent-sdk`) — universal sdk.mjs + types.
#   2. The matching arch's binary package, copied to a stable alias path
#      `claude-agent-sdk-binary/` so the electron-builder.yml entry stays
#      arch-agnostic and the runtime resolver finds it regardless of host
#      arch at build time.
SDK_SOURCE="$ROOT_DIR/node_modules/@anthropic-ai/claude-agent-sdk"
require_path "$SDK_SOURCE" "SDK core" "Run 'bun install' from the repository root first."
echo "Copying SDK core..."
mkdir -p "$ELECTRON_DIR/node_modules/@anthropic-ai"
rm -rf "$ELECTRON_DIR/node_modules/@anthropic-ai/claude-agent-sdk"
cp -r "$SDK_SOURCE" "$ELECTRON_DIR/node_modules/@anthropic-ai/"

# 4a. Resolve the target arch's binary package. If the host arch matches the
#     target, bun install already placed it in node_modules/@anthropic-ai/.
#     Otherwise, fetch and unpack the matching tarball directly via npm.
SDK_BIN_PKG="claude-agent-sdk-darwin-${ARCH}"
SDK_BIN_SOURCE="$ROOT_DIR/node_modules/@anthropic-ai/${SDK_BIN_PKG}"
if [ ! -d "$SDK_BIN_SOURCE" ]; then
    echo "Cross-arch build: ${SDK_BIN_PKG} not in node_modules — fetching the locked version from npm..."
    SDK_VERSION=$(node -p "require('$ROOT_DIR/package.json').dependencies['@anthropic-ai/claude-agent-sdk']" | tr -d '"')
    PKG_TMP=$(mktemp -d)
    trap "rm -rf $PKG_TMP" RETURN
    (
        cd "$PKG_TMP"
        npm pack "@anthropic-ai/${SDK_BIN_PKG}@${SDK_VERSION}" >/dev/null
        TARBALL=$(ls anthropic-ai-*.tgz | head -1)
        EXPECTED_INTEGRITY=$(node -e '
          const fs = require("fs");
          const [lockPath, packageName] = process.argv.slice(1);
          const lock = fs.readFileSync(lockPath, "utf8");
          const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const match = lock.match(new RegExp(`"${escaped}": \\[.*?"(sha512-[^"]+)"\\]`));
          if (!match) process.exit(1);
          process.stdout.write(match[1]);
        ' "$ROOT_DIR/bun.lock" "@anthropic-ai/${SDK_BIN_PKG}") || {
          echo "ERROR: No integrity entry for @anthropic-ai/${SDK_BIN_PKG} in bun.lock"
          exit 1
        }
        ACTUAL_INTEGRITY="sha512-$(openssl dgst -sha512 -binary "$TARBALL" | openssl base64 -A)"
        if [ "$ACTUAL_INTEGRITY" != "$EXPECTED_INTEGRITY" ]; then
            echo "ERROR: Integrity mismatch for @anthropic-ai/${SDK_BIN_PKG}@${SDK_VERSION}"
            exit 1
        fi
        tar -xzf "$TARBALL"
    )
    mkdir -p "$SDK_BIN_SOURCE"
    cp -r "$PKG_TMP/package/." "$SDK_BIN_SOURCE/"
fi

require_path "$SDK_BIN_SOURCE" "SDK native binary package (${SDK_BIN_PKG})" \
  "Run 'bun install' from the repository root, or check your network for the npm cross-fetch."

echo "Staging SDK native binary as claude-agent-sdk-binary alias..."
ALIAS_DEST="$ELECTRON_DIR/node_modules/@anthropic-ai/claude-agent-sdk-binary"
rm -rf "$ALIAS_DEST"
mkdir -p "$ALIAS_DEST"
cp -r "$SDK_BIN_SOURCE/." "$ALIAS_DEST/"
chmod +x "$ALIAS_DEST/claude"

# Sanity check: native binary should be ~210 MB. Anything dramatically smaller
# indicates a botched copy / wrong tarball.
BIN_SIZE=$(stat -f%z "$ALIAS_DEST/claude" 2>/dev/null || stat -c%s "$ALIAS_DEST/claude")
if [ "$BIN_SIZE" -lt 50000000 ]; then
    echo "ERROR: claude binary at $ALIAS_DEST/claude is only ${BIN_SIZE} bytes (expected ~210 MB)"
    exit 1
fi
echo "  Native binary: $((BIN_SIZE / 1024 / 1024)) MB"

# 5. Copy ripgrep (was previously bundled inside the SDK at vendor/ripgrep/;
#    moved out in 0.2.113. Search service still needs the binary directly.)
RG_SOURCE="$ROOT_DIR/node_modules/@vscode/ripgrep"
require_path "$RG_SOURCE" "@vscode/ripgrep" "Run 'bun install' and 'bun pm trust @vscode/ripgrep' first."
require_path "$RG_SOURCE/bin/rg" "ripgrep binary" "@vscode/ripgrep postinstall did not run."
echo "Copying @vscode/ripgrep..."
mkdir -p "$ELECTRON_DIR/node_modules/@vscode"
rm -rf "$ELECTRON_DIR/node_modules/@vscode/ripgrep"
cp -r "$RG_SOURCE" "$ELECTRON_DIR/node_modules/@vscode/"

# 6. Copy network interceptor sources.
#    NOTE (Phase 1 of SDK uplift): the Claude native binary doesn't accept
#    Bun's --preload, so the Claude code path no longer uses these. They're
#    still needed for the **Pi** subprocess (runs on Bun, accepts --preload).
#    Phase 2 will reintroduce equivalent functionality for Claude via SDK
#    hooks or a local proxy.
INTERCEPTOR_SOURCE="$ROOT_DIR/packages/shared/src/unified-network-interceptor.ts"
require_path "$INTERCEPTOR_SOURCE" "Interceptor" "Ensure packages/shared/src/unified-network-interceptor.ts exists."
echo "Copying interceptor (for Pi subprocess)..."
mkdir -p "$ELECTRON_DIR/packages/shared/src"
cp "$INTERCEPTOR_SOURCE" "$ELECTRON_DIR/packages/shared/src/"
for dep in interceptor-common.ts feature-flags.ts interceptor-request-utils.ts; do
  if [ -f "$ROOT_DIR/packages/shared/src/$dep" ]; then
    cp "$ROOT_DIR/packages/shared/src/$dep" "$ELECTRON_DIR/packages/shared/src/"
  fi
done

# 6. Build Electron app
echo "Building Electron app..."
cd "$ROOT_DIR"
if [ "$UNSIGNED" = true ]; then
    PUBLIC_PRIVACY_SENTINEL="SIMULATOR_PUBLIC_BUILD_MUST_STRIP_CRASH_INGEST_2026"
    SENTRY_ELECTRON_INGEST_URL="$PUBLIC_PRIVACY_SENTINEL" \
      SIMULATOR_PUBLIC_BUILD=1 \
      SIMULATOR_DISABLE_UPDATES=1 \
      bun run electron:build
else
    bun run electron:build
fi

# 7. Package with electron-builder
echo "Packaging app with electron-builder..."
cd "$ELECTRON_DIR"

# Set up environment for electron-builder
if [ "$UNSIGNED" = true ]; then
    export CSC_IDENTITY_AUTO_DISCOVERY=false
else
    export CSC_IDENTITY_AUTO_DISCOVERY=true
fi

# Build electron-builder arguments. Engineering RCs must never publish as a
# side effect of creating their local DMG and ZIP artifacts.
BUILDER_ARGS=(--mac "--${ARCH}" --publish never)

# Add code signing if identity is available
if [ "$UNSIGNED" = false ] && [ -n "$APPLE_SIGNING_IDENTITY" ]; then
    # Strip "Developer ID Application: " prefix if present (electron-builder adds it automatically)
    CSC_NAME_CLEAN="${APPLE_SIGNING_IDENTITY#Developer ID Application: }"
    echo "Using signing identity: $CSC_NAME_CLEAN"
    export CSC_NAME="$CSC_NAME_CLEAN"
fi

# Add notarization if all credentials are available
if [ "$UNSIGNED" = false ] && [ -n "$APPLE_ID" ] && [ -n "$APPLE_TEAM_ID" ] && [ -n "$APPLE_APP_SPECIFIC_PASSWORD" ]; then
    echo "Notarization enabled"
    export APPLE_ID="$APPLE_ID"
    export APPLE_TEAM_ID="$APPLE_TEAM_ID"
    export APPLE_APP_SPECIFIC_PASSWORD="$APPLE_APP_SPECIFIC_PASSWORD"

    # Enable notarization in electron-builder by setting env vars
    # The electron-builder.yml has notarize section commented out,
    # but we can enable it via environment
    export NOTARIZE=true
fi

# Run electron-builder
npx electron-builder "${BUILDER_ARGS[@]}"

if [ "$ARCH" = "arm64" ]; then
    APP_ROOT="$ELECTRON_DIR/release/mac-arm64/Simulator.app"
else
    APP_ROOT="$ELECTRON_DIR/release/mac/Simulator.app"
fi
require_path "$APP_ROOT" "app bundle" "electron-builder did not create the expected app."
bun "$ELECTRON_DIR/scripts/validate-assets.ts" --packaged-app "$APP_ROOT"
bun "$ROOT_DIR/scripts/packaged-server-resources.ts" --app "$APP_ROOT"

if [ "$UNSIGNED" = true ]; then
    bun "$ROOT_DIR/scripts/release/verify-public-build-privacy.ts" \
      "$APP_ROOT" \
      "$PUBLIC_PRIVACY_SENTINEL"
fi

# 8. Verify the DMG was built
# electron-builder.yml uses artifactName to output: Simulator-${arch}.dmg
DMG_NAME="Simulator-${ARCH}.dmg"
DMG_PATH="$ELECTRON_DIR/release/$DMG_NAME"

if [ ! -f "$DMG_PATH" ]; then
    echo "ERROR: Expected DMG not found at $DMG_PATH"
    echo "Contents of release directory:"
    ls -la "$ELECTRON_DIR/release/"
    exit 1
fi

echo ""
echo "=== Build Complete ==="
echo "DMG: $ELECTRON_DIR/release/${DMG_NAME}"
echo "Size: $(du -h "$ELECTRON_DIR/release/${DMG_NAME}" | cut -f1)"
