export const PUBLIC_BUILD_ENV = "SIMULATOR_PUBLIC_BUILD"
export const DISABLE_UPDATES_ENV = "SIMULATOR_DISABLE_UPDATES"

export const EMBEDDED_BUILD_VARIABLES = [
  "SLACK_OAUTH_CLIENT_ID",
  "SLACK_OAUTH_CLIENT_SECRET",
  "MICROSOFT_OAUTH_CLIENT_ID",
  "MICROSOFT_OAUTH_CLIENT_SECRET",
  "SENTRY_ELECTRON_INGEST_URL",
  "CRAFT_DEV_RUNTIME",
] as const

export function isPublicBuild(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PUBLIC_BUILD_ENV] === "1"
}

export function embeddedBuildValue(
  variable: (typeof EMBEDDED_BUILD_VARIABLES)[number],
  env: NodeJS.ProcessEnv = process.env,
): string {
  return isPublicBuild(env) ? "" : (env[variable] ?? "")
}

export function areBuildUpdatesDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DISABLE_UPDATES_ENV] === "1"
}
