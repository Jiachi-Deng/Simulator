import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

const rootDir = resolve(import.meta.dir, "..");
const rootPackage = (await Bun.file(resolve(rootDir, "package.json")).json()) as PackageJson;
const workspacePatterns = Array.isArray(rootPackage.workspaces)
  ? rootPackage.workspaces
  : rootPackage.workspaces?.packages;

if (!workspacePatterns?.length) {
  throw new Error("Root package.json does not declare any workspaces");
}

async function findPackageJsons(patterns: string[]): Promise<Set<string>> {
  const paths = new Set<string>();

  for (const pattern of patterns) {
    const glob = new Bun.Glob(`${pattern}/package.json`);
    for await (const path of glob.scan({ cwd: rootDir, onlyFiles: true })) {
      paths.add(path);
    }
  }

  return paths;
}

const included = await findPackageJsons(
  workspacePatterns.filter((pattern) => !pattern.startsWith("!")),
);
const excluded = await findPackageJsons(
  workspacePatterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1)),
);

const typecheckWorkspaces: Array<{
  directory: string;
  label: string;
  command: string[];
}> = [];
for (const packageJsonPath of [...included].sort()) {
  if (excluded.has(packageJsonPath)) continue;

  const directory = dirname(resolve(rootDir, packageJsonPath));
  if (directory === rootDir) continue;

  const packageJson = (await Bun.file(resolve(rootDir, packageJsonPath)).json()) as PackageJson;
  const hasTypecheckScript = typeof packageJson.scripts?.typecheck === "string";
  const hasTsconfig = existsSync(resolve(directory, "tsconfig.json"));
  if (!hasTypecheckScript && !hasTsconfig) continue;

  typecheckWorkspaces.push({
    directory,
    label: packageJson.name ?? relative(rootDir, directory),
    command: hasTypecheckScript
      ? ["bun", "run", "typecheck"]
      : ["bun", "x", "tsc", "--noEmit"],
  });
}

if (typecheckWorkspaces.length === 0) {
  throw new Error("No workspace declares a typecheck script");
}

console.log(`Running typecheck in ${typecheckWorkspaces.length} workspaces`);
for (const workspace of typecheckWorkspaces) {
  console.log(`\n> ${workspace.label}`);
  const child = Bun.spawn(workspace.command, {
    cwd: workspace.directory,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exit(exitCode);
}
