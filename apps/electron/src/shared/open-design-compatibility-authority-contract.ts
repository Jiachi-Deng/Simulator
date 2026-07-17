export const OPEN_DESIGN_0145_COMPATIBILITY_AUTHORITY_RESOURCE_NAME =
  'open-design-0.14.5-compatibility-authority.json'

export const OPEN_DESIGN_0145_COMPATIBILITY_AUTHORITY_RESOURCE_SHA256 =
  '64afd8a46b80877a9083045c8bb6d05da3b5dc2583577e77b23ecf869f675164'

export const OPEN_DESIGN_0145_COMPATIBILITY_AUTHORITY_ID =
  'open-design-0.14.5-host-0.12.0-darwin-arm64-v1'

export const OPEN_DESIGN_0145_COMPATIBILITY_HOST = Object.freeze({
  version: '0.12.0',
  platform: 'darwin-arm64',
} as const)

export const OPEN_DESIGN_0145_ORIGINAL_HOST_VERSION_RANGE = '>=0.11.1 <0.12.0'
export const OPEN_DESIGN_0145_INITIAL_PUBLISHED_CATALOG_SHA256 =
  '3832da6574c0eb9808e0b001205318b271996748b39fe2edcb330c5d1c3b4848'
export const OPEN_DESIGN_0145_INITIAL_PUBLISHED_ENVELOPE_SHA256 =
  'caa18a16f1ded49b47ae54fced2dd0afe139571ba503b4c176929b6bc1e24a7c'
export const OPEN_DESIGN_0145_PUBLIC_KEY_RAW_SHA256 =
  'f4e7b85cfa73e1f48caceed15aa5d4d0136a63ac73dcdc495ddee1229f5d0d6d'
export const OPEN_DESIGN_0145_COMPATIBILITY_PROTOCOL = 'v1'
export const OPEN_DESIGN_0145_COMPATIBILITY_RATIONALE =
  'Frozen v1 rollback authority for OpenDesign 0.14.5 only. Initial published catalog and envelope hashes are provenance, not runtime refresh equality gates; runtime catalogs remain subject to Downloader signature verification. The exception does not broaden ordinary semver compatibility or authorize v2, another module, version, host, platform, manifest, artifact, catalog signing key, or unsigned catalog.'
