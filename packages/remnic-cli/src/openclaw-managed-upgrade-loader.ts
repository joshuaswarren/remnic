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
const DIST_TAG_SELECTOR = /^[A-Za-z][0-9A-Za-z._-]*$/;
const CARET_SEMVER_RANGE_SELECTOR = /^\^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function semanticVersionCoreLength(selector: string): number {
  let cursor = selector.startsWith("v") ? 1 : 0;
  for (let part = 0; part < 3; part += 1) {
    const partStart = cursor;
    while (cursor < selector.length) {
      const code = selector.charCodeAt(cursor);
      if (code < 48 || code > 57) break;
      cursor += 1;
    }
    if (cursor === partStart || (cursor - partStart > 1 && selector.charCodeAt(partStart) === 48)) return -1;
    if (part < 2) {
      if (selector.charCodeAt(cursor) !== 46) return -1;
      cursor += 1;
    }
  }
  return cursor;
}

function areSemverIdentifiersValid(value: string, start: number, end: number, rejectLeadingZeroes: boolean): boolean {
  if (start >= end) return false;
  let identifierStart = start;
  let numeric = true;
  for (let cursor = start; cursor <= end; cursor += 1) {
    const code = value.charCodeAt(cursor);
    if (cursor === end || code === 46) {
      if (cursor === identifierStart) return false;
      if (rejectLeadingZeroes && numeric && cursor - identifierStart > 1 && value.charCodeAt(identifierStart) === 48) {
        return false;
      }
      identifierStart = cursor + 1;
      numeric = true;
      continue;
    }
    const alphanumeric = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (!alphanumeric && code !== 45) return false;
    if (code < 48 || code > 57) numeric = false;
  }
  return true;
}

function isExactSemverSelector(selector: string): boolean {
  const coreLength = semanticVersionCoreLength(selector);
  if (coreLength < 0) return false;
  if (coreLength === selector.length) return true;
  const suffixMarker = selector[coreLength];
  if (suffixMarker === "-") {
    const plusIndex = selector.indexOf("+", coreLength + 1);
    const prereleaseEnd = plusIndex < 0 ? selector.length : plusIndex;
    if (!areSemverIdentifiersValid(selector, coreLength + 1, prereleaseEnd, true)) return false;
    return plusIndex < 0 || areSemverIdentifiersValid(selector, plusIndex + 1, selector.length, false);
  }
  return suffixMarker === "+" && areSemverIdentifiersValid(selector, coreLength + 1, selector.length, false);
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

function readCliAdapterRange(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const manifestPath = path.resolve(moduleDir, "../package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    name?: unknown;
    peerDependencies?: unknown;
  };
  if (manifest.name !== "@remnic/cli") {
    throw new Error(`Invalid @remnic/cli package manifest at ${manifestPath}.`);
  }
  const peerDependencies =
    manifest.peerDependencies &&
    typeof manifest.peerDependencies === "object" &&
    !Array.isArray(manifest.peerDependencies)
      ? (manifest.peerDependencies as Record<string, unknown>)
      : {};
  const adapterRange = peerDependencies[OPENCLAW_PLUGIN_PACKAGE];
  if (typeof adapterRange !== "string" || !CARET_SEMVER_RANGE_SELECTOR.test(adapterRange)) {
    throw new Error(
      `Invalid ${OPENCLAW_PLUGIN_PACKAGE} peer dependency ${JSON.stringify(adapterRange)} in ${manifestPath}.`
    );
  }
  return adapterRange;
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
    const toolingPackageSpec = `${OPENCLAW_PLUGIN_PACKAGE}@${readCliAdapterRange()}`;
    const installArgs = [
      "install",
      "--ignore-scripts",
      "--no-save",
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
    try {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`Could not remove temporary managed upgrade project at ${temporaryRoot}: ${detail}`);
    }
  }
}
