import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { EMBEDDED_BUILD_VARIABLES, embeddedBuildValue } from "./build-environment"

const root = join(import.meta.dir, "..")
const read = (path: string): string => readFileSync(join(root, path), "utf8")

describe("release operations policy", () => {
  test("public builds remove the crash reporting ingest URL", () => {
    expect(EMBEDDED_BUILD_VARIABLES).toContain("SENTRY_ELECTRON_INGEST_URL")
    expect(
      embeddedBuildValue("SENTRY_ELECTRON_INGEST_URL", {
        SIMULATOR_PUBLIC_BUILD: "1",
        SENTRY_ELECTRON_INGEST_URL: "https://public-build-must-not-embed.invalid/1",
      }),
    ).toBe("")
  })

  test("the public unsigned packaging path explicitly enables public-build stripping", () => {
    const buildScript = read("apps/electron/scripts/build-dmg.sh")
    const packageWorkflow = read(".github/workflows/package-macos.yml")
    expect(buildScript).toContain("SIMULATOR_PUBLIC_BUILD=1")
    expect(buildScript).toContain("SIMULATOR_DISABLE_UPDATES=1")
    expect(buildScript).toContain("verify-public-build-privacy.ts")
    expect(packageWorkflow).toContain('"scripts/release/verify-public-build-privacy.ts"')
  })

  test("the macOS package gate executes packaged identity and signature checks for verifier changes", () => {
    const packageWorkflow = read(".github/workflows/package-macos.yml")
    for (const path of [
      "scripts/release/verify-and-bundle-macos.sh",
      "scripts/release/verify-macos-signatures.ts",
      "scripts/release/verify-packaged-electron-identity.ts",
    ]) {
      expect(packageWorkflow).toContain(`- \"${path}\"`)
    }
    expect(packageWorkflow).toContain('verify-packaged-electron-identity.ts "$app_root" "$product_version"')
    expect(packageWorkflow).toContain('"$app_root" "Contents/MacOS/$executable_name"')
    expect(packageWorkflow).toContain(".requiredArm64MachOFileType")
  })

  test("the pull-request package gate can only use the arm64 ad-hoc signing fallback", () => {
    const buildScript = read("apps/electron/scripts/build-dmg.sh")
    const packageWorkflow = read(".github/workflows/package-macos.yml")
    const packageJson = JSON.parse(read("package.json")) as { dependencies?: Record<string, string> }
    const lockfile = read("bun.lock")
    const buildStepStart = packageWorkflow.indexOf("- name: Build unsigned arm64 package")
    const verifyStepStart = packageWorkflow.indexOf("- name: Verify artifact and architecture")

    expect(buildStepStart).toBeGreaterThan(-1)
    expect(verifyStepStart).toBeGreaterThan(buildStepStart)
    const buildStep = packageWorkflow.slice(buildStepStart, verifyStepStart)
    expect(buildStep).toContain('CSC_FOR_PULL_REQUEST: "true"')
    expect(buildStep).toContain('CSC_IDENTITY_AUTO_DISCOVERY: "false"')
    expect(packageWorkflow.match(/CSC_FOR_PULL_REQUEST/g)).toHaveLength(1)
    expect(buildStep).toContain("electron:dist:unsigned:mac:arm64")
    expect(buildScript).toContain("export CSC_IDENTITY_AUTO_DISCOVERY=false")
    expect(buildScript).toContain("unset CSC_LINK CSC_KEY_PASSWORD CSC_NAME CSC_KEYCHAIN")
    expect(buildScript).toContain("unset CSC_INSTALLER_LINK CSC_INSTALLER_KEY_PASSWORD")
    expect(buildScript).toContain(
      "unset APPLE_SIGNING_IDENTITY APPLE_ID APPLE_TEAM_ID APPLE_APP_SPECIFIC_PASSWORD",
    )
    expect(buildScript).toContain("unset APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER")
    expect(buildScript).toContain("unset APPLE_KEYCHAIN APPLE_KEYCHAIN_PROFILE")
    expect(packageWorkflow).toContain(
      "all(.objects[]; .kind == \"adhoc\" and .strictVerification.exitCode == 0)",
    )

    expect(packageWorkflow).toContain("permissions:\n  contents: read")
    expect(packageWorkflow).toContain("persist-credentials: false")
    expect(packageWorkflow).not.toContain("pull_request_target")
    expect(packageWorkflow).not.toContain("environment:")
    expect(packageWorkflow).not.toContain("id-token: write")
    expect(packageWorkflow).not.toContain("secrets.")
    expect(packageWorkflow).not.toContain("GITHUB_TOKEN")
    expect(packageWorkflow).not.toContain("github.token")
    expect(packageWorkflow).not.toContain("GH_TOKEN")
    expect(packageWorkflow).toContain('- "apps/electron/electron-builder.env"')
    expect(existsSync(join(root, "apps/electron/electron-builder.env"))).toBe(false)

    expect(packageJson.dependencies?.["@vscode/ripgrep"]).toBe("^1.17.1")
    expect(lockfile).toContain('"@vscode/ripgrep": ["@vscode/ripgrep@1.17.1"')
    expect(packageWorkflow).toContain('RIPGREP_PACKAGE_VERSION: "1.17.1"')
    expect(packageWorkflow).toContain(
      'RIPGREP_ASSET_URL: "https://github.com/microsoft/ripgrep-prebuilt/releases/download/v15.0.1/ripgrep-v15.0.1-aarch64-apple-darwin.tar.gz"',
    )
    expect(packageWorkflow).toContain(
      'RIPGREP_ASSET_SHA256: "2fa16464fd8638588a67c7fc172d3c4b57fbdc65dff366e10b0b0e90734628a6"',
    )
    expect(packageWorkflow).toContain('TMPDIR: ${{ runner.temp }}')
    expect(packageWorkflow).toContain('test "$(tar -tzf "$download_path")" = "rg"')
    expect(packageWorkflow).not.toContain("api.github.com")
  })

  test("public policy documents remain discoverable and contain no invented contact", () => {
    const readme = read("README.md")
    const security = read("SECURITY.md")
    const privacy = read("PRIVACY.md")
    const support = read("SUPPORT.md")

    expect(readme).toContain("[隐私政策](PRIVACY.md)")
    expect(readme).toContain("[支持与版本政策](SUPPORT.md)")
    expect(security).toContain("[支持与版本政策](SUPPORT.md)")
    expect(privacy).toContain("默认不包含 crash-reporting ingest URL")
    expect(privacy).toContain("https://agents.craft.do/electron/latest")
    expect(privacy).toContain("~/.craft-agent/credentials.enc")
    expect(privacy).toContain("不等同于 macOS Keychain")
    expect(support).toContain("Simulator 尚未发布稳定版本")

    for (const document of [privacy, support]) {
      expect(document).not.toContain("TODO")
      expect(document).not.toContain("example.com")
      expect(document).not.toMatch(/[\w.+-]+@simulator\.[a-z]+/i)
    }
  })

  test("maintenance and disaster recovery runbooks preserve evidence honesty", () => {
    const operations = read("docs/RELEASE_OPERATIONS.md")
    const disasterRecovery = read("docs/DISASTER_RECOVERY.md")

    expect(operations).toContain("每月依赖与上游审查")
    expect(operations).toContain("Go/No-Go")
    expect(disasterRecovery).toContain("每季度至少演练一次")
    expect(disasterRecovery).toContain("Pass/Fail/Not run")
    expect(disasterRecovery).toContain("不得写成已通过")
    expect(disasterRecovery).toContain("Not run (blocked by #71)")
  })
})
