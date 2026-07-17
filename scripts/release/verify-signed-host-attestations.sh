#!/bin/bash
set -euo pipefail
umask 077

if [[ $# -ne 3 ]]; then
  echo "Usage: verify-signed-host-attestations.sh CANDIDATE_DIR SOURCE_SHA EMPTY_OUTPUT_DIR" >&2
  exit 2
fi

CANDIDATE_DIR=$1
SOURCE_SHA=$2
OUTPUT_ROOT=$3
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "Source SHA is invalid" >&2; exit 1; }
[[ -n "${GH_TOKEN:-}" ]] || { echo "GH_TOKEN is required" >&2; exit 1; }
[[ -d "$CANDIDATE_DIR" && ! -L "$CANDIDATE_DIR" ]] || { echo "Candidate root must be a real directory" >&2; exit 1; }
[[ ! -e "$OUTPUT_ROOT" ]] || { echo "Attestation output must start absent" >&2; exit 1; }
mkdir -m 700 "$OUTPUT_ROOT"

for artifact in Simulator-arm64.dmg Simulator-arm64.zip; do
  gh attestation verify "$CANDIDATE_DIR/$artifact" \
    --bundle "$CANDIDATE_DIR/attestations/provenance.sigstore.json" \
    --repo Jiachi-Deng/Simulator \
    --signer-workflow Jiachi-Deng/Simulator/.github/workflows/signed-macos-host-acceptance.yml \
    --source-ref refs/heads/main \
    --source-digest "$SOURCE_SHA" \
    --signer-digest "$SOURCE_SHA" \
    --deny-self-hosted-runners \
    --cert-oidc-issuer https://token.actions.githubusercontent.com \
    --digest-alg sha256 \
    --predicate-type https://slsa.dev/provenance/v1 \
    --format json > "$OUTPUT_ROOT/$artifact.provenance.json"
  chmod 600 "$OUTPUT_ROOT/$artifact.provenance.json"
  jq -e 'type == "array" and length >= 1' "$OUTPUT_ROOT/$artifact.provenance.json" >/dev/null
done

printf '{"ok":true,"verifiedAttestations":2}\n'
