export const GOLDEN_MODULE_MANIFEST_INPUT = Object.freeze({
  schemaVersion: 1,
  id: 'org.simulator.fake',
  version: '1.0.0',
  artifacts: Object.freeze([
    Object.freeze({
      platform: 'darwin-arm64',
      entrypoint: 'bin/fake-module',
      url: 'https://modules.example.test/org.simulator.fake/1.0.0/darwin-arm64.tar.gz',
      sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    }),
  ]),
  capabilities: Object.freeze(['artifact.read', 'workspace.read']),
})
