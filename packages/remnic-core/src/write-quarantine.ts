/**
 * Dead-letter quarantine for writes rejected by the namespace write-ACL
 * (issue #1888).
 *
 * When `observe` / `memory_store` / `suggestion_submit` fail namespace
 * authorization, the payload used to be dropped with no recoverable copy: a
 * client configured with a namespace that matches no policy (and is not the
 * default/shared namespace) had every write in the window silently destroyed.
 * The ACL rejection is CORRECT and stays fail-closed; this store only
 * preserves the payload so it can be replayed after the config is fixed,
 * following the AGENTS.md "reject loudly but never destroy state" posture
 * (patterns 14/42).
 *
 * Records live OUTSIDE any memory namespace at
 * `<memoryDir>/state/quarantine/<principalSafe>/<timestamp>-<id>.json`, keyed
 * by the encoded principal, and are bounded per principal by count and age.
 * Every path is resolved from `memoryDir` through `resolveSafeStoragePath`, so
 * a symlinked `state`/`quarantine` cannot redirect writes outside the memory
 * directory. The store never re-routes a payload into a writable namespace.
 */

import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { encodeStoragePathSegment, isPathInsideStorageRoot, resolveSafeStoragePath } from "./storage-paths.js";

export type QuarantineOperation = "observe" | "memory_store" | "suggestion_submit";

export interface QuarantineEntryInput {
  operation: QuarantineOperation;
  /** Authenticated principal the write was attributed to, if any. */
  principal: string | undefined;
  /** Namespace the caller attempted to write and was denied. */
  attemptedNamespace: string;
  /** The original request payload, preserved verbatim for replay. */
  payload: unknown;
  /** ISO timestamp; defaults to now. Injectable for deterministic tests. */
  timestamp?: string;
}

export interface QuarantinedRecord {
  operation: QuarantineOperation;
  principal: string | null;
  attemptedNamespace: string;
  timestamp: string;
  payload: unknown;
}

/** A quarantined record paired with the absolute on-disk path it was read from. */
export interface QuarantineEntry {
  record: QuarantinedRecord;
  path: string;
}

export interface QuarantineCaps {
  /** Keep at most this many records per principal (newest win). */
  maxEntriesPerPrincipal: number;
  /** Drop records older than this many milliseconds. */
  maxAgeMs: number;
}

export const DEFAULT_QUARANTINE_CAPS: QuarantineCaps = {
  maxEntriesPerPrincipal: 500,
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
};

const QUARANTINE_DIRNAME = "quarantine";

function validateCaps(caps: QuarantineCaps): void {
  if (!Number.isInteger(caps.maxEntriesPerPrincipal) || caps.maxEntriesPerPrincipal < 1) {
    throw new Error(
      `WriteQuarantineStore: maxEntriesPerPrincipal must be a positive integer (got ${caps.maxEntriesPerPrincipal})`
    );
  }
  if (!Number.isFinite(caps.maxAgeMs) || caps.maxAgeMs <= 0) {
    throw new Error(
      `WriteQuarantineStore: maxAgeMs must be a positive finite number of milliseconds (got ${caps.maxAgeMs})`
    );
  }
}

function isQuarantinedRecord(value: unknown): value is QuarantinedRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    (record.operation === "observe" ||
      record.operation === "memory_store" ||
      record.operation === "suggestion_submit") &&
    (record.principal === null || typeof record.principal === "string") &&
    typeof record.attemptedNamespace === "string" &&
    typeof record.timestamp === "string" &&
    "payload" in record
  );
}

export class WriteQuarantineStore {
  private readonly memoryDir: string;

  constructor(
    memoryDir: string,
    private readonly caps: QuarantineCaps = DEFAULT_QUARANTINE_CAPS
  ) {
    validateCaps(caps);
    this.memoryDir = path.resolve(memoryDir);
  }

  /** Absolute quarantine root (`<memoryDir>/state/quarantine`). */
  get root(): string {
    return path.join(this.memoryDir, "state", QUARANTINE_DIRNAME);
  }

  /**
   * Resolve a path under the quarantine root, checked for containment and
   * symlink traversal from `memoryDir` down — so a symlinked `state` or
   * `quarantine` component that escapes the memory directory is rejected.
   */
  private safeDir(...segments: string[]): Promise<string> {
    return resolveSafeStoragePath(this.memoryDir, "state", QUARANTINE_DIRNAME, ...segments);
  }

  /**
   * Park a rejected write. Returns the absolute path of the record written.
   * Prunes the principal's bucket to the configured caps afterward.
   */
  async quarantine(input: QuarantineEntryInput): Promise<string> {
    const timestamp = input.timestamp ?? new Date().toISOString();
    const record: QuarantinedRecord = {
      operation: input.operation,
      principal: input.principal ?? null,
      attemptedNamespace: input.attemptedNamespace,
      timestamp,
      payload: input.payload,
    };
    const principalSegment = encodeStoragePathSegment(input.principal ?? "unknown");
    const fileName = `${timestamp.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.json`;

    const dir = await this.safeDir(principalSegment);
    await mkdir(dir, { recursive: true });
    // The temp write uses the exclusive `wx` flag so a pre-planted symlink at
    // the temp name can never be followed (O_EXCL); rename is atomic (rule 42).
    const finalPath = await this.safeDir(principalSegment, fileName);
    const tmpPath = await this.safeDir(principalSegment, `${fileName}.tmp`);
    await writeFile(tmpPath, JSON.stringify(record, null, 2), { encoding: "utf8", flag: "wx" });
    await rename(tmpPath, finalPath);

    await this.pruneDir(dir);
    return finalPath;
  }

  /**
   * All valid, non-expired quarantined records across every principal, oldest
   * first, each paired with its absolute on-disk path. Expired records are
   * deleted on read (lazy GC), so an inactive principal bucket with no
   * follow-up write is still bounded by age.
   */
  async entries(): Promise<QuarantineEntry[]> {
    const now = Date.now();
    const entries: QuarantineEntry[] = [];
    for (const dir of await this.principalDirs()) {
      for (const file of await this.entryFiles(dir)) {
        const info = await stat(file).catch(() => null);
        if (!info) continue;
        if (now - info.mtimeMs > this.caps.maxAgeMs) {
          await rm(file, { force: true }).catch(() => {});
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readFile(file, "utf8"));
        } catch {
          continue;
        }
        if (isQuarantinedRecord(parsed)) entries.push({ record: parsed, path: file });
      }
    }
    entries.sort((a, b) => {
      const at = a.record.timestamp;
      const bt = b.record.timestamp;
      return at < bt ? -1 : at > bt ? 1 : 0;
    });
    return entries;
  }

  /** As {@link entries} but projected to records only (backward-compatible view). */
  async list(): Promise<QuarantinedRecord[]> {
    return (await this.entries()).map((entry) => entry.record);
  }

  /**
   * Delete one quarantined entry by its absolute on-disk path (as returned by
   * {@link entries}). The path MUST resolve inside the quarantine root, mirroring
   * the store's containment posture; a path outside the root — or one already
   * absent — removes nothing. Returns true only when a file was actually deleted.
   */
  async removeEntry(entryPath: string): Promise<boolean> {
    const abs = path.resolve(entryPath);
    if (!isPathInsideStorageRoot(path.resolve(this.root), abs)) return false;
    try {
      await rm(abs, { force: false });
      return true;
    } catch (err) {
      const errno = err as NodeJS.ErrnoException;
      if (errno?.code === "ENOENT") return false;
      throw err;
    }
  }

  /** Total valid, non-expired quarantined record count across every principal. */
  async count(): Promise<number> {
    return (await this.list()).length;
  }

  /** lstat (no symlink follow): true only for a real directory. */
  private async isRealDir(dir: string): Promise<boolean> {
    const info = await lstat(dir).catch(() => null);
    return info?.isDirectory() === true;
  }

  private async principalDirs(): Promise<string[]> {
    // safeDir() rejects a symlinked/containment-escaping root — let that
    // propagate instead of masquerading as an empty store.
    const root = await this.safeDir();
    if (!(await this.isRealDir(root))) return [];
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (err) {
      // Root vanished mid-scan → legitimately empty. Any other failure
      // (permissions, IO) is a genuine inspection failure and must surface.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw err;
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name))
      .sort();
  }

  private async entryFiles(dir: string): Promise<string[]> {
    if (!(await this.isRealDir(dir))) return [];
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw err;
    }
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  }

  private async pruneDir(dir: string): Promise<void> {
    const files = await this.entryFiles(dir);
    const now = Date.now();
    const survivors: Array<{ path: string; mtimeMs: number }> = [];
    for (const file of files) {
      const info = await stat(file).catch(() => null);
      if (!info) continue;
      if (now - info.mtimeMs > this.caps.maxAgeMs) {
        await rm(file, { force: true }).catch(() => {});
        continue;
      }
      survivors.push({ path: file, mtimeMs: info.mtimeMs });
    }
    const surplus = survivors.length - this.caps.maxEntriesPerPrincipal;
    if (surplus <= 0) return;
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const victim of survivors.slice(0, surplus)) {
      await rm(victim.path, { force: true }).catch(() => {});
    }
  }
}
