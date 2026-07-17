#!/bin/bash
set -euo pipefail
umask 077

if [[ $# -ne 3 ]]; then
  echo "Usage: verify-engineering-rc-attestations.sh BUNDLE_DIR SOURCE_SHA EMPTY_OUTPUT_DIR" >&2
  exit 2
fi

BUNDLE_DIR=$1
SOURCE_SHA=$2
OUTPUT_ROOT=$3
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "Source SHA is invalid" >&2; exit 1; }
[[ -n "${GH_TOKEN:-}" ]] || { echo "GH_TOKEN is required" >&2; exit 1; }
[[ -d "$BUNDLE_DIR" && ! -L "$BUNDLE_DIR" ]] || { echo "Bundle root must be a real directory" >&2; exit 1; }
[[ ! -e "$OUTPUT_ROOT" ]] || { echo "Attestation output must start absent" >&2; exit 1; }
mkdir -m 700 "$OUTPUT_ROOT"

verify_attestation() {
  local subject=$1 bundle=$2 predicate=$3 output=$4
  gh attestation verify "$subject" \
    --bundle "$bundle" \
    --repo Jiachi-Deng/Simulator \
    --signer-workflow Jiachi-Deng/Simulator/.github/workflows/engineering-rc.yml \
    --source-ref refs/heads/main \
    --source-digest "$SOURCE_SHA" \
    --signer-digest "$SOURCE_SHA" \
    --deny-self-hosted-runners \
    --cert-oidc-issuer https://token.actions.githubusercontent.com \
    --digest-alg sha256 \
    --predicate-type "$predicate" \
    --format json > "$output"
  chmod 600 "$output"
  jq -e 'type == "array" and length >= 1' "$output" >/dev/null
}

verify_attestation \
  "$BUNDLE_DIR/Simulator-arm64.dmg" \
  "$BUNDLE_DIR/attestations/provenance.sigstore.json" \
  https://slsa.dev/provenance/v1 \
  "$OUTPUT_ROOT/dmg-provenance.json"
verify_attestation \
  "$BUNDLE_DIR/Simulator-arm64.zip" \
  "$BUNDLE_DIR/attestations/provenance.sigstore.json" \
  https://slsa.dev/provenance/v1 \
  "$OUTPUT_ROOT/zip-provenance.json"
verify_attestation \
  "$BUNDLE_DIR/Simulator-arm64.zip" \
  "$BUNDLE_DIR/attestations/sbom.sigstore.json" \
  https://spdx.dev/Document/v2.3 \
  "$OUTPUT_ROOT/zip-sbom.json"

for output in "$OUTPUT_ROOT/zip-sbom.json"; do
  jq -e --slurpfile expected "$BUNDLE_DIR/sbom.spdx.json" \
    'all(.[]; .verificationResult.statement.predicate == $expected[0])' \
    "$output" >/dev/null
done

printf '{"ok":true,"verifiedAttestations":3}\n'
