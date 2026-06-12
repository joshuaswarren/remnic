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
import { describeErrorForOperator } from "./errors.js";
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
  return mode === "auto" ? "active" : "pending_review";
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
}

export interface WearableMemoryGenDeps {
  extract(turns: BufferTurn[]): Promise<ExtractionResult>;
  writer: WearableMemoryWriter;
}

export interface WearableMemoryGenResult {
  created: number;
  skipped: number;
  skippedByReason: Record<string, number>;
  /** Non-fatal problems (e.g. the extraction engine erroring). */
  warnings: string[];
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
    skipped: 0,
    skippedByReason: {},
    warnings: [],
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
      if (
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
  // lower-scoring candidates should get (Codex P2 on PR #1458).
  const novel: GatedCandidate[] = [];
  for (const candidate of candidates) {
    if (await deps.writer.hasFactContentHash(candidate.fact.content)) {
      skip("duplicate-existing");
      continue;
    }
    novel.push(candidate);
  }

  // Day cap: keep the most important candidates. Stable ordering —
  // score desc, then content asc so equal scores compare 0-consistent.
  novel.sort((a, b) => {
    if (a.importance.score > b.importance.score) return -1;
    if (a.importance.score < b.importance.score) return 1;
    if (a.fact.content < b.fact.content) return -1;
    if (a.fact.content > b.fact.content) return 1;
    return 0;
  });
  const cap = settings.maxMemoriesPerDay;
  const kept = cap > 0 ? novel.slice(0, cap) : novel;
  if (novel.length > kept.length) {
    skip("over-day-cap", novel.length - kept.length);
  }

  const status = memoryStatusForMode(settings.memoryMode);
  for (const candidate of kept) {
    const tags = [
      ...new Set([
        ...(candidate.fact.tags ?? []),
        WEARABLE_SOURCE_PREFIX,
        wearableSourceLabel(sourceId),
        wearableDayTag(date),
      ]),
    ];
    await deps.writer.writeMemory(candidate.fact.category, candidate.fact.content, {
      confidence: candidate.fact.confidence,
      tags,
      source: wearableSourceLabel(sourceId),
      importance: candidate.importance,
      validAt: candidate.conversation.startIso,
      structuredAttributes: {
        ...(candidate.fact.structuredAttributes ?? {}),
        wearableSource: sourceId,
        wearableDate: date,
        wearableConversationId: candidate.conversation.id,
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
export async function importNativeMemories(
  sourceId: string,
  memories: WearableNativeMemory[],
  alreadyImportedIds: ReadonlySet<string>,
  writer: WearableMemoryWriter,
): Promise<{ imported: number; importedIds: string[] }> {
  let imported = 0;
  const importedIds: string[] = [];
  const seenContent = new Set<string>();
  for (const memory of memories) {
    const content = memory.content?.trim();
    if (!content) continue;
    if (alreadyImportedIds.has(memory.id)) continue;
    // Intra-run + cross-run dedup: the storage hash index only learns a
    // fact after its write lands, so same-content items within one page
    // batch need the local set.
    if (seenContent.has(content) || (await writer.hasFactContentHash(content))) {
      importedIds.push(memory.id);
      continue;
    }
    seenContent.add(content);
    await writer.writeMemory("fact", content, {
      confidence: 0.6,
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
      },
      contentHashSource: content,
      status: "pending_review",
    });
    imported += 1;
    importedIds.push(memory.id);
  }
  return { imported, importedIds };
}
