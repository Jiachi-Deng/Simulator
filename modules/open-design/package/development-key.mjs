import { createPublicKey } from "node:crypto";

// DEVELOPMENT-ONLY. This fixed private key is intentionally public and must
// never be trusted by a public/release catalog path.
export const DEVELOPMENT_ONLY_KEY_ID = "m1-open-design-development-only-2026-07-14";
export const DEVELOPMENT_ONLY_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIJH2d8b2779Drutq++yHGeJhfl/9R/G2s+RtMoE54jcE
-----END PRIVATE KEY-----
`;
export const DEVELOPMENT_ONLY_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEACX2REWrodyZ9wHTQ16jhOPCmvj1jtqhRQtWv97YfanA=
-----END PUBLIC KEY-----
`;

export const DEVELOPMENT_ONLY_KEY_ACTIVE_FROM = "2026-07-14T00:00:00.000Z";
// The public development key is accepted only by the explicit local-only
// bootstrap path. Keep the key stable for M1 recovery while the signed catalog
// below remains intentionally short-lived and non-promotable.
export const DEVELOPMENT_ONLY_KEY_ACTIVE_UNTIL = "2027-07-14T00:00:00.000Z";
export const DEVELOPMENT_ONLY_TEST_CATALOG_ISSUED_AT = "2026-07-14T00:00:00.000Z";

export function developmentOnlyPublicKeyBytes() {
  const jwk = createPublicKey(DEVELOPMENT_ONLY_PUBLIC_KEY_PEM).export({ format: "jwk" });
  if (typeof jwk.x !== "string") throw new Error("development Ed25519 public key is invalid");
  return Uint8Array.from(Buffer.from(jwk.x, "base64url"));
}
