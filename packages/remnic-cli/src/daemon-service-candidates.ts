import fs from "node:fs";
import path from "node:path";

export const LAUNCHD_LABEL = "ai.remnic.daemon";
export const LEGACY_REMNIC_SERVER_LAUNCHD_LABEL = "ai.remnic.server";
export const LEGACY_LAUNCHD_LABEL = "ai.engram.daemon";
export const LAUNCHD_LABEL_CANDIDATES = [
  LAUNCHD_LABEL,
  LEGACY_REMNIC_SERVER_LAUNCHD_LABEL,
  LEGACY_LAUNCHD_LABEL,
] as const;

export const SYSTEMD_SERVICE = "remnic.service";
export const LEGACY_SYSTEMD_SERVICE = "engram.service";
export const SYSTEMD_SERVICE_CANDIDATES = [SYSTEMD_SERVICE, LEGACY_SYSTEMD_SERVICE] as const;

export function launchdPlistPaths(homeDir: string): string[] {
  return LAUNCHD_LABEL_CANDIDATES.map((label) => (
    path.join(homeDir, "Library", "LaunchAgents", `${label}.plist`)
  ));
}

export function systemdUnitPaths(homeDir: string): string[] {
  return SYSTEMD_SERVICE_CANDIDATES.map((service) => (
    path.join(homeDir, ".config", "systemd", "user", service)
  ));
}

export function anyFileExists(paths: readonly string[]): boolean {
  return paths.some((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function commandNames(command: string): string[] {
  if (process.platform !== "win32") return [command];
  return [command, `${command}.cmd`, `${command}.exe`, `${command}.bat`];
}

export function findCommandOnPath(command: string, pathEnv = process.env.PATH ?? ""): string | undefined {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of commandNames(command)) {
      const candidate = path.join(dir, name);
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        if (process.platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
        return fs.realpathSync(candidate);
      } catch {
        // Try the next PATH candidate.
      }
    }
  }
  return undefined;
}

export function resolveServerBinPath(importMetaDir: string, pathEnv = process.env.PATH ?? ""): string {
  const distPath = path.resolve(importMetaDir, "../../remnic-server/dist/index.js");
  if (fs.existsSync(distPath)) return distPath;

  const pathBin = findCommandOnPath("remnic-server", pathEnv);
  if (pathBin) return pathBin;

  return path.resolve(importMetaDir, "../../remnic-server/src/index.ts");
}
