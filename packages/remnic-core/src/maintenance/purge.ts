/**
 * Operator-facing bulk hard-delete (issue #686 retention-completion).
 *
 * `purgeMemories(opts)` hard-deletes memories that are:
 *   - older than `olderThanMs` (measured against `updated ?? created`), AND
 *   - in the specified tier (`"cold"` or `"all"`), AND
 *   - optionally in `status: "forgotten"` only (when `forgottenOnly` is true)
 *
 * Hard-delete means:
 *   1. Remove the file from disk.
 *   2. Trigger a QMD collection update so the index no longer contains it.
 *   3. Append a purge audit entry to the observation ledger.
 *
 * `dryRun: true` (the default) reports what *would* be deleted without
 * actually removing anything — callers must opt into mutations by
 * setting `dryRun: false`.
 *
 * The CLI surface enforces an explicit `--confirm yes` guard and
 * defaults to `--dry-run` to make accidental data loss impossible.
 */

import path from "node:path";
import { appendFile, mkdir, unlink } from "node:fs/promises";
import type { StorageManager } from "../storage.js";
import type { MemoryFile } from "../types.js";
import type { SearchBackend } from "../search/port.js";

export type PurgeTierFilter = "cold" | "all";

export interface PurgeMemoriesOptions {
  storage: StorageManager;
  /**
   * Only memories whose `updated ?? created` timestamp is older than this
   * value (in milliseconds, Unix epoch) will be candidates.
   */
  olderThanMs: number;
  /**
   * `"cold"` — only memories in the cold tier (files under `.../cold/`).
   * `"all"` — memories in any tier (hot, cold, or archived).
   * Default: `"cold"`.
   */
  tier?: PurgeTierFilter;
  /**
   * When `true`, only memories with `status === "forgotten"` are candidates.
   * Default: `false` (purge by age + tier regardless of status).
   */
  forgottenOnly?: boolean;
  /** When `true` (default), report candidates but do not delete. */
  dryRun?: boolean;
  /**
   * Optional QMD backend. When supplied and `dryRun === false`, a
   * `updateCollection` call is issued after each deletion so the index stays
   * consistent. Pass `undefined` or omit to skip index maintenance (e.g. in
   * tests that don't have a live QMD instance).
   */
  qmd?: SearchBackend;
  /** Hot-tier QMD collection name (default: `"openclaw-engram"`). */
  hotCollection?: string;
  /** Cold-tier QMD collection name (default: `"openclaw-engram-cold"`). */
  coldCollection?: string;
  /** Optional hook for long-lived hosts to clear their live dedupe mirror after purge hash cleanup. */
  afterFactHashRemoval?: () => void | Promise<void>;
  /** Optional shutdown signal forwarded to QMD collection refreshes. */
  signal?: AbortSignal;
  /** Override clock for tests. */
  now?: () => Date;
}

export interface PurgeCandidate {
  id: string;
  path: string;
  tier: "hot" | "cold" | "archive";
  status: string;
  updatedOrCreated: string;
  ageMs: number;
}

export interface PurgeMemoriesResult {
  dryRun: boolean;
  tier: PurgeTierFilter;
  olderThanMs: number;
  candidates: PurgeCandidate[];
  purgedCount: number;
  alreadyAbsentCount: number;
  errorCount: number;
  errors: Array<{ id: string; path: string; error: string }>;
}

function hasErrorCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === code;
}

function resolveTimestamp(memory: MemoryFile): string {
  const fm = memory.frontmatter as unknown as Record<string, unknown>;
  const updated = typeof fm.updated === "string" ? (fm.updated as string) : "";
  const created = typeof fm.created === "string" ? (fm.created as string) : "";
  return updated.length > 0 ? updated : created;
}

async function logPurgeAudit(
  storage: StorageManager,
  candidates: PurgeCandidate[],
  now: Date,
  event: "PURGE_DELETE_INTENT" | "PURGE_HARD_DELETE" | "PURGE_ALREADY_ABSENT" = "PURGE_HARD_DELETE",
): Promise<void> {
  if (candidates.length === 0) return;
  const ledgerDir = path.join(storage.dir, "state", "observation-ledger");
  await mkdir(ledgerDir, { recursive: true });
  const ledgerPath = path.join(ledgerDir, "purge-audit.jsonl");
  const entries = candidates.map((c) =>
    JSON.stringify({
      event,
      timestamp: now.toISOString(),
      memoryId: c.id,
      path: c.path,
      tier: c.tier,
      status: c.status,
      updatedOrCreated: c.updatedOrCreated,
    }),
  );
  if (entries.length > 0) {
    await appendFile(ledgerPath, `${entries.join("\n")}\n`, "utf-8");
  }
}

export async function purgeMemories(
  options: PurgeMemoriesOptions,
): Promise<PurgeMemoriesResult> {
  const {
    storage,
    olderThanMs,
    tier = "cold",
    forgottenOnly = false,
    dryRun = true,
    qmd,
    hotCollection = "openclaw-engram",
    coldCollection = "openclaw-engram-cold",
  } = options;

  if (!Number.isFinite(olderThanMs) || olderThanMs <= 0) {
    throw new Error("olderThanMs must be a finite positive number");
  }

  const now = (options.now ?? (() => new Date()))();
  const nowMs = now.getTime();

  // Collect all memories from applicable tiers
  const [hotMemories, coldMemories, archivedMemories] = await Promise.all([
    tier === "all" ? storage.readAllMemories() : Promise.resolve([]),
    storage.readAllColdMemories(),
    tier === "all" ? storage.readArchivedMemories() : Promise.resolve([]),
  ]);

  const poolEntries: Array<{ memory: MemoryFile; resolvedTier: "hot" | "cold" | "archive" }> = [];

  if (tier === "all") {
    for (const m of hotMemories) {
      poolEntries.push({ memory: m, resolvedTier: "hot" });
    }
    for (const m of archivedMemories) {
      poolEntries.push({ memory: m, resolvedTier: "archive" });
    }
  }
  for (const m of coldMemories) {
    poolEntries.push({ memory: m, resolvedTier: "cold" });
  }

  // Build candidate list
  const candidates: PurgeCandidate[] = [];
  const candidateMemoriesById = new Map<string, MemoryFile>();
  for (const { memory, resolvedTier } of poolEntries) {
    const ts = resolveTimestamp(memory);
    if (ts.length === 0) continue;

    const tsMs = Date.parse(ts);
    if (!Number.isFinite(tsMs)) continue;

    const ageMs = nowMs - tsMs;
    if (ageMs < olderThanMs) continue;

    const fm = memory.frontmatter as unknown as Record<string, unknown>;
    const status: string =
      typeof fm.status === "string" ? (fm.status as string) : "active";

    if (forgottenOnly && status !== "forgotten") continue;

    candidates.push({
      id: memory.frontmatter.id,
      path: memory.path,
      tier: resolvedTier,
      status,
      updatedOrCreated: ts,
      ageMs,
    });
    candidateMemoriesById.set(memory.frontmatter.id, memory);
  }

  if (dryRun) {
    return {
      dryRun: true,
      tier,
      olderThanMs,
      candidates,
      purgedCount: 0,
      alreadyAbsentCount: 0,
      errorCount: 0,
      errors: [],
    };
  }

  // Hard-delete phase
  const errors: Array<{ id: string; path: string; error: string }> = [];
  try {
    await logPurgeAudit(storage, candidates, now, "PURGE_DELETE_INTENT");
  } catch (auditErr) {
    errors.push({
      id: "(purge-audit)",
      path: path.join(storage.dir, "state", "observation-ledger", "purge-audit.jsonl"),
      error: auditErr instanceof Error ? auditErr.message : String(auditErr),
    });
  }

  const actuallyPurged: PurgeCandidate[] = [];
  const alreadyAbsent: PurgeCandidate[] = [];
  const collectionsToUpdate = new Set<string>();
  const addCollectionForCandidate = (candidate: PurgeCandidate) => {
    if (candidate.tier === "cold") {
      collectionsToUpdate.add(coldCollection);
    } else if (candidate.tier === "hot") {
      collectionsToUpdate.add(hotCollection);
    }
  };

  for (const candidate of candidates) {
    try {
      await unlink(candidate.path);
      actuallyPurged.push(candidate);
      addCollectionForCandidate(candidate);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // ENOENT is fine — already gone
      if (hasErrorCode(err, "ENOENT")) {
        alreadyAbsent.push(candidate);
        addCollectionForCandidate(candidate);
      } else {
        errors.push({ id: candidate.id, path: candidate.path, error: message });
      }
    }
  }

  const recordPostDeleteAudit = async (
    purgedCandidates: PurgeCandidate[],
    event: "PURGE_HARD_DELETE" | "PURGE_ALREADY_ABSENT",
  ) => {
    try {
      await logPurgeAudit(storage, purgedCandidates, now, event);
    } catch (auditErr) {
      errors.push({
        id: "(purge-audit)",
        path: path.join(storage.dir, "state", "observation-ledger", "purge-audit.jsonl"),
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }
  };
  await recordPostDeleteAudit(actuallyPurged, "PURGE_HARD_DELETE");
  await recordPostDeleteAudit(alreadyAbsent, "PURGE_ALREADY_ABSENT");

  const resolvedPurges = [...actuallyPurged, ...alreadyAbsent];

  const invalidateTierCaches = (
    storage as unknown as {
      invalidateMemoryCachesForTiers?: (tiers: Iterable<"hot" | "cold" | "archive">) => void;
    }
  ).invalidateMemoryCachesForTiers;
  if (typeof invalidateTierCaches === "function") {
    invalidateTierCaches.call(storage, new Set(resolvedPurges.map((candidate) => candidate.tier)));
  } else if (typeof (storage as unknown as { invalidateAllMemoriesCacheForDir?: () => void }).invalidateAllMemoriesCacheForDir === "function") {
    (storage as unknown as { invalidateAllMemoriesCacheForDir: () => void }).invalidateAllMemoriesCacheForDir();
  }

  // Update QMD index for affected collections
  if (qmd) {
    for (const collection of collectionsToUpdate) {
      try {
        if (typeof qmd.updateCollectionStrict === "function") {
          await qmd.updateCollectionStrict(collection, { signal: options.signal });
        } else {
          await qmd.updateCollection(collection, { signal: options.signal });
        }
      } catch (indexErr) {
        // Non-fatal — operator can re-index manually
        errors.push({
          id: "(qmd-update)",
          path: collection,
          error: indexErr instanceof Error ? indexErr.message : String(indexErr),
        });
      }
    }
  }

  const purgedFactMemories = resolvedPurges
    .map((candidate) => candidateMemoriesById.get(candidate.id))
    .filter((memory): memory is MemoryFile => memory?.frontmatter.category === "fact");
  if (purgedFactMemories.length > 0) {
    const removeFactHashes = (
      storage as unknown as {
        removeFactContentHashesForMemories?: (memories: MemoryFile[]) => Promise<void>;
      }
    ).removeFactContentHashesForMemories;
    if (typeof removeFactHashes === "function") {
      try {
        await removeFactHashes.call(storage, purgedFactMemories);
        await options.afterFactHashRemoval?.();
      } catch (hashErr) {
        errors.push({
          id: "(fact-hash-index)",
          path: path.join(storage.dir, "state", "fact-hashes.txt"),
          error: hashErr instanceof Error ? hashErr.message : String(hashErr),
        });
      }
    }
  }

  return {
    dryRun: false,
    tier,
    olderThanMs,
    candidates,
    purgedCount: actuallyPurged.length,
    alreadyAbsentCount: alreadyAbsent.length,
    errorCount: errors.length,
    errors,
  };
}
