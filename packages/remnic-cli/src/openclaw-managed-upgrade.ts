import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const REMNIC_OPENCLAW_PLUGIN_ID = "openclaw-remnic";
interface ManagedPluginInspection {
  installPath?: string;
  installPackage?: string;
  installSource?: string;
  status?: unknown;
  version?: string;
}

export function assertDirectoryPathOrMissing(targetPath: string, label: string): void {
  if (!fs.existsSync(targetPath)) return;
  const stat = fs.statSync(targetPath);
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
  readonly rollbackDir?: string;
  readonly shouldRestoreBackup: boolean;
  readonly shouldRestoreConfig: boolean;

  constructor(
    message: string,
    options: ErrorOptions & {
      managedRollbackDir?: string;
      rollbackDir?: string;
      shouldRestoreBackup?: boolean;
      shouldRestoreConfig?: boolean;
    } = {}
  ) {
    super(message, options);
    this.name = "PublishedOpenclawPluginInstallError";
    this.managedRollbackDir = options.managedRollbackDir;
    this.rollbackDir = options.rollbackDir;
    this.shouldRestoreBackup = options.shouldRestoreBackup ?? false;
    this.shouldRestoreConfig = options.shouldRestoreConfig ?? false;
  }
}

export function installPublishedOpenclawPlugin(
  spec: string,
  pluginDir: string,
  configPath: string,
  managedTargetDir: string
): {
  managedRollbackDir?: string;
  rollbackDir?: string;
  rollbackManagedInstall: () => void;
  version?: string;
} {
  const rollbackDir = `${pluginDir}.rollback-${process.pid}-${Date.now()}`;
  const managedRollbackDir = `${managedTargetDir}.rollback-${process.pid}-${Date.now()}`;
  const openclawEnv = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: configPath,
  };
  let activeRollbackDir: string | undefined;
  let activeManagedRollbackDir: string | undefined;
  let managedInstallStarted = false;
  let managedInstallCompleted = false;
  let shouldRestoreBackup = false;

  const readOpenclawHelp = (subcommand: "inspect" | "install"): string =>
    execFileSync("openclaw", ["plugins", subcommand, "--help"], {
      encoding: "utf8",
      env: openclawEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

  const inspectManagedPlugin = (inspectArgs: string[]): ManagedPluginInspection => {
    const inspectOutput = execFileSync("openclaw", inspectArgs, {
      encoding: "utf8",
      env: openclawEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

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
          execFileSync("openclaw", ["plugins", "uninstall", REMNIC_OPENCLAW_PLUGIN_ID, "--force"], {
            env: openclawEnv,
            stdio: ["ignore", "pipe", "pipe"],
          });
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
      execFileSync("openclaw", restoreArgs, {
        env: openclawEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
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
        execFileSync("openclaw", ["plugins", "uninstall", REMNIC_OPENCLAW_PLUGIN_ID, "--force"], {
          env: openclawEnv,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (activeManagedRollbackDir) {
      try {
        fs.rmSync(managedTargetDir, { recursive: true, force: true });
        fs.renameSync(activeManagedRollbackDir, managedTargetDir);
        activeManagedRollbackDir = undefined;
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
    if ((previousSource === "npm" || previousSource === "clawhub") && !installSupportsForce) {
      managedInstallStarted = true;
      execFileSync("openclaw", ["plugins", "uninstall", REMNIC_OPENCLAW_PLUGIN_ID, "--force"], {
        env: openclawEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }

    const packageArg = installSupportsForce ? `npm:${spec}` : spec;
    const installArgs = ["plugins", "install", packageArg];
    if (installSupportsForce) installArgs.push("--force");

    managedInstallStarted = true;
    execFileSync("openclaw", installArgs, {
      env: openclawEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    managedInstallCompleted = true;

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
      rollbackDir: activeRollbackDir,
      shouldRestoreBackup,
      shouldRestoreConfig: managedInstallStarted,
    });
  }
}
