import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
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
    expect(buildScript).toContain("SIMULATOR_PUBLIC_BUILD=1")
    expect(buildScript).toContain("SIMULATOR_DISABLE_UPDATES=1")
    expect(buildScript).toContain("verify-public-build-privacy.ts")
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
