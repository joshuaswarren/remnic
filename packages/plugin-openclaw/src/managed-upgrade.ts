import fs from "node:fs";
import path from "node:path";

export const REMNIC_OPENCLAW_PLUGIN_ID = "openclaw-remnic";
const OPENCLAW_EXEC_TIMEOUT_MS = 120_000;
const OPENCLAW_PLUGIN_PACKAGE = "@remnic/plugin-openclaw";
const DIST_TAG_SELECTOR = /^[A-Za-z][0-9A-Za-z._-]*$/;

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

function assertRegistryPackageSpec(spec: string): string {
  const prefix = `${OPENCLAW_PLUGIN_PACKAGE}@`;
  const selector = spec.startsWith(prefix) ? spec.slice(prefix.length) : "";
  const lowerSelector = selector.toLowerCase();
  const archiveSelector = lowerSelector.endsWith(".tgz") || lowerSelector.endsWith(".tar.gz");
  if (!selector || (!isExactSemverSelector(selector) && !DIST_TAG_SELECTOR.test(selector)) || archiveSelector) {
    const renderedSpec = JSON.stringify(spec);
    throw new Error(
      `Invalid OpenClaw plugin package spec ${renderedSpec}. Use an exact semantic version or npm dist-tag.`
    );
  }
  return selector;
}
interface ManagedPluginInspection {
  installPath?: string;
  installPackage?: string;
  installSource?: string;
  status?: unknown;
  version?: string;
}

function isInstalledPluginStatus(status: unknown): boolean {
  return status === "loaded" || status === "disabled";
}

export interface OpenclawCommandOptions {
  timeoutMs: number;
}

export type OpenclawCommandRunner = (args: readonly string[], options: OpenclawCommandOptions) => string;

export function assertDirectoryPathOrMissing(targetPath: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(targetPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${targetPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} must be a directory when it already exists: ${targetPath}`);
  }
}

export function describeErrorWithCause(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof Error) || !("cause" in error)) return message;

  const cause = error.cause;
  if (cause === undefined || cause === null) return message;

  const causeText = cause instanceof Error ? cause.message : String(cause);
  if (!causeText || causeText === message) return message;
  return `${message} Cause: ${causeText}`;
}

export class PublishedOpenclawPluginInstallError extends Error {
  readonly managedRestoreNote?: string;
  readonly managedRollbackDir?: string;
  readonly managedRollbackTargetDir?: string;
  readonly requiresHostManagedRestore: boolean;
  readonly rollbackDir?: string;
  readonly shouldRestoreBackup: boolean;
  readonly shouldRestoreConfig: boolean;

  constructor(
    message: string,
    options: ErrorOptions & {
      managedRestoreNote?: string;
      managedRollbackDir?: string;
      managedRollbackTargetDir?: string;
      requiresHostManagedRestore?: boolean;
      rollbackDir?: string;
      shouldRestoreBackup?: boolean;
      shouldRestoreConfig?: boolean;
    } = {}
  ) {
    super(message, options);
    this.name = "PublishedOpenclawPluginInstallError";
    this.managedRestoreNote = options.managedRestoreNote;
    this.managedRollbackDir = options.managedRollbackDir;
    this.managedRollbackTargetDir = options.managedRollbackTargetDir;
    this.requiresHostManagedRestore = options.requiresHostManagedRestore ?? false;
    this.rollbackDir = options.rollbackDir;
    this.shouldRestoreBackup = options.shouldRestoreBackup ?? false;
    this.shouldRestoreConfig = options.shouldRestoreConfig ?? false;
  }
}

export function installPublishedOpenclawPlugin(
  spec: string,
  pluginDir: string,
  managedTargetDir: string,
  runOpenclaw: OpenclawCommandRunner
): {
  managedRollbackDir?: string;
  managedRollbackTargetDir?: string;
  requiresHostManagedRestore: boolean;
  rollbackDir?: string;
  rollbackManagedInstall: () => string | undefined;
  version?: string;
} {
  const requestedSelector = assertRegistryPackageSpec(spec);
  assertDirectoryPathOrMissing(pluginDir, "OpenClaw plugin dir");
  assertDirectoryPathOrMissing(managedTargetDir, "Managed OpenClaw plugin dir");
  const rollbackSuffix = `${process.pid}-${Date.now()}`;
  const rollbackDir = `${pluginDir}.rollback-${rollbackSuffix}`;
  const managedRollbackDir = `${managedTargetDir}.rollback-${rollbackSuffix}`;
  const runOpenclawCommand = (args: readonly string[]): string =>
    runOpenclaw(args, { timeoutMs: OPENCLAW_EXEC_TIMEOUT_MS });
  let activeRollbackDir: string | undefined;
  let activeManagedRollbackDir: string | undefined;
  let activeManagedRollbackTargetDir: string | undefined;
  let managedInstallStarted = false;
  let shouldRestoreBackup = false;
  let managedRestoreNote: string | undefined;

  const readOpenclawHelp = (subcommand: "inspect" | "install"): string =>
    runOpenclawCommand(["plugins", subcommand, "--help"]);

  const inspectManagedPlugin = (inspectArgs: string[]): ManagedPluginInspection => {
    const inspectOutput = runOpenclawCommand(inspectArgs);

    let inspectResult: unknown;
    try {
      inspectResult = JSON.parse(inspectOutput);
    } catch (error) {
      throw new Error("OpenClaw returned invalid JSON while inspecting the managed plugin.", {
        cause: error,
      });
    }
    const inspected = Array.isArray(inspectResult)
      ? inspectResult.find((candidate) => {
          if (!candidate || typeof candidate !== "object" || !("plugin" in candidate)) {
            return false;
          }
          const plugin = candidate.plugin;
          return Boolean(
            plugin &&
              typeof plugin === "object" &&
              (("id" in plugin && plugin.id === REMNIC_OPENCLAW_PLUGIN_ID) ||
                ("name" in plugin && plugin.name === REMNIC_OPENCLAW_PLUGIN_ID))
          );
        })
      : inspectResult;
    if (!inspected || typeof inspected !== "object") return {};

    const plugin = "plugin" in inspected ? inspected.plugin : undefined;
    const install = "install" in inspected ? inspected.install : undefined;
    return {
      status: plugin && typeof plugin === "object" && "status" in plugin ? plugin.status : undefined,
      installPath:
        install && typeof install === "object" && "installPath" in install && typeof install.installPath === "string"
          ? install.installPath
          : undefined,
      installPackage:
        install &&
        typeof install === "object" &&
        "clawhubPackage" in install &&
        typeof install.clawhubPackage === "string"
          ? install.clawhubPackage
          : undefined,
      installSource:
        install && typeof install === "object" && "source" in install && typeof install.source === "string"
          ? install.source
          : undefined,
      version:
        install && typeof install === "object" && "version" in install && typeof install.version === "string"
          ? install.version
          : undefined,
    };
  };

  const inspectInstalledPlugin = (runtime: boolean): ManagedPluginInspection => {
    const inspectArgs = ["plugins", "inspect", REMNIC_OPENCLAW_PLUGIN_ID];
    if (runtime) inspectArgs.push("--runtime");
    inspectArgs.push("--json");
    return inspectManagedPlugin(inspectArgs);
  };

  const retireUnmanagedPlugin = (): void => {
    fs.rmSync(rollbackDir, { recursive: true, force: true });
    if (!fs.existsSync(pluginDir)) return;

    try {
      fs.renameSync(pluginDir, rollbackDir);
      activeRollbackDir = rollbackDir;
    } catch (error) {
      shouldRestoreBackup = true;
      throw error;
    }
  };
  const retireManagedTarget = (): void => {
    if (path.resolve(managedTargetDir) === path.resolve(pluginDir)) return;
    fs.rmSync(managedRollbackDir, { recursive: true, force: true });
    if (!fs.existsSync(managedTargetDir)) return;
    fs.renameSync(managedTargetDir, managedRollbackDir);
    activeManagedRollbackDir = managedRollbackDir;
    activeManagedRollbackTargetDir = managedTargetDir;
  };
  const preserveManagedTarget = (targetDir = previousManagedInstall?.installPath?.trim() || managedTargetDir): void => {
    assertDirectoryPathOrMissing(targetDir, "Tracked managed OpenClaw plugin dir");
    const targetRollbackDir =
      path.resolve(targetDir) === path.resolve(managedTargetDir)
        ? managedRollbackDir
        : `${targetDir}.rollback-${rollbackSuffix}`;
    fs.rmSync(targetRollbackDir, { recursive: true, force: true });
    if (!fs.existsSync(targetDir)) return;
    fs.cpSync(targetDir, targetRollbackDir, { recursive: true });
    activeManagedRollbackDir = targetRollbackDir;
    activeManagedRollbackTargetDir = targetDir;
  };

  let previousManagedInstall: ManagedPluginInspection | undefined;
  let installSupportsForce = false;
  let inspectSupportsRuntime = false;
  const rollbackManagedInstall = (): string | undefined => {
    const previousInstall = previousManagedInstall;
    const previousSource = previousInstall?.installSource;
    if (previousInstall && (previousSource === "npm" || previousSource === "clawhub")) {
      const previousSpec =
        previousSource === "npm"
          ? `@remnic/plugin-openclaw@${previousInstall.version}`
          : `clawhub:${previousInstall.installPackage}@${previousInstall.version}`;
      const previousPackageArg =
        installSupportsForce && previousSource === "npm" ? `npm:${previousSpec}` : previousSpec;

      try {
        if (!installSupportsForce) {
          const currentInstall = inspectManagedPlugin(["plugins", "inspect", "--all", "--json"]);
          if (currentInstall.installSource) {
            runOpenclawCommand(["plugins", "uninstall", REMNIC_OPENCLAW_PLUGIN_ID, "--force"]);
          }
        }
        const restoreArgs = ["plugins", "install", previousPackageArg];
        if (installSupportsForce) restoreArgs.push("--force");
        runOpenclawCommand(restoreArgs);
        const restoredPlugin = inspectInstalledPlugin(inspectSupportsRuntime);
        if (
          !isInstalledPluginStatus(restoredPlugin.status) ||
          restoredPlugin.installSource !== previousSource ||
          restoredPlugin.version !== previousInstall.version
        ) {
          throw new Error("OpenClaw did not restore the previous managed plugin version.");
        }
        return undefined;
      } catch (registryRestoreError) {
        if (!activeManagedRollbackDir) throw registryRestoreError;

        try {
          if (!installSupportsForce) {
            const currentInstall = inspectManagedPlugin(["plugins", "inspect", "--all", "--json"]);
            if (currentInstall.installSource) {
              runOpenclawCommand(["plugins", "uninstall", REMNIC_OPENCLAW_PLUGIN_ID, "--force"]);
            }
          }
          const localRestoreArgs = ["plugins", "install", activeManagedRollbackDir];
          if (installSupportsForce) localRestoreArgs.push("--force");
          runOpenclawCommand(localRestoreArgs);
          const locallyRestoredPlugin = inspectInstalledPlugin(inspectSupportsRuntime);
          if (
            !isInstalledPluginStatus(locallyRestoredPlugin.status) ||
            locallyRestoredPlugin.installSource !== "path" ||
            locallyRestoredPlugin.version !== previousInstall.version
          ) {
            throw new Error("OpenClaw did not re-register the preserved plugin copy.");
          }
          managedRestoreNote =
            "OpenClaw re-registered the preserved plugin copy as a local path because the registry restore failed";
          return managedRestoreNote;
        } catch (localRestoreError) {
          throw new AggregateError(
            [registryRestoreError, localRestoreError],
            "OpenClaw could not restore the previous registry install or re-register the preserved plugin copy."
          );
        }
      }
    }
    const rollbackErrors: unknown[] = [];
    if (managedInstallStarted) {
      try {
        runOpenclawCommand(["plugins", "uninstall", REMNIC_OPENCLAW_PLUGIN_ID, "--force"]);
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (activeManagedRollbackDir && activeManagedRollbackTargetDir) {
      try {
        fs.rmSync(activeManagedRollbackTargetDir, { recursive: true, force: true });
        fs.renameSync(activeManagedRollbackDir, activeManagedRollbackTargetDir);
        activeManagedRollbackDir = undefined;
        activeManagedRollbackTargetDir = undefined;
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (rollbackErrors.length === 1) throw rollbackErrors[0];
    if (rollbackErrors.length > 1) {
      throw new AggregateError(rollbackErrors, "One or more managed plugin rollback steps failed.");
    }
    return undefined;
  };

  try {
    inspectSupportsRuntime = readOpenclawHelp("inspect").includes("--runtime");
    const installHelp = readOpenclawHelp("install");
    installSupportsForce = installHelp.includes("--force");
    previousManagedInstall = inspectManagedPlugin(["plugins", "inspect", "--all", "--json"]);
    const previousSource = previousManagedInstall.installSource;
    if (previousSource && previousSource !== "npm" && previousSource !== "clawhub") {
      throw new Error(
        `OpenClaw tracks ${REMNIC_OPENCLAW_PLUGIN_ID} from ` +
          `${previousSource}; refusing to replace a non-registry install.`
      );
    }
    if (previousSource && !previousManagedInstall.version) {
      throw new Error(
        "OpenClaw tracked the existing plugin without an installed version; refusing a non-reversible update."
      );
    }
    if (previousSource === "clawhub" && !previousManagedInstall.installPackage) {
      throw new Error(
        "OpenClaw tracked the existing ClawHub plugin without its package name; refusing a non-reversible update."
      );
    }
    if (!previousSource && !installSupportsForce) {
      retireManagedTarget();
      retireUnmanagedPlugin();
    }
    if (previousSource === "npm" || previousSource === "clawhub") {
      preserveManagedTarget();
    }
    if (!previousSource && installSupportsForce && fs.existsSync(managedTargetDir)) {
      preserveManagedTarget(managedTargetDir);
    }
    if ((previousSource === "npm" || previousSource === "clawhub") && !installSupportsForce) {
      managedInstallStarted = true;
      runOpenclawCommand(["plugins", "uninstall", REMNIC_OPENCLAW_PLUGIN_ID, "--force"]);
    }

    const packageArg = installSupportsForce ? `npm:${spec}` : spec;
    const installArgs = ["plugins", "install", packageArg];
    if (installSupportsForce) installArgs.push("--force");

    managedInstallStarted = true;
    runOpenclawCommand(installArgs);

    let inspectedPlugin = inspectInstalledPlugin(inspectSupportsRuntime);
    const installPath = inspectedPlugin.installPath;
    if (!installPath) {
      throw new Error("OpenClaw did not report the managed plugin install path after installation.");
    }
    if (!fs.existsSync(installPath) || !fs.statSync(installPath).isDirectory()) {
      throw new Error(`OpenClaw reported a missing managed plugin install path: ${installPath}`);
    }

    const pluginDirExists = fs.existsSync(pluginDir);
    const installedAtPluginDir = pluginDirExists && fs.realpathSync(installPath) === fs.realpathSync(pluginDir);
    if (!installedAtPluginDir) {
      retireUnmanagedPlugin();
      const verifiedPlugin = inspectInstalledPlugin(inspectSupportsRuntime);
      if (verifiedPlugin.installPath !== installPath) {
        throw new Error("OpenClaw changed the managed plugin install path during verification.");
      }
      inspectedPlugin = verifiedPlugin;
    } else if (!activeRollbackDir) {
      shouldRestoreBackup = true;
    }

    if (!isInstalledPluginStatus(inspectedPlugin.status)) {
      throw new Error(
        `OpenClaw reported plugin status ${JSON.stringify(inspectedPlugin.status ?? "missing")} ` +
          `for ${REMNIC_OPENCLAW_PLUGIN_ID} after the managed install.`
      );
    }
    if (isExactSemverSelector(requestedSelector) && inspectedPlugin.version !== requestedSelector.replace(/^v/, "")) {
      throw new Error(
        `OpenClaw reported plugin version ${JSON.stringify(inspectedPlugin.version ?? "missing")} ` +
          `after installing requested exact version ${JSON.stringify(requestedSelector)}.`
      );
    }

    return {
      managedRollbackDir: activeManagedRollbackDir,
      managedRollbackTargetDir: activeManagedRollbackTargetDir,
      requiresHostManagedRestore:
        previousManagedInstall?.installSource === "npm" || previousManagedInstall?.installSource === "clawhub",
      rollbackDir: activeRollbackDir,
      rollbackManagedInstall,
      version: inspectedPlugin.version,
    };
  } catch (error) {
    let installFailure: unknown = error;
    try {
      if (managedInstallStarted || activeManagedRollbackDir) {
        rollbackManagedInstall();
      }
    } catch (cleanupError) {
      installFailure = new AggregateError(
        [error, cleanupError],
        previousManagedInstall?.installSource === "npm" || previousManagedInstall?.installSource === "clawhub"
          ? "The managed plugin failed verification, and OpenClaw could not restore the previous managed version."
          : "The managed plugin failed verification, and OpenClaw could not remove the failed install."
      );
    }
    throw new PublishedOpenclawPluginInstallError(`Failed to install published OpenClaw plugin from ${spec}.`, {
      cause: installFailure,
      managedRestoreNote,
      managedRollbackDir: activeManagedRollbackDir,
      managedRollbackTargetDir: activeManagedRollbackTargetDir,
      requiresHostManagedRestore:
        previousManagedInstall?.installSource === "npm" || previousManagedInstall?.installSource === "clawhub",
      rollbackDir: activeRollbackDir,
      shouldRestoreBackup,
      shouldRestoreConfig: managedInstallStarted,
    });
  }
}
