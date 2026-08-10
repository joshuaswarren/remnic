import fs from "node:fs";
import path from "node:path";

export const REMNIC_OPENCLAW_PLUGIN_ID = "openclaw-remnic";
const OPENCLAW_EXEC_TIMEOUT_MS = 120_000;
const OPENCLAW_PLUGIN_PACKAGE = "@remnic/plugin-openclaw";
const SEMVER_CORE_SELECTOR = /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)/;
const SEMVER_SUFFIX_SELECTOR = /^(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DIST_TAG_SELECTOR = /^[A-Za-z][0-9A-Za-z._-]*$/;

function isExactSemverSelector(selector: string): boolean {
  const core = selector.match(SEMVER_CORE_SELECTOR)?.[0];
  return Boolean(core && SEMVER_SUFFIX_SELECTOR.test(selector.slice(core.length)));
}

function assertRegistryPackageSpec(spec: string): void {
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
}
interface ManagedPluginInspection {
  installPath?: string;
  installPackage?: string;
  installSource?: string;
  status?: unknown;
  version?: string;
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
  readonly managedRollbackDir?: string;
  readonly managedRollbackTargetDir?: string;
  readonly rollbackDir?: string;
  readonly shouldRestoreBackup: boolean;
  readonly shouldRestoreConfig: boolean;

  constructor(
    message: string,
    options: ErrorOptions & {
      managedRollbackDir?: string;
      managedRollbackTargetDir?: string;
      rollbackDir?: string;
      shouldRestoreBackup?: boolean;
      shouldRestoreConfig?: boolean;
    } = {}
  ) {
    super(message, options);
    this.name = "PublishedOpenclawPluginInstallError";
    this.managedRollbackDir = options.managedRollbackDir;
    this.managedRollbackTargetDir = options.managedRollbackTargetDir;
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
  rollbackDir?: string;
  rollbackManagedInstall: () => void;
  version?: string;
} {
  assertRegistryPackageSpec(spec);
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
  const rollbackManagedInstall = (): void => {
    const previousInstall = previousManagedInstall;
    const previousSource = previousInstall?.installSource;
    if (previousInstall && (previousSource === "npm" || previousSource === "clawhub")) {
      if (!installSupportsForce) {
        const currentInstall = inspectManagedPlugin(["plugins", "inspect", "--all", "--json"]);
        if (currentInstall.installSource) {
          runOpenclawCommand(["plugins", "uninstall", REMNIC_OPENCLAW_PLUGIN_ID, "--force"]);
        }
      }
      const previousSpec =
        previousSource === "npm"
          ? `@remnic/plugin-openclaw@${previousInstall.version}`
          : `clawhub:${previousInstall.installPackage}@${previousInstall.version}`;
      const previousPackageArg =
        installSupportsForce && previousSource === "npm" ? `npm:${previousSpec}` : previousSpec;
      const restoreArgs = ["plugins", "install", previousPackageArg];
      if (installSupportsForce) restoreArgs.push("--force");
      runOpenclawCommand(restoreArgs);
      const restoredPlugin = inspectInstalledPlugin(inspectSupportsRuntime);
      if (
        restoredPlugin.status !== "loaded" ||
        restoredPlugin.installSource !== previousSource ||
        restoredPlugin.version !== previousInstall.version
      ) {
        throw new Error("OpenClaw did not restore the previous managed plugin version.");
      }
      return;
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

    if (inspectedPlugin.status !== "loaded") {
      throw new Error(
        `OpenClaw reported plugin status ${JSON.stringify(inspectedPlugin.status ?? "missing")} ` +
          `for ${REMNIC_OPENCLAW_PLUGIN_ID} after the managed install.`
      );
    }

    return {
      managedRollbackDir: activeManagedRollbackDir,
      managedRollbackTargetDir: activeManagedRollbackTargetDir,
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
      managedRollbackDir: activeManagedRollbackDir,
      managedRollbackTargetDir: activeManagedRollbackTargetDir,
      rollbackDir: activeRollbackDir,
      shouldRestoreBackup,
      shouldRestoreConfig: managedInstallStarted,
    });
  }
}
