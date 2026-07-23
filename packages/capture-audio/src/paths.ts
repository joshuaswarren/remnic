/** Filesystem layout for the capture working directory. */

import os from "node:os";
import path from "node:path";

export interface CapturePaths {
  baseDir: string;
  configPath: string;
  spoolPath: string;
  tokenPath: string;
  pidPath: string;
  logPath: string;
}

/**
 * Root of the capture working directory. `REMNIC_CAPTURE_DIR` overrides
 * the default `~/.remnic/capture` (tests and multi-instance setups point
 * it at a scratch dir). A leading `~` expands to the home directory.
 */
/** Expand a leading `~` / `~/` to the home directory; other paths pass through. */
export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function captureBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.REMNIC_CAPTURE_DIR?.trim();
  if (override) return expandTilde(override);
  return path.join(os.homedir(), ".remnic", "capture");
}

export function capturePaths(baseDir: string = captureBaseDir()): CapturePaths {
  return {
    baseDir,
    configPath: path.join(baseDir, "audio.json"),
    spoolPath: path.join(baseDir, "audio.sqlite"),
    tokenPath: path.join(baseDir, "token"),
    pidPath: path.join(baseDir, "daemon.pid"),
    logPath: path.join(baseDir, "daemon.log"),
  };
}
