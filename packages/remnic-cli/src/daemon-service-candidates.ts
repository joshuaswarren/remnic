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

function isRunnableNodeScript(filePath: string): boolean {
  try {
    const text = fs.readFileSync(filePath, "utf8").slice(0, 4096);
    const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
    if (/^#!.*\bnode\b/.test(firstLine)) return true;
    if (firstLine.startsWith("#!")) return false;
    if (/\.(?:cjs|mjs|js)$/i.test(filePath)) return true;
    return /\bimport\s+/.test(text) || /\bexport\s+/.test(text) || /\brequire\s*\(/.test(text);
  } catch {
    return false;
  }
}

function resolveShimNodeScript(filePath: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8").slice(0, 16_384);
  } catch {
    return undefined;
  }

  const basedir = path.dirname(filePath);
  const jsReferencePattern = /"([^"]+\.js)"|'([^']+\.js)'|([^\s"'`]+\.js)/g;
  for (const match of text.matchAll(jsReferencePattern)) {
    const raw = match[1] ?? match[2] ?? match[3];
    if (!raw) continue;
    const candidate = raw
      .replaceAll("${basedir}", basedir)
      .replaceAll("$basedir", basedir)
      .replaceAll("\\ ", " ");
    const resolved = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(basedir, candidate);
    try {
      if (fs.statSync(resolved).isFile() && isRunnableNodeScript(resolved)) {
        return fs.realpathSync(resolved);
      }
    } catch {
      // Try the next JavaScript reference in the shim.
    }
  }
  return undefined;
}

function resolveRunnableNodeScript(filePath: string): string | undefined {
  const realPath = fs.realpathSync(filePath);
  if (isRunnableNodeScript(realPath)) return realPath;
  return resolveShimNodeScript(realPath);
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
        const runnable = resolveRunnableNodeScript(candidate);
        if (runnable) return runnable;
      } catch {
        // Try the next PATH candidate.
      }
    }
  }
  return undefined;
}

export function resolveServerBinPath(importMetaDir: string, pathEnv = process.env.PATH ?? ""): string {
  const binPath = path.resolve(importMetaDir, "../../remnic-server/bin/remnic-server.js");
  const distPath = path.resolve(importMetaDir, "../../remnic-server/dist/index.js");
  if (fs.existsSync(binPath) && fs.existsSync(distPath)) return binPath;
  if (fs.existsSync(distPath)) return distPath;

  const pathBin = findCommandOnPath("remnic-server", pathEnv);
  if (pathBin) {
    const requiredPath = serverBinWrapperRequiredPath(pathBin);
    if (!requiredPath || fs.existsSync(requiredPath)) return pathBin;
  }

  return path.resolve(importMetaDir, "../../remnic-server/src/index.ts");
}

export function serverBinWrapperRequiredPath(candidate: string): string | undefined {
  const filename = path.basename(candidate);
  if (filename !== "remnic-server.js" && filename !== "engram-server.js") return undefined;
  const binDir = path.dirname(candidate);
  if (path.basename(binDir) !== "bin") return undefined;
  return path.join(path.dirname(binDir), "dist", "index.js");
}
