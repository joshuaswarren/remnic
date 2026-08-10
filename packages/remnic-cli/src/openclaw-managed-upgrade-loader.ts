import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as ManagedUpgradeModule from "@remnic/plugin-openclaw/managed-upgrade";
import { isSpecifierNotFoundError } from "./optional-module-loader.js";

const MANAGED_UPGRADE_SPECIFIER = "@remnic/" + "plugin-openclaw/managed-upgrade";
const OPENCLAW_PLUGIN_PACKAGE = "@remnic/" + "plugin-openclaw";
const NPM_INSTALL_TIMEOUT_MS = 120_000;
const SEMVER_CORE_SELECTOR = /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?=$|[-+])/;
const SEMVER_SUFFIX_SELECTOR =
  /^(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DIST_TAG_SELECTOR = /^[A-Za-z][0-9A-Za-z._-]*$/;

function isExactSemverSelector(selector: string): boolean {
  const core = selector.match(SEMVER_CORE_SELECTOR)?.[0];
  return Boolean(core && SEMVER_SUFFIX_SELECTOR.test(selector.slice(core.length)));
}

function assertRegistrySelector(selector: string): void {
  const lowerSelector = selector.toLowerCase();
  const archiveSelector = lowerSelector.endsWith(".tgz") || lowerSelector.endsWith(".tar.gz");
  if ((!isExactSemverSelector(selector) && !DIST_TAG_SELECTOR.test(selector)) || archiveSelector) {
    throw new Error(
      `Invalid OpenClaw plugin version ${JSON.stringify(selector)}. Use an exact semantic version or npm dist-tag.`
    );
  }
}

export function buildOpenclawManagedUpgradePackageSpec(version = "latest"): string {
  assertRegistrySelector(version);
  return `${OPENCLAW_PLUGIN_PACKAGE}@${version}`;
}

function readCliVersion(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const manifestPath = path.resolve(moduleDir, "../package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (manifest.name !== "@remnic/cli") {
    throw new Error(`Invalid @remnic/cli package manifest at ${manifestPath}.`);
  }
  if (typeof manifest.version !== "string" || !isExactSemverSelector(manifest.version)) {
    throw new Error(`Invalid @remnic/cli package version ${JSON.stringify(manifest.version)}.`);
  }
  return manifest.version;
}

function assertOpenclawManagedUpgradePackageSpec(packageSpec: string): void {
  const prefix = `${OPENCLAW_PLUGIN_PACKAGE}@`;
  if (!packageSpec.startsWith(prefix)) {
    throw new Error(`Invalid OpenClaw plugin package spec ${JSON.stringify(packageSpec)}.`);
  }
  assertRegistrySelector(packageSpec.slice(prefix.length));
}

type OpenclawManagedUpgradeModule = typeof ManagedUpgradeModule;

interface OpenclawManagedUpgradeLoaderHooks {
  importModule?: (specifier: string) => Promise<unknown>;
  runNpmInstall?: (args: string[]) => void;
}

function runNpmInstall(args: string[]): void {
  execFileSync("npm", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: NPM_INSTALL_TIMEOUT_MS,
  });
}

function isManagedUpgradeSubpathMissing(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED" || !("message" in error)) return false;
  if (typeof error.message !== "string") return false;

  const namesManagedUpgradeSubpath =
    error.message.includes("'./managed-upgrade'") || error.message.includes('"./managed-upgrade"');
  const namesOpenclawAdapter = /[/\\]@remnic[/\\]plugin-openclaw[/\\]package\.json(?:\s|$)/.test(error.message);
  return namesManagedUpgradeSubpath && namesOpenclawAdapter;
}

export async function loadOpenclawManagedUpgradeModule(
  packageSpec: string,
  hooks: OpenclawManagedUpgradeLoaderHooks = {}
): Promise<OpenclawManagedUpgradeModule> {
  assertOpenclawManagedUpgradePackageSpec(packageSpec);
  const importModule = hooks.importModule ?? ((specifier: string) => import(specifier));

  try {
    return (await importModule(MANAGED_UPGRADE_SPECIFIER)) as OpenclawManagedUpgradeModule;
  } catch (error) {
    const adapterMissing =
      isSpecifierNotFoundError(error, OPENCLAW_PLUGIN_PACKAGE) ||
      isSpecifierNotFoundError(error, MANAGED_UPGRADE_SPECIFIER) ||
      isManagedUpgradeSubpathMissing(error);
    if (!adapterMissing) throw error;
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-openclaw-upgrade-"));
  try {
    const toolingPackageSpec = buildOpenclawManagedUpgradePackageSpec(readCliVersion());
    const installArgs = [
      "install",
      "--ignore-scripts",
      "--no-save",
      "--no-package-lock",
      "--audit=false",
      "--fund=false",
      "--prefix",
      temporaryRoot,
      toolingPackageSpec,
    ];
    (hooks.runNpmInstall ?? runNpmInstall)(installArgs);

    const resolverPath = path.join(temporaryRoot, "load-managed-upgrade.mjs");
    fs.writeFileSync(resolverPath, `export * from ${JSON.stringify(MANAGED_UPGRADE_SPECIFIER)};\n`, "utf8");
    return (await importModule(pathToFileURL(resolverPath).href)) as OpenclawManagedUpgradeModule;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
