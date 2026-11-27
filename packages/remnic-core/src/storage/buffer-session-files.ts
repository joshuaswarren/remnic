import { BufferDrainClaims, type BufferSessionSaveOutcome } from "./buffer-drain-claims.js";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { subtractBufferTurns } from "../buffer-turn-helpers.js";
import { log } from "../logger.js";
import { SecureStoreDecryptError, SecureStoreLockedError } from "../secure-store/secure-fs.js";
import type { BufferEntryState, BufferState, BufferTurn } from "../types.js";

/** The secure-store file I/O the owning StorageManager already provides. */
export interface BufferFileIo {
  read(filePath: string): Promise<string>;
  write(filePath: string, content: string): Promise<void>;
  /** Durable append (drain-claim inboxes). Implementations must persist
   * `content` before resolving; a whole-file read+concat+write rewrite is
   * acceptable — inbox files stay small between drainer compactions. */
  append(filePath: string, content: string): Promise<void>;
}

type FsError = NodeJS.ErrnoException;

function isMissing(err: FsError | null): boolean {
  return err?.code === "ENOENT";
}

function asFsError(err: Error): FsError {
  return err;
}

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

interface SessionFileBody {
  key?: string;
  turns?: BufferTurn[];
  retainedTurns?: BufferTurn[];
  lastExtractionAt?: string | null;
  extractionCount?: number;
}

const ADMISSION_IDEMPOTENCY_FILE = "_admission-idempotency.json";

interface AdmissionIdempotencyFileBody {
  keys?: Record<string, number>;
  order?: string[];
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

export class BufferSessionFiles {
  private dirVerified = false;
  private readonly claimsStore: BufferDrainClaims;

  constructor(
    private readonly stateDir: string,
    private readonly io: BufferFileIo,
  ) {
    this.claimsStore = new BufferDrainClaims(stateDir, io);
  }

  get claims(): BufferDrainClaims {
    return this.claimsStore;
  }

  isClaimed(key: string): boolean {
    return this.claimsStore.isClaimed(key);
  }

  private get dir(): string {
    return path.join(this.stateDir, "buffer");
  }

  private fileFor(key: string): string {
    return path.join(this.dir, bufferSessionFileName(key));
  }

  private admissionMetaPath(): string {
    return path.join(this.dir, ADMISSION_IDEMPOTENCY_FILE);
  }

  private async readAdmissionIdempotency(): Promise<Pick<BufferState, "admissionIdempotency" | "admissionIdempotencyOrder">> {
    let raw: string;
    try {
      raw = await this.io.read(this.admissionMetaPath());
    } catch (err) {
      if (err instanceof Error && isMissing(asFsError(err))) return {};
      throw err;
    }
    try {
      const body: AdmissionIdempotencyFileBody = JSON.parse(raw);
      const rawKeys = body.keys;
      if (rawKeys == null || Array.isArray(rawKeys)) return {};
      // SAFETY: admission file contract — keys is a plain record of finite turn counts.
      const map = Object.create(null) as Record<string, number>;
      for (const [key, value] of Object.entries(rawKeys)) {
        const count = Number(value);
        if (Number.isFinite(count)) map[key] = count;
      }
      const loaded: Pick<BufferState, "admissionIdempotency" | "admissionIdempotencyOrder"> = {
        admissionIdempotency: map,
      };
      if (Array.isArray(body.order) && body.order.length > 0) {
        const order: string[] = [];
        for (const entry of body.order) {
          const slot = String(entry);
          if (Object.hasOwn(map, slot)) order.push(slot);
        }
        if (order.length > 0) loaded.admissionIdempotencyOrder = order;
      }
      return loaded;
    } catch (err) {
      log.warn(
        `buffer: unreadable admission idempotency file; starting empty (${err instanceof Error ? err.message : String(err)})`,
      );
      return {};
    }
  }

  async saveAdmissionIdempotency(state: BufferState): Promise<void> {
    const keys = state.admissionIdempotency;
    if (!keys || Object.keys(keys).length === 0) {
      await this.assertDirSafe();
      try {
        await unlink(this.admissionMetaPath());
      } catch (err) {
        if (!(err instanceof Error) || !isMissing(asFsError(err))) throw err;
      }
      return;
    }
    await this.assertDirSafe();
    const order = state.admissionIdempotencyOrder ?? Object.keys(keys);
    await this.io.write(
      this.admissionMetaPath(),
      JSON.stringify({ keys, order }),
    );
  }

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

  async save(key: string, entry: BufferEntryState): Promise<BufferSessionSaveOutcome> {
    if (this.isClaimed(key)) {
      if (await this.claimsStore.isDrained(key)) {
        const drained = await this.claimsStore.drainedTurns(key);
        const fresh: BufferEntryState = { ...entry, turns: subtractBufferTurns(entry.turns, drained.turns) };
        if (entry.retainedTurns && entry.retainedTurns.length > 0) {
          fresh.retainedTurns = subtractBufferTurns(entry.retainedTurns, drained.retainedTurns);
          if (fresh.retainedTurns.length === 0) delete fresh.retainedTurns;
        }
        await this.assertDirSafe();
        await this.io.write(this.fileFor(key), JSON.stringify({ key, ...fresh }));
        await this.claimsStore.release(key);
        return { status: "saved", drainedTurns: drained };
      }
      await this.claimsStore.mergeIntoClaim(key, entry);
      return { status: "handed_over" };
    }
    await this.assertDirSafe();
    await this.io.write(this.fileFor(key), JSON.stringify({ key, ...entry }));
    return { status: "saved" };
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
      return dirents.filter((d) => d.isFile() && d.name.endsWith(".json")).map((d) => d.name);
    } catch (err) {
      if (err instanceof Error && isMissing(asFsError(err))) return [];
      throw err;
    }
  }

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
        if (err instanceof SecureStoreLockedError || err instanceof SecureStoreDecryptError) throw err;
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
    const admission = await this.readAdmissionIdempotency();
    return {
      turns: def?.turns ?? [],
      lastExtractionAt: def?.lastExtractionAt ?? null,
      extractionCount: def?.extractionCount ?? 0,
      entries: out,
      ...admission,
    };
  }

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
