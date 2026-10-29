import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { log } from "../logger.js";
import { SecureStoreLockedError } from "../secure-store/secure-fs.js";
import type { BufferEntryState, BufferState, BufferTurn } from "../types.js";

/** The secure-store file I/O the owning StorageManager already provides. */
export interface BufferFileIo {
  read(filePath: string): Promise<string>;
  write(filePath: string, content: string): Promise<void>;
}

type FsError = NodeJS.ErrnoException;

function isMissing(err: FsError | null): boolean {
  return err?.code === "ENOENT";
}

function asFsError(err: Error): FsError {
  return err;
}

/**
 * Case-independent, collision-free file name for a buffer key: the lowercase
 * hex SHA-256 of the key under a fixed prefix. Hex has no case and no path
 * characters, so `Session-A` and `session-a` get different names even on
 * case-insensitive filesystems, every key (short or long) lives in the same
 * naming domain, and the key itself is stored inside the file (loading never
 * inverts the hash).
 */
export function bufferSessionFileName(key: string): string {
  return `s-${createHash("sha256").update(key).digest("hex")}.json`;
}

/** Flatten a legacy BufferState into per-session entries (top-level fields
 * are the legacy mirror of the "default" entry). */
export function legacyStateToEntries(state: BufferState): Map<string, BufferEntryState> {
  const entries = new Map<string, BufferEntryState>();
  for (const [key, value] of Object.entries(state.entries ?? {})) {
    if (value && Array.isArray(value.turns)) entries.set(key, value);
  }
  if (!entries.has("default")) {
    entries.set("default", {
      turns: Array.isArray(state.turns) ? state.turns : [],
      lastExtractionAt: state.lastExtractionAt ?? null,
      extractionCount: Number.isFinite(state.extractionCount) ? state.extractionCount : 0,
    });
  }
  return entries;
}

/** What a per-session file contains once parsed (written only by this module). */
interface SessionFileBody {
  key?: string;
  turns?: BufferTurn[];
  retainedTurns?: BufferTurn[];
  lastExtractionAt?: string | null;
  extractionCount?: number;
}

function entryFromBody(body: SessionFileBody): { key: string; entry: BufferEntryState } | null {
  if (!body || !Array.isArray(body.turns) || (body.key?.length ?? 0) === 0) return null;
  const entry: BufferEntryState = {
    turns: body.turns,
    lastExtractionAt: body.lastExtractionAt ?? null,
    extractionCount: Number.isFinite(body.extractionCount) ? Number(body.extractionCount) : 0,
  };
  if (Array.isArray(body.retainedTurns)) entry.retainedTurns = body.retainedTurns;
  return { key: String(body.key), entry };
}

/**
 * One file per buffer session under `<stateDir>/buffer/`, so the observe hot
 * path persists only the session that changed. All writes happen under
 * SmartBuffer's serialized mutation chain (one writer per process).
 */
export class BufferSessionFiles {
  private dirVerified = false;

  constructor(
    private readonly stateDir: string,
    private readonly io: BufferFileIo,
  ) {}

  private get dir(): string {
    return path.join(this.stateDir, "buffer");
  }

  private fileFor(key: string): string {
    return path.join(this.dir, bufferSessionFileName(key));
  }

  /**
   * Refuse a symlinked buffer directory: following it would send buffered
   * conversation data (and deletions) outside the memory root. One lstat of
   * one directory, cached after it passes, so the observe path pays nothing
   * per write; the cache is dropped on any failure.
   */
  private async assertDirSafe(): Promise<void> {
    if (this.dirVerified) return;
    let stat: Stats | null = null;
    try {
      stat = await lstat(this.dir);
    } catch (err) {
      if (!(err instanceof Error) || !isMissing(asFsError(err))) throw err;
    }
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
      throw new Error(`buffer session directory must be a real directory, not a symlink or file: ${this.dir}`);
    }
    this.dirVerified = stat !== null;
  }

  /** Persist ONE session atomically. Compact JSON: machine-read state, and
   * pretty-printing a large buffer costs CPU and bytes on every observe. */
  async save(key: string, entry: BufferEntryState): Promise<void> {
    await this.assertDirSafe();
    await this.io.write(this.fileFor(key), JSON.stringify({ key, ...entry }));
  }

  /** Remove one session's file. Idempotent: an absent file is fine. */
  async remove(key: string): Promise<void> {
    await this.assertDirSafe();
    try {
      await unlink(this.fileFor(key));
    } catch (err) {
      if (!(err instanceof Error) || !isMissing(asFsError(err))) throw err;
    }
  }

  private async listFiles(): Promise<string[]> {
    await this.assertDirSafe();
    try {
      const dirents = await readdir(this.dir, { withFileTypes: true });
      // Regular files only: a symlink inside the directory is never followed.
      return dirents.filter((d) => d.isFile() && d.name.endsWith(".json")).map((d) => d.name);
    } catch (err) {
      if (err instanceof Error && isMissing(asFsError(err))) return [];
      throw err;
    }
  }

  /** Read every per-session file. Corrupt files are skipped (and logged) so
   * one bad file cannot nuke the other sessions' buffered turns. */
  private async readAll(): Promise<{ entries: Map<string, BufferEntryState>; fileCount: number }> {
    const names = await this.listFiles();
    const entries = new Map<string, BufferEntryState>();
    for (const name of names) {
      try {
        const body: SessionFileBody = JSON.parse(await this.io.read(path.join(this.dir, name)));
        const parsed = entryFromBody(body);
        if (!parsed) throw new Error("invalid buffer session file shape");
        if (entries.has(parsed.key)) {
          log.warn(`buffer: duplicate session file for key ${parsed.key} (${name}); keeping the first`);
          continue;
        }
        entries.set(parsed.key, parsed.entry);
      } catch (err) {
        if (err instanceof SecureStoreLockedError) throw err;
        log.warn(`buffer: skipping unreadable per-session buffer file ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { entries, fileCount: names.length };
  }

  /**
   * Read the legacy single-file buffer.json for migration. Null when absent,
   * or unreadable while session files exist (they are authoritative; a
   * corrupt leftover must not block startup). With no session files a corrupt
   * legacy file THROWS, preserving the old contract so callers can reset it.
   */
  private async readLegacy(hasSessionFiles: boolean): Promise<BufferState | null> {
    let raw: string;
    try {
      raw = await this.io.read(path.join(this.stateDir, "buffer.json"));
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (err instanceof Error && isMissing(asFsError(err))) return null;
      throw err;
    }
    try {
      const legacy: BufferState = JSON.parse(raw);
      return legacy;
    } catch (err) {
      if (!hasSessionFiles) throw err;
      log.warn(
        `buffer: legacy buffer.json is unreadable but per-session buffer files exist; ` +
          `ignoring the legacy file (${err instanceof Error ? err.message : String(err)})`,
      );
      return null;
    }
  }

  /**
   * Load the whole buffer, migrating a legacy buffer.json once. A per-session
   * file that parsed wins over the legacy snapshot (a crash mid-migration
   * leaves exactly that pair); legacy entries without a usable file are
   * written out, then the legacy file is retired. Both steps are idempotent.
   */
  async load(): Promise<BufferState> {
    const { entries, fileCount } = await this.readAll();
    const legacy = await this.readLegacy(fileCount > 0);
    if (legacy !== null) {
      for (const [key, entry] of legacyStateToEntries(legacy)) {
        if (entries.has(key)) continue;
        entries.set(key, entry);
        await this.save(key, entry);
      }
      try {
        await unlink(path.join(this.stateDir, "buffer.json"));
      } catch (err) {
        if (!(err instanceof Error) || !isMissing(asFsError(err))) throw err;
      }
    }
    const out: NonNullable<BufferState["entries"]> = Object.create(null);
    for (const [key, entry] of entries) out[key] = entry;
    const def = entries.get("default");
    return {
      turns: def?.turns ?? [],
      lastExtractionAt: def?.lastExtractionAt ?? null,
      extractionCount: def?.extractionCount ?? 0,
      entries: out,
    };
  }

  /**
   * Reconcile the files with a WHOLE buffer state: write every entry, then
   * delete files for keys no longer present. Writes first, deletes last: a
   * crash leaves stale extra files (removed by the next reconcile) but never
   * loses sessions the state says exist. Not on the observe hot path.
   */
  async reconcile(state: BufferState): Promise<void> {
    const entries = legacyStateToEntries(state);
    const existing = await this.listFiles();
    for (const [key, entry] of entries) await this.save(key, entry);
    const live = new Set([...entries.keys()].map((key) => bufferSessionFileName(key)));
    for (const name of existing) {
      if (live.has(name)) continue;
      try {
        await unlink(path.join(this.dir, name));
      } catch (err) {
        if (!(err instanceof Error) || !isMissing(asFsError(err))) throw err;
      }
    }
  }
}
