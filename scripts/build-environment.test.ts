import { describe, expect, test } from "bun:test"
import { EMBEDDED_BUILD_VARIABLES, embeddedBuildValue, isPublicBuild } from "./build-environment"

describe("public build environment", () => {
  test("does not expose embedded credentials from the process environment", () => {
    const env = Object.fromEntries(
      EMBEDDED_BUILD_VARIABLES.map((variable) => [variable, `sentinel-${variable}`]),
    )
    env.SIMULATOR_PUBLIC_BUILD = "1"

    expect(isPublicBuild(env)).toBe(true)
    for (const variable of EMBEDDED_BUILD_VARIABLES) {
      expect(embeddedBuildValue(variable, env)).toBe("")
    }
  })

  test("keeps the existing development build behavior", () => {
    expect(embeddedBuildValue("SLACK_OAUTH_CLIENT_ID", { SLACK_OAUTH_CLIENT_ID: "dev-id" })).toBe(
      "dev-id",
    )
  })
})
