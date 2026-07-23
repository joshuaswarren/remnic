/**
 * Meeting memory-generation SEAM (issue #1900 — engine/memory decouple).
 *
 * Engine-layer boundary between the deterministic meeting builder and the
 * memory-generation layer. `MeetingsBuilder` (detect/fuse/store/build) depends
 * ONLY on `MeetingMemoryGenerator` declared here — never on `memory-gen.ts` — so
 * the deterministic engine carries zero dependency on episode/fact generation
 * and ships in its own scope-budgeted PR. The concrete generator lives in
 * `memory-gen.ts` behind `createMeetingMemoryGenerator`, which implements this
 * interface by driving the existing episode/fact/retract logic.
 */

import type { MemoryWriteResult } from "../index.js";
import type { ImportanceScore, MemoryStatus } from "../types.js";
import type { SealedMemoryEnvelope } from "../write-envelope.js";
import type { MeetingRecord } from "./types.js";

/**
 * Narrow writer interface satisfied by `StorageManager` — the same sealed
 * write entry point the wearables generator uses, so meeting memories inherit
 * encrypted-at-rest + atomic write + dedup without this module knowing the key.
 */
export interface MeetingMemoryWriter {
  writeSealedMemory(
    envelope: SealedMemoryEnvelope,
    extras: {
      importance?: ImportanceScore;
      contentHashSource?: string;
      status?: MemoryStatus;
      memoryKind?: "episode" | "note" | "box" | "dream" | "procedural";
    },
  ): Promise<MemoryWriteResult>;
  /**
   * True when an active/pending memory whose frontmatter `source` equals
   * `source` already carries this exact content. Meeting memories are episodes
   * (`moment`) and decisions/commitments (`decision`/`commitment`) — categories
   * the storage fact-hash index does NOT cover — so idempotency is a
   * source-scoped content scan, mirroring the wearables writer, NOT
   * `hasFactContentHash` (fact-only; always false here → duplicates on rebuild).
   */
  hasMemoryFromSource(source: string, content: string): Promise<boolean>;
  /**
   * Retire (invalidate) every memory whose frontmatter `source` equals `source`.
   * Returns the count retired. Used to reconcile away a removed meeting's
   * episode/summary memories so recall never surfaces a meeting `show` can't load.
   */
  retireMemoriesFromSource(source: string): Promise<number>;
}

/** Result of generating episode memories for a day's meetings. */
export interface MeetingEpisodeGenResult {
  /** Episodes newly written. */
  written: number;
  /** Episodes skipped because an identical one already existed. */
  skipped: number;
}

/** Day-level aggregate of the trust-gated summary/fact layer across records. */
export interface MeetingsDayFactGenResult {
  /** True when the LLM extractor ran for at least one record. */
  llmInvoked: boolean;
  /** Facts written active. */
  active: number;
  /** Facts queued for review (pending_review). */
  review: number;
  /** Candidates/summaries dropped below the trust bar or judge-rejected. */
  dropped: number;
  /** Candidates/summaries skipped because an identical memory already existed. */
  skipped: number;
  /** Count of records whose summary memory was written. */
  summariesWritten: number;
}

/**
 * Outcome the memory generator returns to the builder after a day's records are
 * built and persisted. Counts feed the day-build summary; `reindexNeeded` folds
 * the "reindex when new episodes/facts were written even if no record changed"
 * rule so the builder never reaches into the memory layer to decide it.
 */
export interface MeetingMemoryOutcome {
  /** Episode-memory counts, present only when records were built. */
  episodes?: MeetingEpisodeGenResult;
  /** Trust-gated summary/fact counts, present only when summary deps ran. */
  facts?: MeetingsDayFactGenResult;
  /** True when newly written memories require an isolated reindex. */
  reindexNeeded: boolean;
  /** Non-fatal warnings raised while generating memories. */
  warnings: readonly string[];
}

/**
 * Seam the deterministic builder depends on. Invoked once per day build after
 * the record-store writes with, for the day:
 *   - `built`       — every record composed this build (new, updated, unchanged).
 *   - `removedIds`  — stale ids the rebuild reconciled away (retract memories).
 *   - `unchangedIds`— built ids whose stored `contentHash` was IDENTICAL this
 *                     build (nothing rewritten). The generator SKIPS all
 *                     episode/summary/fact work for these: an idempotent rebuild
 *                     must not re-invoke the LLM or duplicate memories.
 *   - `updatedIds`  — built ids that existed before AND were rewritten this build
 *                     (same id, changed `contentHash`). The generator REFRESHES
 *                     them: retract the stale episode/summary memories for that
 *                     source, then regenerate from the new record.
 * Ids not in `unchangedIds` or `updatedIds` are newly built — generated fresh
 * with no retract. The three id sets are disjoint subsets of `built`. The
 * implementation reports the counts + reindex signal the builder folds into its
 * day summary.
 */
export interface MeetingMemoryGenerator {
  onRecordsBuilt(input: {
    built: readonly MeetingRecord[];
    removedIds: readonly string[];
    unchangedIds: readonly string[];
    updatedIds: readonly string[];
  }): Promise<MeetingMemoryOutcome>;
}
