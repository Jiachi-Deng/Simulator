export interface InventoryFile {
  path: string
  sha256: string
  size: number
  role: "binary" | "license" | "notice" | "third-party-notices" | "sbom" | "checksums" | "runtime-policy"
}

export interface ArtifactInventory {
  schemaVersion: 1
  source: {
    repository: "https://github.com/synthetic-sciences/openscience"
    tag: "v1.3.4"
    commit: "109a1b94329fa4cdd82e984b5a40bfe8842b5e6f"
    sourceDate: "2026-07-11T07:22:21Z"
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
  isolation: {
    xdgDataHome: string
    xdgConfigHome: string
    xdgCacheHome: string
    xdgStateHome: string
  }
  nativeControls: {
    agent: "preserve"
    mcp: "preserve"
    permissions: "preserve"
  }
  credentials: {
    productionPersistence: "forbidden"
    futurePersistence: "host-bridge-required"
  }
}
