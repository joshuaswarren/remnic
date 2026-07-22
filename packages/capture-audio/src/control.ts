/** Daemon process control: pid file + liveness probing. */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export function writePidFile(pidPath: string, pid: number): void {
  mkdirSync(path.dirname(pidPath), { recursive: true });
  writeFileSync(pidPath, `${pid}\n`, "utf8");
}

export function readPidFile(pidPath: string): number | null {
  if (!existsSync(pidPath)) return null;
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Liveness via signal 0. ESRCH → gone; EPERM → alive but owned by another
 * user (still counts as running).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function removePidFile(pidPath: string): void {
  rmSync(pidPath, { force: true });
}
