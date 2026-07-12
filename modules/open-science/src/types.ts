export type ArtifactRole =
  | "binary" | "license" | "notice" | "third-party-notices" | "sbom" | "checksums"
  | "runtime-policy" | "provenance" | "third-party-decisions" | "models-snapshot"
  | "build-attestation" | "runtime-conformance"

export interface InventoryFile {
  path: string
  sha256: string
  size: number
  role: ArtifactRole
}

export interface ArtifactInventory {
  schemaVersion: 1
  source: {
    repository: "https://github.com/synthetic-sciences/openscience"
    ref: "refs/tags/v1.3.4"
    commit: "109a1b94329fa4cdd82e984b5a40bfe8842b5e6f"
  }
  artifact: {
    name: "openscience"
    version: "1.3.4"
    platform: "darwin"
    arch: "arm64"
    format: "bun-compiled-binary"
    capabilities: readonly ["embedded-web", "rdkit"]
  }
  files: InventoryFile[]
}

export interface RuntimePolicy {
  schemaVersion: 1
  network: {
    listen: "dynamic-loopback-only"
    allowedHosts: ["127.0.0.1", "[::1]"]
    requireHostValidation: true
    requireOriginValidation: true
  }
  isolation: Record<"xdgDataHome" | "xdgConfigHome" | "xdgCacheHome" | "xdgStateHome", string>
  nativeControls: Record<"agent" | "mcp" | "permissions", "preserve">
  credentials: {
    productionPersistence: "forbidden"
    futurePersistence: "host-bridge-required"
  }
}

export interface BuildBindings {
  binarySha256: string
  sourceRepository: string
  sourceRef: string
  sourceCommit: string
  bunVersion: string
  modelsDevApiSha256: string
  networkDisabled: true
  componentPolicySha256: string
  componentSetSha256: string
}

export interface RuntimeBindings {
  binarySha256: string
  dynamicLoopbackBind: true
  hostValidation: true
  originValidation: true
  productionCredentialPersistenceDenied: true
}

export interface VerificationIdentity {
  subject: string
  source: string
  evidence: string
}

export interface TrustDecision extends VerificationIdentity {
  trusted: true
}

export interface TrustedProvenanceVerifier {
  readonly verifierKind: string
  verify(attestation: unknown, expected: BuildBindings): Promise<TrustDecision>
}

export interface TrustedRuntimeConformanceVerifier {
  readonly verifierKind: string
  verify(evidence: unknown, expected: RuntimeBindings): Promise<TrustDecision>
}

export interface ValidationOptions {
  provenanceVerifier?: TrustedProvenanceVerifier
  runtimeVerifier?: TrustedRuntimeConformanceVerifier
}
