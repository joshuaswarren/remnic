/**
 * Daemon process control: an atomic, identity-bearing pid file plus liveness
 * probing.
 *
 * The pid file is JSON `{ pid, instanceId, startedAtIso, host, port }` written
 * via a temp-file + rename so a reader never sees a partial write, and reads
 * are tolerant of a concurrent delete. `instanceId` (the spool instance id)
 * lets `stop`/`status` confirm — over the authenticated health endpoint — that
 * the recorded pid really is our daemon before signalling it, which guards
 * against PID reuse. Removal is owner-checked so a late shutdown can't delete a
 * newer daemon's control file.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

export interface PidRecord {
  pid: number;
  /** Daemon instance id (spool instance_id) for cross-process identity; null when unknown. */
  instanceId: string | null;
  /** ISO timestamp the record was written. */
  startedAtIso: string;
  /** Effective bound host, when known (so status/stop reach the daemon the CLI actually started). */
  host: string | null;
  /** Effective bound port, when known. */
  port: number | null;
}

export interface PidWriteOptions {
  instanceId?: string | null;
  startedAtIso?: string;
  host?: string | null;
  port?: number | null;
}

/** Atomically write the pid record (temp file + rename) — no partial reads. */
export function writePidFile(pidPath: string, pid: number, options: PidWriteOptions = {}): void {
  mkdirSync(path.dirname(pidPath), { recursive: true });
  const record: PidRecord = {
    pid,
    instanceId: options.instanceId ?? null,
    startedAtIso: options.startedAtIso ?? new Date().toISOString(),
    host: options.host ?? null,
    port: options.port ?? null,
  };
  const tmp = `${pidPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, "utf8");
  renameSync(tmp, pidPath);
}

/** Read the pid record; a missing file or a partial/concurrent write returns null. */
export function readPidRecord(pidPath: string): PidRecord | null {
  let text: string;
  try {
    text = readFileSync(pidPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const pid = typeof record.pid === "number" ? record.pid : Number.NaN;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const port =
    typeof record.port === "number" && Number.isInteger(record.port) && record.port > 0 ? record.port : null;
  return {
    pid,
    instanceId: typeof record.instanceId === "string" ? record.instanceId : null,
    startedAtIso: typeof record.startedAtIso === "string" ? record.startedAtIso : "",
    host: typeof record.host === "string" && record.host !== "" ? record.host : null,
    port,
  };
}

/** Convenience accessor: the recorded pid, or null. */
export function readPidFile(pidPath: string): number | null {
  return readPidRecord(pidPath)?.pid ?? null;
}

/** Liveness via signal 0. ESRCH → gone; EPERM → alive but owned by another user. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Remove the pid file unconditionally (stale reclaim). */
export function removePidFile(pidPath: string): void {
  rmSync(pidPath, { force: true });
}

/**
 * Remove the pid file only when it still records `pid`. Prevents a late
 * shutdown or `stop` from deleting a NEWER daemon's control file after a
 * restart or PID reuse.
 */
export function removePidFileIfOwner(pidPath: string, pid: number): void {
  const record = readPidRecord(pidPath);
  if (record && record.pid === pid) rmSync(pidPath, { force: true });
}
