/**
 * Wearable memory generation — trust-gated extraction from cleaned day
 * transcripts.
 *
 * Wearable ASR quality varies wildly between providers and rooms, so
 * unlike live-session extraction this path is gated per source:
 *
 *  - memoryMode "off"     -> never runs
 *  - memoryMode "review"  -> candidates land with status
 *                            "pending_review" (operator approves via
 *                            the existing review-queue surfaces)
 *  - memoryMode "auto"    -> candidates that pass every gate land
 *                            active
 *
 * Deterministic gates (applied in order, all modes except "off"):
 *  1. category gate     — procedure / reasoning_trace candidates are
 *                         skipped (they need richer persistence than
 *                         this path provides)
 *  2. confidence floor  — `minConfidence`
 *  3. importance floor  — local `scoreImportance` >= `minImportance`
 *  4. dedup             — storage content-hash index + intra-run set
 *  5. day cap           — top `maxMemoriesPerDay` by importance score
 *                         (0 disables the cap)
 *
 * The extraction engine itself is injected so this module stays free of
 * LLM-client construction; callers hand in `orchestrator`-owned or
 * standalone engines alike.
 */

import { scoreImportance } from "../importance.js";
import type { JudgeBatchResult, JudgeCandidate } from "../extraction-judge.js";
import { getVerdictKind } from "../extraction-judge.js";
import { describeErrorForOperator } from "./errors.js";
import {
  computeTrustScore,
  decideSmart,
  findCorroboration,
  type CorroborationContext,
  type TrustEvidence,
} from "./trust.js";
import type {
  BufferTurn,
  ExtractedFact,
  ExtractionResult,
  ImportanceLevel,
  ImportanceScore,
  MemoryCategory,
  MemoryStatus,
} from "../types.js";
import { resolveSpeaker, type SpeakerRegistry } from "./speakers.js";
import type {
  WearableConversation,
  WearableMemoryMode,
  WearableNativeMemory,
  WearableSourceSettings,
} from "./types.js";

/**
 * Memory status used for a given memory mode. Least-privilege default:
 * anything that is not explicitly "auto" lands in the review queue
 * rather than active recall.
 */
export function memoryStatusForMode(
  mode: WearableMemoryMode,
): Extract<MemoryStatus, "active" | "pending_review"> {
  return mode === "auto" || mode === "smart" ? "active" : "pending_review";
}

/** Narrow writer interface satisfied by `StorageManager`. */
export interface WearableMemoryWriter {
  writeMemory(
    category: MemoryCategory,
    content: string,
    options: {
      confidence?: number;
      tags?: string[];
      source?: string;
      importance?: ImportanceScore;
      validAt?: string;
      structuredAttributes?: Record<string, string>;
      contentHashSource?: string;
      status?: MemoryStatus;
      memoryKind?: "episode" | "note" | "box" | "dream" | "procedural";
    },
  ): Promise<string>;
  hasFactContentHash(content: string): Promise<boolean>;
  /**
   * Locate an earlier wearable write of the same content (any status).
   * Optional: enables in-place promotion when re-scoring with stronger
   * evidence.
   */
  findWearableMemoryByContent?(
    content: string,
  ): Promise<{ id: string; status: MemoryStatus | undefined } | null>;
  /**
   * Promote a pending_review wearable memory to active, merging trust
   * evidence. Returns false when missing or no longer pending.
   */
  promoteWearableMemory?(
    id: string,
    attributeUpdates: Record<string, string>,
    confidence?: number,
  ): Promise<boolean>;
  /**
   * Demote a pending_review wearable memory to rejected on an explicit
   * judge-reject re-verdict. Returns false when missing or no longer
   * pending. Active rows are never auto-demoted.
   */
  demoteWearableMemory?(
    id: string,
    attributeUpdates: Record<string, string>,
  ): Promise<boolean>;
}

export interface WearableMemoryGenDeps {
  extract(turns: BufferTurn[]): Promise<ExtractionResult>;
  writer: WearableMemoryWriter;
  /**
   * LLM-as-judge batch evaluation (the existing extraction judge).
   * Absent when no judge is wired (degraded smart mode: trust scoring
   * runs on confidence x sourceTrust + corroboration alone).
   */
  judgeFacts?(candidates: JudgeCandidate[]): Promise<JudgeBatchResult>;
  /**
   * Corroboration evidence for smart mode: other sources' same-day
   * transcript tokens + existing active memories. Absent disables
   * corroboration boosts.
   */
  corroboration?: CorroborationContext;
}

export interface WearableMemoryGenResult {
  created: number;
  /** Earlier borderline writes promoted to active by new evidence. */
  promoted: number;
  /** Earlier pending writes retired by a fresh judge-reject verdict. */
  demoted: number;
  skipped: number;
  skippedByReason: Record<string, number>;
  /** Non-fatal problems (e.g. the extraction engine erroring). */
  warnings: string[];
  /**
   * True when every conversation was extracted (the pass may still
   * carry degraded-mode warnings, e.g. judge unavailable). False only
   * when extraction itself aborted mid-day — the signal callers use to
   * re-run the pass on the next sync. A degraded-but-complete pass
   * must NOT re-run forever: its facts are already written and dedup
   * would suppress improvements anyway.
   */
  completed: boolean;
}

export const WEARABLE_SOURCE_PREFIX = "wearable";

export function wearableSourceLabel(sourceId: string): string {
  return `${WEARABLE_SOURCE_PREFIX}:${sourceId}`;
}

export function wearableDayTag(date: string): string {
  return `wearable-day:${date}`;
}

const IMPORTANCE_RANK: Record<ImportanceLevel, number> = {
  trivial: 0,
  low: 1,
  normal: 2,
  high: 3,
  critical: 4,
};

/** Max characters of transcript per extraction turn. */
const MAX_EXTRACTION_CHUNK_CHARS = 6_000;
/** Skip extraction for conversations with less substance than this. */
const MIN_CONVERSATION_CHARS = 80;

/**
 * Render a cleaned conversation into extraction-ready turns. Each turn
 * carries a labeled multi-speaker transcript block; the wearer is
 * marked "(you)" so first-person facts attribute correctly.
 */
export function buildExtractionTurns(
  sourceId: string,
  date: string,
  conversation: WearableConversation,
  registry: SpeakerRegistry,
): BufferTurn[] {
  const headerParts = [
    `Wearable transcript (${sourceId}) — ${date}`,
    conversation.title ? `"${conversation.title}"` : undefined,
    conversation.location ? `at ${conversation.location}` : undefined,
  ].filter((part): part is string => typeof part === "string");
  const header = `[${headerParts.join(" — ")}]`;

  const lines: string[] = [];
  for (const segment of conversation.segments) {
    const { label } = resolveSpeaker(sourceId, segment, registry);
    lines.push(`${label}: ${segment.text}`);
  }
  const transcript = lines.join("\n");
  if (transcript.trim().length < MIN_CONVERSATION_CHARS) return [];

  const sessionKey = `wearables:${sourceId}:${date}:${conversation.id}`;
  const timestamp = conversation.startIso;
  const turns: BufferTurn[] = [];
  let chunkLines: string[] = [];
  let chunkChars = 0;
  const flush = () => {
    if (chunkLines.length === 0) return;
    turns.push({
      role: "user",
      content: `${header}\n${chunkLines.join("\n")}`,
      timestamp,
      sourceValidAt: timestamp,
      sessionKey,
    });
    chunkLines = [];
    chunkChars = 0;
  };
  for (const line of transcript.split("\n")) {
    if (chunkChars + line.length + 1 > MAX_EXTRACTION_CHUNK_CHARS) flush();
    chunkLines.push(line);
    chunkChars += line.length + 1;
  }
  flush();
  return turns;
}

interface GatedCandidate {
  fact: ExtractedFact;
  importance: ImportanceScore;
  conversation: WearableConversation;
}

interface ScoredCandidate {
  trust: number;
  verdict?: "accept" | "reject" | "defer";
  evidence: TrustEvidence;
}

/**
 * Smart-mode scoring: one judge batch call for the whole day, then
 * per-fact trust = confidence x sourceTrust + judge/corroboration
 * boosts. A judge failure degrades gracefully (warned once; scoring
 * continues on confidence + corroboration alone).
 */
async function scoreCandidates(
  novel: GatedCandidate[],
  settings: WearableSourceSettings,
  deps: WearableMemoryGenDeps,
  result: WearableMemoryGenResult,
): Promise<Map<number, ScoredCandidate>> {
  const scored = new Map<number, ScoredCandidate>();
  if (novel.length === 0) return scored;

  let verdicts: Map<number, "accept" | "reject" | "defer"> | undefined;
  if (deps.judgeFacts) {
    const judgeCandidates: JudgeCandidate[] = novel.map((candidate) => ({
      text: candidate.fact.content,
      category: candidate.fact.category,
      confidence:
        typeof candidate.fact.confidence === "number"
          ? candidate.fact.confidence
          : 0.7,
      tags: candidate.fact.tags ?? [],
      importanceLevel: candidate.importance.level,
    }));
    try {
      const judgeResult = await deps.judgeFacts(judgeCandidates);
      verdicts = new Map();
      for (const [index, verdict] of judgeResult.verdicts) {
        verdicts.set(index, getVerdictKind(verdict));
      }
    } catch (err) {
      result.warnings.push(
        `extraction judge unavailable for this pass: ${describeErrorForOperator(err)} — trust scoring continued without judge verdicts`,
      );
    }
  }

  const corroboration: CorroborationContext = deps.corroboration ?? {
    otherSourceDayTokens: new Map(),
    existingMemories: [],
  };
  novel.forEach((candidate, index) => {
    const evidence = findCorroboration(candidate.fact.content, corroboration);
    const verdict = verdicts?.get(index);
    const trust = computeTrustScore({
      extractionConfidence: candidate.fact.confidence,
      sourceTrust: settings.sourceTrust,
      judgeVerdict: verdict,
      evidence,
    });
    scored.set(index, { trust, ...(verdict !== undefined ? { verdict } : {}), evidence });
  });
  return scored;
}

/**
 * Run extraction + gates over a day's conversations and persist the
 * survivors. Returns counts for the sync summary.
 */
export async function generateWearableMemories(
  sourceId: string,
  date: string,
  conversations: WearableConversation[],
  settings: WearableSourceSettings,
  registry: SpeakerRegistry,
  deps: WearableMemoryGenDeps,
): Promise<WearableMemoryGenResult> {
  const result: WearableMemoryGenResult = {
    created: 0,
    promoted: 0,
    demoted: 0,
    skipped: 0,
    skippedByReason: {},
    warnings: [],
    completed: true,
  };
  if (settings.memoryMode === "off") return result;

  const skip = (reason: string, count = 1): void => {
    result.skipped += count;
    result.skippedByReason[reason] =
      (result.skippedByReason[reason] ?? 0) + count;
  };

  const candidates: GatedCandidate[] = [];
  const seenContent = new Set<string>();

  for (const conversation of conversations) {
    const turns = buildExtractionTurns(sourceId, date, conversation, registry);
    if (turns.length === 0) continue;
    let extraction: ExtractionResult;
    try {
      extraction = await deps.extract(turns);
    } catch (err) {
      // One failing extraction call almost always means every call will
      // fail (missing key, provider outage) — stop hammering the engine
      // and surface a single actionable warning instead of one per
      // conversation. Candidates gathered before the failure still
      // persist below.
      result.warnings.push(
        `extraction failed for ${sourceId}/${date} (conversation ${conversation.id}): ${describeErrorForOperator(err)} — the memory pass for this day retries on the next sync`,
      );
      result.completed = false;
      break;
    }
    for (const fact of extraction.facts) {
      const content = fact.content?.trim();
      if (!content) {
        skip("empty");
        continue;
      }
      if (fact.category === "procedure" || fact.category === "reasoning_trace") {
        skip("unsupported-category");
        continue;
      }
      // In smart mode the trust bands subsume the hard confidence
      // floor — a borderline fact belongs in the review band, not on
      // the floor. The pre-filter applies to review/auto modes only.
      if (
        settings.memoryMode !== "smart" &&
        typeof fact.confidence === "number" &&
        fact.confidence < settings.minConfidence
      ) {
        skip("below-confidence");
        continue;
      }
      const importance = scoreImportance(content, fact.category, fact.tags ?? []);
      if (
        IMPORTANCE_RANK[importance.level] <
        IMPORTANCE_RANK[settings.minImportance]
      ) {
        skip("below-importance");
        continue;
      }
      const dedupKey = content.toLowerCase();
      if (seenContent.has(dedupKey)) {
        skip("duplicate-in-run");
        continue;
      }
      seenContent.add(dedupKey);
      candidates.push({ fact: { ...fact, content }, importance, conversation });
    }
  }

  // Drop candidates that already exist in storage BEFORE applying the
  // day cap so duplicates never consume cap slots that novel,
  // lower-scoring candidates should get (Codex P2 on PR #1458). In
  // smart mode a duplicate of a PENDING_REVIEW write is kept aside as
  // a promotion candidate — corroboration that arrives after the
  // original borderline write (another device syncing the same day)
  // must be able to promote it in place (Cursor review on PR #1462).
  const novel: GatedCandidate[] = [];
  const promotable: GatedCandidate[] = [];
  for (const candidate of candidates) {
    if (await deps.writer.hasFactContentHash(candidate.fact.content)) {
      if (
        settings.memoryMode === "smart" &&
        deps.writer.findWearableMemoryByContent !== undefined &&
        deps.writer.promoteWearableMemory !== undefined
      ) {
        promotable.push(candidate);
      } else {
        skip("duplicate-existing");
      }
      continue;
    }
    novel.push(candidate);
  }

  // Re-score promotion candidates with TODAY'S evidence; promote the
  // ones that now clear the auto threshold. Never consumes day-cap
  // slots (no new memory is written).
  if (promotable.length > 0) {
    const promoteScores = await scoreCandidates(promotable, settings, deps, result);
    for (const [index, candidate] of promotable.entries()) {
      const scored = promoteScores.get(index);
      const decision = scored
        ? decideSmart(scored.trust, scored.verdict, settings)
        : undefined;
      if (!scored || !decision) {
        skip("duplicate-existing");
        continue;
      }
      // A fresh judge-REJECT retires the stored row — but only a
      // pending_review one. Active rows are never auto-demoted: an
      // operator approval or accrued recall signals must not be
      // overturned by one later LLM verdict; contradiction scans and
      // supersession own active-row retirement (Cursor review on PR
      // #1462, round 7).
      if (scored.verdict === "reject") {
        if (deps.writer.demoteWearableMemory !== undefined) {
          const existingForDemote = await deps.writer.findWearableMemoryByContent!(
            candidate.fact.content,
          );
          if (
            existingForDemote &&
            existingForDemote.status === "pending_review" &&
            (await deps.writer.demoteWearableMemory(existingForDemote.id, {
              trustScore: scored.trust.toFixed(3),
              trustDecision: "demoted-by-rejection",
              judgeVerdict: "reject",
            }))
          ) {
            result.demoted += 1;
            continue;
          }
        }
        skip("duplicate-existing");
        continue;
      }
      if (decision.outcome !== "active") {
        skip("duplicate-existing");
        continue;
      }
      const existing = await deps.writer.findWearableMemoryByContent!(
        candidate.fact.content,
      );
      if (!existing || existing.status !== "pending_review") {
        skip("duplicate-existing");
        continue;
      }
      const promoted = await deps.writer.promoteWearableMemory!(
        existing.id,
        {
          trustScore: scored.trust.toFixed(3),
          trustDecision: "promoted-by-corroboration",
          ...(scored.verdict !== undefined ? { judgeVerdict: scored.verdict } : {}),
          ...(scored.evidence.corroboratedBySources.length > 0
            ? { corroboratedBySources: scored.evidence.corroboratedBySources.join(",") }
            : {}),
          ...(scored.evidence.supportingMemoryId !== undefined
            ? { supportingMemoryId: scored.evidence.supportingMemoryId }
            : {}),
        },
        scored.trust,
      );
      if (promoted) {
        result.promoted += 1;
      } else {
        skip("duplicate-existing");
      }
    }
  }

  // Smart mode: judge + trust scoring decide active/review/drop per
  // fact. The judge runs ONE batch call for the whole day; trust
  // combines extraction confidence x sourceTrust with corroboration
  // boosts (cross-device agreement, existing-memory support).
  let trustById = new Map<number, ScoredCandidate>();
  if (settings.memoryMode === "smart") {
    trustById = await scoreCandidates(novel, settings, deps, result);
  }

  // Smart decisions run BEFORE the day cap so dropped facts (judge
  // rejections, below-trust) never consume cap slots that surviving
  // candidates ranked past position N should get (Cursor review on PR
  // #1462).
  interface Writable {
    candidate: GatedCandidate;
    index: number;
    status: MemoryStatus;
    trustAttributes: Record<string, string>;
  }
  const modeStatus = memoryStatusForMode(settings.memoryMode);
  const writable: Writable[] = [];
  novel.forEach((candidate, index) => {
    if (settings.memoryMode !== "smart") {
      writable.push({ candidate, index, status: modeStatus, trustAttributes: {} });
      return;
    }
    const scored = trustById.get(index);
    if (!scored) return;
    const decision = decideSmart(scored.trust, scored.verdict, settings);
    if (decision.outcome === "drop") {
      skip(decision.reason);
      return;
    }
    writable.push({
      candidate,
      index,
      status: decision.outcome === "active" ? "active" : "pending_review",
      trustAttributes: {
        trustScore: scored.trust.toFixed(3),
        trustDecision: decision.reason,
        ...(scored.verdict !== undefined ? { judgeVerdict: scored.verdict } : {}),
        ...(scored.evidence.corroboratedBySources.length > 0
          ? { corroboratedBySources: scored.evidence.corroboratedBySources.join(",") }
          : {}),
        ...(scored.evidence.supportingMemoryId !== undefined
          ? { supportingMemoryId: scored.evidence.supportingMemoryId }
          : {}),
      },
    });
  });

  // Day cap over the SURVIVORS: strongest by trust in smart mode, by
  // importance otherwise. Stable ordering with a content tiebreak.
  const strength = (entry: Writable): number =>
    settings.memoryMode === "smart"
      ? trustById.get(entry.index)?.trust ?? 0
      : entry.candidate.importance.score;
  writable.sort((a, b) => {
    const sa = strength(a);
    const sb = strength(b);
    if (sa > sb) return -1;
    if (sa < sb) return 1;
    if (a.candidate.fact.content < b.candidate.fact.content) return -1;
    if (a.candidate.fact.content > b.candidate.fact.content) return 1;
    return 0;
  });
  const cap = settings.maxMemoriesPerDay;
  const kept = cap > 0 ? writable.slice(0, cap) : writable;
  if (writable.length > kept.length) {
    skip("over-day-cap", writable.length - kept.length);
  }

  for (const { candidate, index, status, trustAttributes } of kept) {
    const tags = [
      ...new Set([
        ...(candidate.fact.tags ?? []),
        WEARABLE_SOURCE_PREFIX,
        wearableSourceLabel(sourceId),
        wearableDayTag(date),
      ]),
    ];
    await deps.writer.writeMemory(candidate.fact.category, candidate.fact.content, {
      confidence:
        settings.memoryMode === "smart"
          ? trustById.get(index)?.trust
          : candidate.fact.confidence,
      tags,
      source: wearableSourceLabel(sourceId),
      importance: candidate.importance,
      validAt: candidate.conversation.startIso,
      structuredAttributes: {
        ...(candidate.fact.structuredAttributes ?? {}),
        wearableSource: sourceId,
        wearableDate: date,
        wearableConversationId: candidate.conversation.id,
        ...trustAttributes,
      },
      contentHashSource: candidate.fact.content,
      status,
    });
    result.created += 1;
  }
  return result;
}

/**
 * Write one compact daily-digest memory summarizing the day's recorded
 * conversations. Deterministic (no LLM): titles, time ranges, speaker
 * counts. Gated by `wearables.digestEnabled`.
 */
export async function writeDailyDigestMemory(
  sourceId: string,
  date: string,
  conversations: WearableConversation[],
  settings: WearableSourceSettings,
  registry: SpeakerRegistry,
  writer: WearableMemoryWriter,
): Promise<boolean> {
  if (settings.memoryMode === "off") return false;
  if (conversations.length === 0) return false;
  const lines = conversations.map((conversation) => {
    const title = conversation.title?.trim() || "Untitled conversation";
    const speakers = new Set(
      conversation.segments.map(
        (segment) => resolveSpeaker(sourceId, segment, registry).label,
      ),
    );
    return `- ${title} (${speakers.size} speaker${speakers.size === 1 ? "" : "s"})`;
  });
  const content =
    `Wearable day digest — ${sourceId}, ${date}: ` +
    `${conversations.length} recorded conversation${conversations.length === 1 ? "" : "s"}.\n` +
    lines.join("\n");
  if (await writer.hasFactContentHash(content)) return false;
  await writer.writeMemory("moment", content, {
    confidence: 0.9,
    tags: [
      WEARABLE_SOURCE_PREFIX,
      wearableSourceLabel(sourceId),
      wearableDayTag(date),
      "daily-digest",
    ],
    source: wearableSourceLabel(sourceId),
    importance: scoreImportance(content, "moment", ["daily-digest"]),
    validAt: `${date}T00:00:00.000Z`,
    structuredAttributes: {
      wearableSource: sourceId,
      wearableDate: date,
    },
    contentHashSource: content,
    status: memoryStatusForMode(settings.memoryMode),
    memoryKind: "episode",
  });
  return true;
}

/**
 * Import provider-extracted memories (Bee facts, Omi memories) into the
 * review queue. Always `pending_review` regardless of memoryMode — the
 * provider's extraction quality is outside Remnic's control.
 */
/** Native-source trust prior reduction (provider extraction quality). */
const NATIVE_TRUST_FACTOR = 0.9;

export async function importNativeMemories(
  sourceId: string,
  memories: WearableNativeMemory[],
  alreadyImportedIds: ReadonlySet<string>,
  settings: WearableSourceSettings,
  deps: WearableMemoryGenDeps,
): Promise<{ imported: number; importedIds: string[]; warnings: string[] }> {
  let imported = 0;
  const importedIds: string[] = [];
  const warnings: string[] = [];
  const seenContent = new Set<string>();
  const smart = settings.importNativeMemories === "smart";

  // Smart path: one judge batch over the novel items, like transcript
  // facts, with a reduced source prior — provider extraction quality is
  // outside Remnic's control.
  const novel: WearableNativeMemory[] = [];
  for (const memory of memories) {
    const content = memory.content?.trim();
    if (!content) continue;
    if (alreadyImportedIds.has(memory.id)) continue;
    // Intra-run + cross-run dedup: the storage hash index only learns a
    // fact after its write lands, so same-content items within one page
    // batch need the local set.
    if (seenContent.has(content) || (await deps.writer.hasFactContentHash(content))) {
      importedIds.push(memory.id);
      continue;
    }
    seenContent.add(content);
    novel.push({ ...memory, content });
  }

  let verdicts: Map<number, "accept" | "reject" | "defer"> | undefined;
  if (smart && deps.judgeFacts && novel.length > 0) {
    try {
      const judgeResult = await deps.judgeFacts(
        novel.map((memory) => ({
          text: memory.content,
          category: "fact",
          confidence: 0.7,
          tags: memory.tags ?? [],
        })),
      );
      verdicts = new Map();
      for (const [index, verdict] of judgeResult.verdicts) {
        verdicts.set(index, getVerdictKind(verdict));
      }
    } catch (err) {
      warnings.push(
        `extraction judge unavailable for native import: ${describeErrorForOperator(err)} — trust scoring continued without judge verdicts`,
      );
    }
  }
  const corroboration: CorroborationContext = deps.corroboration ?? {
    otherSourceDayTokens: new Map(),
    existingMemories: [],
  };

  for (const [index, memory] of novel.entries()) {
    const content = memory.content;
    let status: MemoryStatus = "pending_review";
    let trustAttributes: Record<string, string> = {};
    let confidence = 0.6;
    if (smart) {
      const evidence = findCorroboration(content, corroboration);
      const verdict = verdicts?.get(index);
      const trust = computeTrustScore({
        extractionConfidence: undefined,
        sourceTrust: settings.sourceTrust * NATIVE_TRUST_FACTOR,
        judgeVerdict: verdict,
        evidence,
      });
      const decision = decideSmart(trust, verdict, settings);
      if (decision.outcome === "drop") {
        // Deliberately NOT recorded in importedIds: a dropped native
        // fact re-fetches and re-scores on later syncs, so corpus or
        // corroboration support that arrives later can still admit it.
        // The judge verdict cache keeps repeated rejections cheap
        // (Cursor review on PR #1462).
        continue;
      }
      status = decision.outcome === "active" ? "active" : "pending_review";
      confidence = trust;
      trustAttributes = {
        trustScore: trust.toFixed(3),
        trustDecision: decision.reason,
        ...(verdict !== undefined ? { judgeVerdict: verdict } : {}),
        ...(evidence.corroboratedBySources.length > 0
          ? { corroboratedBySources: evidence.corroboratedBySources.join(",") }
          : {}),
        ...(evidence.supportingMemoryId !== undefined
          ? { supportingMemoryId: evidence.supportingMemoryId }
          : {}),
      };
    }
    await deps.writer.writeMemory("fact", content, {
      confidence,
      tags: [
        ...new Set([
          ...(memory.tags ?? []),
          WEARABLE_SOURCE_PREFIX,
          wearableSourceLabel(sourceId),
          "native-import",
        ]),
      ],
      source: `${wearableSourceLabel(sourceId)}:native`,
      importance: scoreImportance(content, "fact", memory.tags ?? []),
      validAt: memory.createdIso,
      structuredAttributes: {
        wearableSource: sourceId,
        wearableNativeId: memory.id,
        ...trustAttributes,
      },
      contentHashSource: content,
      status,
    });
    imported += 1;
    importedIds.push(memory.id);
  }
  return { imported, importedIds, warnings };
}
