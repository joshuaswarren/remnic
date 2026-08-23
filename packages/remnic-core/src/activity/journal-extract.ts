/**
 * Review-only journal extraction pass (issue #1987, reusing #1984's design).
 *
 * Vault journal text is user-authored but unverified: candidates land
 * `pending_review` ONLY — there is no auto-approve path by design, so no
 * journal-derived memory ever reaches `active` without explicit review
 * approval. A judge reject drops the candidate even in review mode.
 * Standard sanitization applies before extraction; unsafe text extracts
 * nothing (the placeholder is never written as memory content).
 *
 * Per-day change detection lives in journal-state.ts (timeline.json);
 * this module is the pure pass over one day's POST-STRIP text.
 */
import { scoreImportance } from "../importance.js";
import { getVerdictKind, type JudgeCandidate, type JudgeVerdict } from "../extraction-judge.js";
import { log } from "../logger.js";
import { sanitizeMemoryContent } from "../sanitize.js";
import { stripAttributesSuffix } from "../structured-attributes.js";
import type {
  BufferTurn,
  ExtractedFact,
  ExtractionResult,
  ImportanceScore,
  MemoryStatus,
} from "../types.js";
import { composeMemoryEnvelope, type SealedMemoryEnvelope, type WriteContext } from "../write-envelope.js";
import { buildJournalMemoryProvenance } from "./journal-vault-provenance.js";
import type { ActivityTimelineJournalConfig } from "./types.js";

/** The subset of StorageManager the journal pass writes through. */
export interface JournalStorageIo {
  writeSealedMemory(
    envelope: SealedMemoryEnvelope,
    extras: { status: MemoryStatus; contentHashSource: string; importance?: ImportanceScore },
  ): Promise<{ tombstoneBlocked?: boolean }>;
  hasFactContentHash(content: string): Promise<boolean>;
  readAllMemories(): Promise<Array<{ path: string; frontmatter: { tags?: string[]; source?: unknown }; content: string }>>;
}

/**
 * One extraction pass's stable dedupe view (issue #2882): the journal-tagged
 * corpus is read ONCE per pass — every candidate decision answers from that
 * single version plus this pass's own writes, never a mid-pass mix of corpus
 * states (each write invalidates StorageManager's corpus cache, so a
 * per-candidate rescan would both re-read the whole corpus and change the
 * decision basis under the pass).
 */
export interface JournalDedupeSnapshot {
  has(content: string): Promise<boolean>;
  /** Fold this pass's own successful write into the snapshot (§32: never recorded for tombstone-blocked or rejected writes). */
  record(content: string): void;
}

export interface JournalMemoryWriter {
  writeSealedMemory: JournalStorageIo["writeSealedMemory"];
  /** Dedup beyond the fact-only hash index: opens the per-pass snapshot of journal-tagged memories. */
  openDedupeSnapshot(): Promise<JournalDedupeSnapshot>;
}

/**
 * The storage fact-hash index only covers category "fact"; journal
 * candidates span every category, so dedup additionally scans existing
 * journal-tagged memories for an exact content match (wearables parity,
 * Codex P2 on PR #1458). The scan runs once per snapshot open (issue #2882),
 * not once per candidate.
 */
export function createJournalMemoryWriter(storage: JournalStorageIo): JournalMemoryWriter {
  return {
    writeSealedMemory: storage.writeSealedMemory.bind(storage),
    openDedupeSnapshot: async () => {
      const journalContents = new Set<string>();
      for (const memory of await storage.readAllMemories()) {
        if (
          Array.isArray(memory.frontmatter.tags) &&
          memory.frontmatter.tags.includes("journal")
        ) {
          journalContents.add(stripAttributesSuffix(memory.content));
        }
      }
      return {
        has: async (content: string) => {
          if (await storage.hasFactContentHash(content)) return true;
          return journalContents.has(stripAttributesSuffix(content));
        },
        record: (content: string) => {
          journalContents.add(stripAttributesSuffix(content));
        },
      };
    },
  };
}

/** Result of one day's journal extraction run, including the skip reason. */
export type JournalExtractionRunResult = JournalExtractionResult & {
  skippedReason?: string;
  filePath?: string;
};
export interface JournalExtractionDeps {
  extract(turns: BufferTurn[]): Promise<ExtractionResult>;
  writer: JournalMemoryWriter;
  /** LLM-as-judge batch evaluation; absent degrades to review-only writes. */
  judge?(candidates: JudgeCandidate[]): Promise<Map<number, JudgeVerdict>>;
  now?(): Date;
  /** Fires once after any candidate write — the §31 reindex hook. */
  afterWrites?(): Promise<void>;
}

export interface JournalExtractionResult {
  /** pending_review candidates written this run. */
  pendingReview: number;
  /** Candidates the judge rejected — dropped, never queued. */
  rejectedByJudge: number;
  /** Candidates skipped by in-run or persisted dedup. */
  skipped: number;
  /** True when the pass extracted the day (caller advances the state hash). */
  completed: boolean;
  warnings: string[];
}

export async function runJournalReviewExtraction(input: {
  date: string;
  journalText: string;
  source: "memoryDir" | "vault";
  journalConfig: Pick<ActivityTimelineJournalConfig, "extractionMode">;
  deps: JournalExtractionDeps;
}): Promise<JournalExtractionResult> {
  const result: JournalExtractionResult = {
    pendingReview: 0,
    rejectedByJudge: 0,
    skipped: 0,
    completed: false,
    warnings: [],
  };
  if (input.journalConfig.extractionMode !== "review") return result;
  if (input.journalText.trim().length === 0) {
    result.completed = true;
    return result;
  }

  // Standard sanitization like any other source. A violation extracts
  // NOTHING — the sanitized placeholder must never become memory content.
  const sanitized = sanitizeMemoryContent(input.journalText);
  if (!sanitized.clean) {
    result.warnings.push(
      `journal text for ${input.date} failed sanitization (${sanitized.violations.length} violation(s)); extraction skipped`,
    );
    result.completed = true;
    return result;
  }

  const provenance = buildJournalMemoryProvenance({ source: input.source, date: input.date });

  let extracted: ExtractionResult;
  try {
    extracted = await input.deps.extract([
      {
        role: "user",
        content: sanitized.text,
        timestamp: (input.deps.now ?? ((): Date => new Date()))().toISOString(),
      },
    ]);
  } catch (err) {
    // Provider/parse failure must not throw out of the pass; the caller
    // does NOT advance the state hash, so the next run retries this day.
    log.warn(
      `journal extraction failed for ${input.date}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }
  if (extracted.extractionFailure !== undefined) {
    log.warn(
      `journal extraction reported a failure for ${input.date}: ${extracted.extractionFailure}`,
    );
    return result;
  }
  result.completed = true;

  let verdicts = new Map<number, JudgeVerdict>();
  const candidates = dedupeInRun(extracted.facts, result);
  if (input.deps.judge !== undefined && candidates.length > 0) {
    try {
      verdicts = await input.deps.judge(
        candidates.map((fact) => ({
          text: fact.content,
          category: fact.category,
          confidence: fact.confidence,
          tags: fact.tags,
          importanceLevel: scoreImportance(fact.content, fact.category, fact.tags).level,
        })),
      );
    } catch (err) {
      log.warn(
        `journal extraction judge unavailable for ${input.date}: ${err instanceof Error ? err.message : String(err)} — review-only writes continue without verdicts`,
      );
    }
  }

  let wrote = false;
  let dedupe: JournalDedupeSnapshot | null = null;
  const ctx: WriteContext = { source: "journal", now: input.deps.now };
  for (let index = 0; index < candidates.length; index += 1) {
    const fact = candidates[index]!;
    const verdict = verdicts.get(index);
    const verdictKind = verdict === undefined ? undefined : getVerdictKind(verdict);
    if (verdictKind === "reject") {
      result.rejectedByJudge += 1;
      continue;
    }
    const normalizedKey = fact.content.trim().toLowerCase();
    // Open the snapshot lazily so zero-candidate passes never pay the corpus
    // read; from here every decision in the pass answers from this one version.
    dedupe ??= await input.deps.writer.openDedupeSnapshot();
    if (await dedupe.has(fact.content)) {
      result.skipped += 1;
      continue;
    }
    // Journal text is machine-extracted: salvage mode, warn-logged drops.
    const envelope = composeMemoryEnvelope(
      {
        content: fact.content,
        category: fact.category,
        tags: [...fact.tags, ...provenance.tags],
        entityRef: fact.entityRef,
        confidence: fact.confidence,
        validAt: provenance.validAt,
        structuredAttributes: { ...provenance.structuredAttributes },
        sourceConnector: "journal",
        sourceReason: input.source === "vault" ? "vault daily-note journal" : "memoryDir journal",
      },
      ctx,
      { salvage: true },
    );
    if (envelope.salvageNotes.length > 0) {
      log.warn(`journal write salvaged invalid fields: ${envelope.salvageNotes.join("; ")}`);
    }
    const write = await input.deps.writer.writeSealedMemory(envelope, {
      status: "pending_review",
      contentHashSource: normalizedKey,
      importance: scoreImportance(fact.content, fact.category, fact.tags),
    });
    if (write.tombstoneBlocked) {
      result.skipped += 1;
      continue;
    }
    dedupe.record(fact.content);
    result.pendingReview += 1;
    wrote = true;
  }

  if (wrote && input.deps.afterWrites !== undefined) {
    try {
      await input.deps.afterWrites();
    } catch (err) {
      // The writes are durable; a reindex failure is reported, not thrown
      // (§31 — the data indexes on the next update).
      result.warnings.push(
        `reindex after journal writes failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return result;
}

/** Keep the strongest copy per normalized content so one day cannot duplicate itself. */
function dedupeInRun(
  facts: ExtractedFact[],
  result: JournalExtractionResult,
): ExtractedFact[] {
  const seen = new Map<string, ExtractedFact>();
  for (const fact of facts) {
    const key = fact.content.trim().toLowerCase();
    if (!seen.has(key)) seen.set(key, fact);
    else result.skipped += 1;
  }
  return [...seen.values()];
}
