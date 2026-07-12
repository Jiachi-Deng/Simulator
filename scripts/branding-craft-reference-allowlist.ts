export interface CraftReference {
  path: string
  line: string
  value: string
}

export interface CraftReferenceCategory {
  id: string
  reason: string
  matches: (reference: CraftReference) => boolean
}

export const CRAFT_REFERENCE_PATTERN =
  /Craft Agents?|CraftAgents|craft-agents|craft-agent|CRAFT_[A-Z0-9_]+/g

export const CRAFT_REFERENCE_ALLOWLIST: CraftReferenceCategory[] = [
  {
    id: 'legal-and-upstream-attribution',
    reason: 'License, notice, trademark, conduct, and fork attribution must keep upstream names.',
    matches: ({ path, line }) =>
      /^(?:LICENSE|NOTICE|TRADEMARK\.md|CODE_OF_CONDUCT\.md)$/.test(path)
      || (path === 'README.md' && /upstream|independent fork|foundation|trademark/i.test(line)),
  },
  {
    id: 'runtime-upstream-attribution',
    reason: 'The existing Craft Agent git co-author identity is upstream attribution and keeps its craft.do address.',
    matches: ({ path, line }) =>
      /(?:Co-Authored-By: Craft Agent|upstream Craft Agent attribution)/.test(line)
      && /^(?:packages\/shared\/src\/prompts\/(?:system|__tests__\/system\.test)\.ts|packages\/session-tools-core\/src\/tool-defs\.ts)$/.test(path),
  },
  {
    id: 'historical-release-notes',
    reason: 'Published release notes are historical records and are not rewritten.',
    matches: ({ path }) => path.startsWith('apps/electron/resources/release-notes/'),
  },
  {
    id: 'craft-services-and-examples',
    reason: 'Craft Docs integrations, docs proxy names, bot examples, and service fixtures identify external systems.',
    matches: ({ line }) =>
      /craft\.do|Craft Agents (?:Docs|documentation)|SearchCraftAgents|CraftAgentsBot|CraftAgents E2E|craft-public|Craft document|Craft MCP/i.test(line),
  },
  {
    id: 'compatibility-identifiers',
    reason: 'Protocol, data directory, environment variables, package scope, CLI, and repository slugs stay compatible.',
    matches: ({ value }) =>
      /^CRAFT_[A-Z0-9_]+$/.test(value)
      || /^(?:craftagents|craft-agents|craft-agent)$/.test(value),
  },
  {
    id: 'internal-code-identifiers',
    reason: 'Existing CraftAgents symbols and translation keys are internal API names, not displayed product copy.',
    matches: ({ value }) => value === 'CraftAgents',
  },
  {
    id: 'oauth-and-user-agent-compatibility',
    reason: 'OAuth client and User-Agent identity changes require a separate compatibility migration.',
    matches: ({ path }) =>
      /^packages\/shared\/src\/auth\/(?:oauth|claude-oauth|claude-token)\.ts$/.test(path),
  },
  {
    id: 'updater-and-installer-compatibility',
    reason: 'Published artifact names and upstream installers must continue matching the existing update service.',
    matches: ({ path }) =>
      path === 'apps/electron/electron-builder.yml'
      || /^scripts\/(?:install-app\.(?:sh|ps1)|build\/.*\.ts)$/.test(path)
      || /^apps\/electron\/scripts\/(?:build-dmg\.sh|build-linux\.sh|build-win\.ps1)$/.test(path),
  },
  {
    id: 'preserved-icons-and-logo',
    reason: 'Issue #51 explicitly leaves icon and logo assets and their component names unchanged.',
    matches: ({ path }) =>
      path.startsWith('apps/electron/src/renderer/components/icons/')
      || path === 'apps/electron/src/renderer/playground/registry/icons.tsx'
      || path === 'packages/ui/src/components/chat/SessionViewer.tsx',
  },
  {
    id: 'external-cli-tool-identity',
    reason: 'The craft-agent CLI command and its tool icon are compatibility-facing external identifiers.',
    matches: ({ path }) =>
      path === 'apps/electron/resources/tool-icons/tool-icons.json'
      || path === 'apps/electron/resources/docs/craft-cli.md',
  },
  {
    id: 'compatibility-test-fixtures',
    reason: 'Fixtures exercise legacy paths or external Craft folder names and must remain byte-for-byte compatible.',
    matches: ({ path }) =>
      path === 'apps/cli/src/index.ts'
      || path === 'apps/electron/resources/scripts/tests/test_docx_tool_smoke.py'
      || path === 'packages/shared/src/agent/__tests__/spawn-session-tilde-expansion.test.ts',
  },
]

export function categoryForCraftReference(reference: CraftReference): CraftReferenceCategory | undefined {
  return CRAFT_REFERENCE_ALLOWLIST.find((category) => category.matches(reference))
}
