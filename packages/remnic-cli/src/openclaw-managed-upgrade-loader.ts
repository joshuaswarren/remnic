import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as ManagedUpgradeModule from "@remnic/plugin-openclaw/managed-upgrade";
import { isSpecifierNotFoundError } from "./optional-module-loader.js";

const MANAGED_UPGRADE_SPECIFIER = "@remnic/" + "plugin-openclaw/managed-upgrade";
const OPENCLAW_PLUGIN_PACKAGE = "@remnic/" + "plugin-openclaw";
const NPM_INSTALL_TIMEOUT_MS = 120_000;

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
    const installArgs = [
      "install",
      "--ignore-scripts",
      "--no-save",
      "--no-package-lock",
      "--audit=false",
      "--fund=false",
      "--prefix",
      temporaryRoot,
      packageSpec,
    ];
    (hooks.runNpmInstall ?? runNpmInstall)(installArgs);

    const resolverPath = path.join(temporaryRoot, "load-managed-upgrade.mjs");
    fs.writeFileSync(resolverPath, `export * from ${JSON.stringify(MANAGED_UPGRADE_SPECIFIER)};\n`, "utf8");
    return (await importModule(pathToFileURL(resolverPath).href)) as OpenclawManagedUpgradeModule;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
