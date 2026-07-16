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
  /support@craft\.do|(?:[a-z0-9-]+\.)*craft\.do|Craft Agents?|CraftAgents|craft-agents|craft-agent|CRAFT_[A-Z0-9_]+|\bCraft\b/g

export const CRAFT_REFERENCE_ALLOWLIST: CraftReferenceCategory[] = [
  {
    id: 'allowlist-test-infrastructure',
    reason: 'The scanner definition necessarily names the references that it detects and classifies.',
    matches: ({ path }) => /^scripts\/branding-craft-reference-allowlist(?:\.test)?\.ts$/.test(path),
  },
  {
    id: 'legal-and-upstream-attribution',
    reason: 'License, notice, trademark, conduct, and fork attribution must keep upstream names.',
    matches: ({ path, line }) =>
      /^(?:LICENSE|NOTICE|TRADEMARK\.md|CODE_OF_CONDUCT\.md)$/.test(path)
      || (path === 'apps/electron/electron-builder.yml'
        && /copyright: Copyright © 2026 Craft Docs Ltd\. and Simulator contributors/.test(line))
      || (path === 'README.md' && /upstream|independent fork|foundation|trademark/i.test(line)),
  },
  {
    id: 'runtime-upstream-attribution',
    reason: 'Explicitly enabled upstream co-authorship and bundled upstream theme metadata retain their original attribution.',
    matches: ({ path, line }) =>
      (/(?:Co-Authored-By: Craft Agent|upstream Craft Agent attribution)/.test(line)
        && /^(?:packages\/shared\/src\/prompts\/(?:system|__tests__\/system\.test)\.ts|packages\/session-tools-core\/src\/tool-defs\.ts)$/.test(path))
      || (/"author": "Craft Agent"/.test(line)
        && /^apps\/electron\/resources\/themes\/(?:default|haze)\.json$/.test(path)),
  },
  {
    id: 'historical-release-notes',
    reason: 'Published release notes are historical records and are not rewritten.',
    matches: ({ path }) => path.startsWith('apps/electron/resources/release-notes/'),
  },
  {
    id: 'craft-services-and-examples',
    reason: 'Craft integrations, docs proxy names, bot examples, and service fixtures identify external systems.',
    matches: ({ line }) =>
      /Craft Agents (?:Docs|documentation)|SearchCraftAgents|CraftAgentsBot|CraftAgents E2E|craft-public|Craft document|Craft MCP|Craft (?:space|source|API|Admin|CLI)|\{source:Craft\}/i.test(line),
  },
  {
    id: 'upstream-craft-service-endpoints',
    reason: 'Known Craft-hosted docs, sharing, updater, OAuth, MCP, viewer, and integration endpoints remain external service dependencies.',
    matches: ({ path, line }) =>
      /https?:\/\/agents\.craft\.do(?:\/(?:docs|electron|auth|s|install-app\.(?:sh|ps1))(?:[/?#][^\s'"<)]*)?)?(?:['"<)\s]|$)/.test(line)
      || /https?:\/\/(?:mcp|connect)\.craft\.do(?:[/:?][^\s'"<)]*)?/.test(line)
      || (path === 'packages/shared/src/docs/source-guides.ts' && /craft:\s*'craft\.do'/.test(line)),
  },
  {
    id: 'craft-mcp-url-validation',
    reason: 'The Craft MCP URL validator documents and tests the exact external hostname, including rejected malformed examples.',
    matches: ({ path, line }) =>
      path === 'packages/shared/src/validation/url-validator.ts' && /mcp\.craft\.do/.test(line),
  },
  {
    id: 'localized-upstream-doc-labels',
    reason: 'Localized UI labels identify links as upstream Craft documentation.',
    matches: ({ path, line }) =>
      /^packages\/shared\/src\/i18n\/locales\/(?:de|en|es|hu|ja|pl|zh-Hans)\.json$/.test(path)
      && /(?:upstream|Upstream|上游|アップストリーム).*Craft|Craft.*(?:upstream|Upstream|上游|アップストリーム)/.test(line),
  },
  {
    id: 'localized-craft-integration-copy',
    reason: 'The localized source example names the external Craft integration, not the application product.',
    matches: ({ path, line }) =>
      /^packages\/shared\/src\/i18n\/locales\/(?:de|en|es|hu|ja|pl|zh-Hans)\.json$/.test(path)
      && /"editPopover\.example\.addSource"/.test(line),
  },
  {
    id: 'craft-integration-documentation',
    reason: 'Source guides and examples use Craft as the proper name of an external integration or sample organization.',
    matches: ({ path, line }) =>
      (path === 'apps/electron/resources/docs/sources.md' && /Craft|Available guides/.test(line))
      || (path === 'README.md' && /MCP Servers|\/Applications\/Craft/.test(line))
      || (path === 'apps/electron/README.md' && /Craft workspaces/.test(line))
      || (path === 'packages/shared/src/prompts/system.ts' && /Craft/.test(line))
      || (path === 'packages/shared/src/index.ts' && /Craft API client/.test(line)),
  },
  {
    id: 'craft-oauth-service-copy',
    reason: 'Localized reauthentication copy names the external Craft account service used by the compatibility OAuth flow.',
    matches: ({ path, line }) =>
      /^packages\/shared\/src\/i18n\/locales\/(?:de|en|es|hu|ja|pl|zh-Hans)\.json$/.test(path)
      && /"onboarding\.reauth\.(?:expired|loginWithCraft)"/.test(line),
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
      /^packages\/shared\/src\/auth\/(?:oauth|claude-oauth|claude-token)\.ts$/.test(path)
      || path === 'packages/shared/src/utils/icon.ts',
  },
  {
    id: 'updater-and-installer-compatibility',
    reason: 'Updater and installer lines retain the upstream endpoint and legacy installed-app identifiers required for compatibility.',
    matches: ({ path, line }) => {
      if (path === 'apps/electron/electron-builder.yml') {
        return /url:\s*https:\/\/agents\.craft\.do\/electron\/latest/.test(line)
      }

      if (!/^scripts\/install-app\.(?:sh|ps1)$/.test(path)) return false

      return /https:\/\/agents\.craft\.do\/(?:electron|install-app\.(?:sh|ps1))/.test(line)
        || /Craft-Agents-(?:\$\{?arch\}?|x64|arm64|x86_64|aarch64)\.(?:dmg|zip|exe|AppImage|\$\{ext\})/.test(line)
        || /(?:APP_NAME|APPIMAGE_PATH|APPIMAGE_INSTALL_PATH|OLD_APPIMAGE|Get-Process|LOCALAPPDATA|pgrep|pkill|open -a|Closing|Quitting|Stopping|has been installed|not found).*Craft Agents?/.test(line)
        || /Craft Agents?.*(?:APP_NAME|APPIMAGE_PATH|APPIMAGE_INSTALL_PATH|OLD_APPIMAGE|Get-Process|LOCALAPPDATA|pgrep|pkill|open -a|Closing|Quitting|Stopping|has been installed|not found)/.test(line)
        || /(?:pgrep|pkill).*Craft-Agent\.\*AppImage/.test(line)
        || /^# Craft Agents? (?:Windows Installer|launcher)/.test(line)
    },
  },
  {
    id: 'preserved-icons-and-logo',
    reason: 'Issue #51 explicitly leaves icon and logo assets and their component names unchanged.',
    matches: ({ path, line }) =>
      path.startsWith('apps/electron/src/renderer/components/icons/')
      || path === 'apps/electron/src/renderer/playground/registry/icons.tsx'
      || path === 'packages/ui/src/components/chat/SessionViewer.tsx'
      || (/Craft (?:logo|symbol)/.test(line) && /^(?:apps\/electron\/src\/(?:main\/menu|main\/handlers\/system|renderer\/components\/(?:AppMenu|SplashScreen|app-menu\/(?:DesktopAppMenu|MobileAppMenu|types)|ui\/TopBarButton)|renderer\/playground\/demos\/mobile-webui\/AppMenuMobilePreview)|apps\/electron\/src\/shared\/menu-schema)\.tsx?$/.test(path)),
  },
  {
    id: 'upstream-sharing-service-branding',
    reason: 'The viewer explicitly labels its retained logo link as the upstream Craft-hosted sharing service.',
    matches: ({ path, line }) =>
      path === 'apps/viewer/src/components/Header.tsx' && /Craft(?:-hosted| upstream)/.test(line),
  },
  {
    id: 'internal-craft-compatibility-terminology',
    reason: 'These implementation comments and tests describe upstream Craft schemas, messages, tokens, or compatibility mappings.',
    matches: ({ path }) =>
      /^(?:packages\/pi-agent-server\/src\/(?:craft-metadata-schema(?:\.test)?|index|model-resolution)|packages\/server-core\/src\/sessions\/(?:SessionManager|pi-turn-anchors\.test)|packages\/shared\/src\/(?:agent\/(?:__tests__\/json-prop-to-zod\.test|backend\/pi\/(?:constants|event-adapter)|pi-agent|source-activation-drain)|automations\/types))\.ts$/.test(path)
      || path === 'apps/electron/src/renderer/components/onboarding/ReauthScreen.tsx'
      || path === 'packages/shared/CLAUDE.md',
  },
  {
    id: 'open-design-craft-host-runtime-terminology',
    reason: 'OpenDesign deliberately reuses the embedded Craft workspace and agent runtime; these exact implementation, test, rights, and provenance lines distinguish that trusted Host from the Simulator module boundary.',
    matches: ({ path, line }) =>
      (/^apps\/electron\/src\/main\/module-agent-runtime(?:\.test)?\.ts$/.test(path)
        && /Craft workspace/.test(line))
      || (path === 'modules/open-design/README.md'
        && /Craft workspace.*credential/.test(line))
      || (path === 'modules/open-design/resource-decisions.json'
        && /Host-only OpenDesign uses Craft(?: system typography|-owned module chrome)/.test(line))
      || (path === 'packages/module-agent-gateway/src/types.ts'
        && /Raw Craft session id/.test(line))
      || (path === 'packages/server-core/src/sessions/module-agent-adapter.ts'
        && /Craft(?:'s full| workspace| created)/.test(line)),
  },
  {
    id: 'm1-host-agent-craft-runtime-terminology',
    reason: 'M1 Host Agent implementation, contract, generated Shim, and focused tests name the embedded Craft runtime only to define priority, lifecycle, and failure-isolation boundaries.',
    matches: ({ path, line }) =>
      (path === 'CHANGELOG.md'
        && /Host-owned `simulator-host-agent`|OpenDesign v2.*(?:transient Craft Session|Craft Turn)/.test(line))
      || path === 'apps/electron/resources/host-agent/simulator-host-agent.mjs'
      || /^apps\/electron\/src\/host-agent\/(?:__tests__\/(?:module-turn-lease|supervisor)\.test|module-turn-lease|supervisor|v1-compatibility-runtime|worker-entry)\.ts$/.test(path)
      || /^apps\/electron\/src\/main\/module-agent-runtime(?:\.test)?\.ts$/.test(path)
      || /^(?:packages\/host-agent-contract\/(?:schema\/host-agent-v2\.schema\.json|src\/constants\.ts)|packages\/host-agent-run-core\/src\/run-core(?:\.test)?\.ts)$/.test(path)
      || path === 'packages/pi-agent-server/src/file-tool-path-input.ts'
      || /^(?:packages\/server-core\/src\/(?:handlers\/session-manager-interface|sessions\/(?:module-agent-adapter|visible-craft-turn-gate(?:\.test)?|visible-craft-turn-priority\.test))|packages\/shared\/src\/agent\/(?:module-agent-tool-boundary|provider-process-reaper))\.ts$/.test(path),
  },
  {
    id: 'localized-open-design-craft-host-copy',
    reason: 'The Module Center intentionally names the still-visible Craft workspace and sidebar so users understand that OpenDesign runs inside, and can return to, the primary embedded Host surface.',
    matches: ({ path, line }) =>
      /^packages\/shared\/src\/i18n\/locales\/(?:de|en|es|hu|ja|pl|zh-Hans)\.json$/.test(path)
      && /"modules\.(?:subtitle|openDesign\.hostNote)"/.test(line),
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
      || path === 'packages/shared/src/agent/__tests__/spawn-session-tilde-expansion.test.ts'
      || path === 'apps/electron/src/main/__tests__/browser-pane-manager.test.ts'
      || path === 'packages/server-core/src/webui/__tests__/oauth-callback.test.ts'
      || path === 'apps/electron/src/renderer/assets/samples/sample-invoice.pdf'
      || path === 'packages/shared/src/config/__tests__/storage-update-llm-connection.test.ts'
      || /^apps\/electron\/src\/renderer\/playground\/(?:registry\/(?:browser-ui|mobile-webui|planner)|demos\/mobile-webui\/AppMenuMobilePreview)\.tsx$/.test(path),
  },
]

export function categoryForCraftReference(reference: CraftReference): CraftReferenceCategory | undefined {
  return CRAFT_REFERENCE_ALLOWLIST.find((category) => category.matches(reference))
}
