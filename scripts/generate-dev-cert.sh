#!/bin/sh
# Generate a self-signed TLS certificate for development.
# Usage: ./scripts/generate-dev-cert.sh [output-dir]
#
# Creates cert.pem and key.pem in the specified directory (default: ./certs/).
# These are valid for 365 days and trusted only locally.
#
# To use with the server:
#   CRAFT_RPC_TLS_CERT=certs/cert.pem CRAFT_RPC_TLS_KEY=certs/key.pem bun run server:dev

set -e
umask 077

OUT_DIR="${1:-certs}"
mkdir -p "$OUT_DIR"

if ! command -v openssl >/dev/null 2>&1; then
  echo "error: openssl is required to generate a development certificate" >&2
  exit 127
fi

CONFIG_FILE="$OUT_DIR/.openssl-dev-cert-$$.cnf"
trap 'rm -f "$CONFIG_FILE"' EXIT HUP INT TERM

cat > "$CONFIG_FILE" <<'EOF'
[req]
distinguished_name = distinguished_name
x509_extensions = v3_req
prompt = no

[distinguished_name]
CN = localhost

[v3_req]
subjectAltName = @alt_names
basicConstraints = critical, CA:true
keyUsage = critical, digitalSignature, keyEncipherment, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always

[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
IP.2 = ::1
EOF

openssl req -x509 \
  -newkey rsa:2048 -sha256 \
  -keyout "$OUT_DIR/key.pem" \
  -out "$OUT_DIR/cert.pem" \
  -days 365 -nodes \
  -config "$CONFIG_FILE" \
  2>/dev/null

echo "Generated self-signed TLS certificate:"
echo "  cert: $OUT_DIR/cert.pem"
echo "  key:  $OUT_DIR/key.pem"
echo ""
echo "Start server with TLS:"
echo "  CRAFT_RPC_TLS_CERT=$OUT_DIR/cert.pem CRAFT_RPC_TLS_KEY=$OUT_DIR/key.pem bun run server:dev"
