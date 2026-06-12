/**
 * Wearable sync pipeline — pull → clean → label → correct → store →
 * (optionally) remember, for one source.
 *
 * Stage order per conversation is deliberate:
 *  1. off-the-record elision  (before anything can persist the span)
 *  2. cleanup                 (merging first lets redaction see numbers
 *                              that ASR split across segments)
 *  3. redaction               (built-in + user patterns)
 *  4. corrections             (user-specific word fixes)
 *
 * Day files are rebuilt idempotently; the per-day body hash recorded in
 * sync state lets unchanged days skip both the rewrite and the
 * (expensive) memory extraction. Sync state advances only after every
 * write for the run has succeeded.
 */

import { cleanConversation } from "./cleanup.js";
import { describeErrorForOperator, WearablesInputError } from "./errors.js";
import {
  applyCorrections,
  compileCorrectionRules,
  loadCorrectionsFile,
  type CompiledCorrectionRule,
} from "./corrections.js";
import {
  composeDayTranscriptBody,
  composeDayTranscriptMeta,
  hashTranscriptBody,
  isValidTranscriptDate,
  serializeDayTranscript,
} from "./day-store.js";
import {
  generateWearableMemories,
  importNativeMemories,
  writeDailyDigestMemory,
  type WearableMemoryGenDeps,
} from "./memory-gen.js";
import { tokenizeDayBody, type CorroborationContext } from "./trust.js";
import { applyOffTheRecord, compileRedactionPatterns, redactText } from "./redaction.js";
import { loadSpeakerRegistry } from "./speakers.js";
import {
  loadSyncState,
  saveSyncState,
  updateSourceSyncState,
} from "./sync-state.js";
import type {
  WearableConversation,
  WearableSourceConnector,
  WearableSourceSettings,
  WearableSyncSummary,
  WearablesConfig,
} from "./types.js";

/** Safety cap on pages fetched per day window. */
const MAX_PAGES_PER_DAY = 50;
/** Safety cap on native-memory pages per sync. */
const MAX_NATIVE_PAGES = 20;
/** Default lookback window (today + yesterday) for unscoped syncs. */
const DEFAULT_SYNC_DAYS = 2;
const MAX_SYNC_DAYS = 90;

export interface WearableSyncOptions {
  /** Sync exactly this day (YYYY-MM-DD). Overrides `days`. */
  date?: string;
  /** Lookback window in days ending today (default 2, max 90). */
  days?: number;
  /** Re-run memory extraction even for unchanged days. */
  forceMemories?: boolean;
  signal?: AbortSignal;
}

export interface WearableSyncDeps {
  /** Memory dir for state files (speakers, corrections, sync ledger). */
  memoryDir: string;
  /** Read the stored content hash for a day file, if present. */
  readDayContentHash(sourceId: string, date: string): Promise<string | null>;
  /** Persist a serialized day-transcript file (atomic). */
  writeDayTranscript(
    sourceId: string,
    date: string,
    serialized: string,
  ): Promise<void>;
  /**
   * Optional hook fired once after the sync wrote ANYTHING the search
   * index should see: day transcripts, created memories, in-place
   * promotions, or native imports. (A cross-source invalidation can
   * promote memories on a run with zero transcript writes — the index
   * must still refresh.)
   */
  afterWrites?(): Promise<void>;
  /**
   * Memory-generation dependencies, or null when no extraction engine
   * is available in this context (transcripts still sync; memory
   * creation is skipped with a warning when the mode wanted it).
   */
  memoryGen: WearableMemoryGenDeps | null;
  /**
   * Same-day transcript bodies from OTHER sources, for cross-device
   * corroboration in smart mode. Absent disables the boost.
   */
  readOtherSourceDayBodies?(
    date: string,
    excludeSource: string,
  ): Promise<Map<string, string>>;
  /**
   * Existing memories usable as support evidence: status "active" or
   * "pending_review" (explicit allow-list — a borderline fact observed
   * again on a later day is repetition signal, and the +0.10 boost is
   * how it earns promotion). Rejected/quarantined/superseded/archived/
   * forgotten rows are never support evidence.
   */
  listSupportMemories?(): Promise<Array<{ id: string; content: string }>>;
  /** Clock injection for tests. */
  now?: () => Date;
}

/** Format a Date as YYYY-MM-DD in the given IANA timezone. */
export function dateInTimezone(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const get = (type: string) =>
      parts.find((part) => part.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** Resolve the list of days to sync, oldest first. */
export function resolveSyncDates(
  options: WearableSyncOptions,
  timezone: string,
  now: Date,
): string[] {
  if (options.date !== undefined) {
    if (!isValidTranscriptDate(options.date)) {
      throw new WearablesInputError(
        `wearables sync: invalid date '${options.date}' — expected YYYY-MM-DD`,
      );
    }
    return [options.date];
  }
  let days = DEFAULT_SYNC_DAYS;
  if (options.days !== undefined) {
    if (
      !Number.isFinite(options.days) ||
      !Number.isInteger(options.days) ||
      options.days < 1 ||
      options.days > MAX_SYNC_DAYS
    ) {
      throw new WearablesInputError(
        `wearables sync: invalid days '${options.days}' — expected an integer between 1 and ${MAX_SYNC_DAYS}`,
      );
    }
    days = options.days;
  }
  // Walk back by CALENDAR days from today's local date — subtracting
  // fixed 24h intervals from the wall clock can skip a local day
  // around DST transitions (Codex P2 on PR #1458).
  const dates: string[] = [];
  let cursor = dateInTimezone(now, timezone);
  for (let count = 0; count < days; count++) {
    dates.unshift(cursor);
    cursor = previousIsoDate(cursor);
  }
  return dates;
}

/** Previous calendar date in pure date arithmetic (no DST exposure). */
function previousIsoDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

async function fetchAllConversationsForDate(
  connector: WearableSourceConnector,
  date: string,
  timezone: string,
  signal: AbortSignal | undefined,
  warnings: string[],
): Promise<{ conversations: WearableConversation[]; partial: boolean }> {
  const conversations: WearableConversation[] = [];
  let cursor: string | null | undefined = undefined;
  for (let page = 0; page < MAX_PAGES_PER_DAY; page++) {
    const result = await connector.fetchConversations({
      date,
      timezone,
      cursor,
      signal,
    });
    conversations.push(...result.conversations);
    if (!result.nextCursor) return { conversations, partial: false };
    cursor = result.nextCursor;
  }
  warnings.push(
    `${connector.id}: stopped paginating ${date} after ${MAX_PAGES_PER_DAY} pages — day may be partially synced (every sync refetches and re-warns until the provider day fits the cap)`,
  );
  return { conversations, partial: true };
}

/** Visible marker appended to day files whose fetch hit the page cap. */
const PARTIAL_DAY_MARKER =
  "\n*Note: pagination safety cap reached during sync — this day may be incomplete.*\n";

/**
 * Explicit replacement body for a day whose provider data exists but
 * whose every segment was elided or dropped (all off-the-record, all
 * ASR garbage). Written so previously-stored content for the day stops
 * being searchable instead of lingering as a stale transcript.
 */
function emptyDayBody(sourceId: string, date: string): string {
  return (
    `# ${sourceId} transcript — ${date}\n\n` +
    "_No storable conversation content for this day (all segments were elided or dropped)._\n"
  );
}

interface CleanedDay {
  conversations: WearableConversation[];
  segmentsKept: number;
  segmentsDropped: number;
  redactions: number;
  correctionsApplied: number;
}

function cleanDay(
  raw: WearableConversation[],
  sourceId: string,
  settings: WearableSourceSettings,
  config: WearablesConfig,
  userRedaction: RegExp[],
  correctionRules: CompiledCorrectionRule[],
): CleanedDay {
  const out: CleanedDay = {
    conversations: [],
    segmentsKept: 0,
    segmentsDropped: 0,
    redactions: 0,
    correctionsApplied: 0,
  };
  for (const conversation of raw) {
    let current = conversation;
    if (config.offTheRecordEnabled) {
      const otr = applyOffTheRecord(current);
      current = otr.conversation;
      out.segmentsDropped += otr.droppedSegments;
    }
    const cleaned = cleanConversation(current, settings.cleanup);
    current = cleaned.conversation;
    out.segmentsDropped += cleaned.droppedSegments;

    const segments = current.segments.map((segment) => {
      let text = segment.text;
      if (config.redactionEnabled) {
        const redacted = redactText(text, userRedaction);
        text = redacted.text;
        out.redactions += redacted.redactions;
      }
      const corrected = applyCorrections(text, correctionRules, sourceId);
      out.correctionsApplied += corrected.applied;
      return { ...segment, text: corrected.text };
    });
    current = { ...current, segments };

    if (current.segments.length > 0) {
      out.conversations.push(current);
      out.segmentsKept += current.segments.length;
    }
  }
  return out;
}

/** Sync one source. */
export async function syncWearableSource(
  connector: WearableSourceConnector,
  settings: WearableSourceSettings,
  config: WearablesConfig,
  options: WearableSyncOptions,
  deps: WearableSyncDeps,
): Promise<WearableSyncSummary> {
  const now = deps.now ? deps.now() : new Date();
  const timezone = config.timezone ?? defaultTimezone();
  const dates = resolveSyncDates(options, timezone, now);

  const summary: WearableSyncSummary = {
    source: connector.id,
    days: dates,
    conversations: 0,
    segmentsKept: 0,
    segmentsDropped: 0,
    redactions: 0,
    correctionsApplied: 0,
    transcriptsWritten: [],
    memoriesCreated: 0,
    memoriesPromoted: 0,
    memoriesDemoted: 0,
    memoriesSkipped: 0,
    nativeMemoriesImported: 0,
    warnings: [],
  };

  const registry = await loadSpeakerRegistry(deps.memoryDir);
  const stateRules = await loadCorrectionsFile(deps.memoryDir);
  const correctionRules = [
    ...compileCorrectionRules(config.corrections, "wearables.corrections"),
    ...compileCorrectionRules(stateRules, "state corrections"),
  ];
  const userRedaction = compileRedactionPatterns(config.redactionPatterns);

  let syncState = await loadSyncState(deps.memoryDir);
  const previousState = syncState.sources[connector.id];
  const dayHashes: Record<string, string> = {};
  const memoryDayHashes: Record<string, string> = {};
  const failedMemoryDays: string[] = [];
  const importedNativeIds: string[] = [];

  for (const date of dates) {
    const fetched = await fetchAllConversationsForDate(
      connector,
      date,
      timezone,
      options.signal,
      summary.warnings,
    );
    const cleaned = cleanDay(
      fetched.conversations,
      connector.id,
      settings,
      config,
      userRedaction,
      correctionRules,
    );
    summary.conversations += cleaned.conversations.length;
    summary.segmentsKept += cleaned.segmentsKept;
    summary.segmentsDropped += cleaned.segmentsDropped;
    summary.redactions += cleaned.redactions;
    summary.correctionsApplied += cleaned.correctionsApplied;

    if (fetched.conversations.length === 0) {
      // No provider data at all. A transient provider hiccup can
      // legitimately produce an empty result, so an existing stored
      // transcript is never auto-deleted here — surface it instead.
      const existing = await deps.readDayContentHash(connector.id, date);
      if (existing !== null) {
        summary.warnings.push(
          `${connector.id}: provider returned no conversations for ${date} but a stored transcript exists — leaving it in place; delete the day file manually if the recordings were intentionally removed upstream`,
        );
      }
      continue;
    }

    // Provider data exists but cleanup/off-the-record elided all of it:
    // replace any stored transcript with an explicit empty-day file so
    // elided content stops being stored and searchable (Codex P2 on PR
    // #1458).
    const allElided = cleaned.conversations.length === 0;
    let body = allElided
      ? emptyDayBody(connector.id, date)
      : composeDayTranscriptBody(
          connector.id,
          date,
          timezone,
          cleaned.conversations,
          registry,
        );
    if (fetched.partial && !allElided) {
      body += PARTIAL_DAY_MARKER;
    }
    const bodyHash = hashTranscriptBody(body);
    // The on-disk file is the authority for the skip decision — a hash
    // remembered in sync state must never suppress recreating a day
    // file that was deleted or lost (Cursor review on PR #1458). The
    // state's dayHashes remain as bookkeeping only.
    const existingHash = await deps.readDayContentHash(connector.id, date);
    const changed = existingHash !== bodyHash;
    // An all-elided day only writes a replacement over an existing
    // file; it never creates an empty-day file from nothing.
    const shouldWrite = changed && (!allElided || existingHash !== null);

    if (shouldWrite) {
      const meta = composeDayTranscriptMeta(
        connector.id,
        date,
        timezone,
        cleaned.conversations,
        registry,
        body,
        now.toISOString(),
      );
      await deps.writeDayTranscript(
        connector.id,
        date,
        serializeDayTranscript(meta, body),
      );
      summary.transcriptsWritten.push(date);
    }
    dayHashes[date] = bodyHash;

    if (allElided) continue;

    const needsSmartContext =
      settings.memoryMode === "smart" || settings.importNativeMemories === "smart";

    // The memory pass runs when the day changed, when forced, or when
    // the last pass for this exact content didn't complete cleanly —
    // a sync that stored the transcript but failed mid-memory-write
    // self-heals on the next run instead of being frozen out by the
    // unchanged-day skip (Cursor review on PR #1458).
    const memoryPassComplete =
      previousState?.memoryDayHashes?.[date] === bodyHash;
    if (
      settings.memoryMode !== "off" &&
      (changed || options.forceMemories === true || !memoryPassComplete)
    ) {
      if (!deps.memoryGen) {
        summary.warnings.push(
          `${connector.id}: memoryMode is '${settings.memoryMode}' but no extraction engine is available in this context — transcripts synced, memories skipped`,
        );
      } else {
        // The whole memory pass (extraction, fact writes, digest) is
        // warn-and-retry rather than abort: the transcript is already
        // stored, and aborting here would leave any stale completion
        // record from an earlier clean run in place to mask the
        // failure (Kilo review on PR #1458 for the digest case; fact
        // writes share the same failure class). A clean pass records
        // completion; anything else clears it so the next sync
        // re-runs the day.
        let passClean = false;
        try {
          const corroboration = needsSmartContext
            ? await buildCorroborationContext(connector.id, date, deps)
            : undefined;
          const dayMemoryGen: WearableMemoryGenDeps = {
            ...deps.memoryGen,
            ...(corroboration !== undefined ? { corroboration } : {}),
          };
          const generated = await generateWearableMemories(
            connector.id,
            date,
            cleaned.conversations,
            settings,
            registry,
            dayMemoryGen,
          );
          summary.memoriesCreated += generated.created;
          summary.memoriesPromoted += generated.promoted;
          summary.memoriesDemoted += generated.demoted;
          summary.memoriesSkipped += generated.skipped;
          summary.warnings.push(...generated.warnings);
          // Degraded-but-complete passes (e.g. judge unavailable) still
          // record completion — only an aborted extraction should force
          // the day to re-run on the next sync (Cursor review on PR
          // #1462).
          passClean = generated.completed;
          if (config.digestEnabled) {
            const wrote = await writeDailyDigestMemory(
              connector.id,
              date,
              cleaned.conversations,
              settings,
              registry,
              deps.memoryGen.writer,
            );
            if (wrote) summary.memoriesCreated += 1;
          }
        } catch (err) {
          passClean = false;
          summary.warnings.push(
            `${connector.id}: memory pass failed for ${date}: ${describeErrorForOperator(err)} — retries on the next sync`,
          );
        }
        if (passClean) {
          memoryDayHashes[date] = bodyHash;
        } else {
          failedMemoryDays.push(date);
        }
      }
    } else if (settings.memoryMode !== "off" && memoryPassComplete) {
      // Carry the completion record forward for unchanged days.
      memoryDayHashes[date] = bodyHash;
    }
  }

  if (
    settings.importNativeMemories !== "off" &&
    typeof connector.fetchNativeMemories === "function"
  ) {
    if (!deps.memoryGen) {
      summary.warnings.push(
        `${connector.id}: importNativeMemories is enabled but no memory writer is available in this context`,
      );
    } else {
      const alreadyImported = new Set(
        previousState?.importedNativeMemoryIds ?? [],
      );
      // Native memories carry no day, so same-day cross-device
      // corroboration does not apply to them — scoring a provider fact
      // against an arbitrary day's tokens would be wrong-day evidence
      // (Cursor review on PR #1462). They keep only the day-independent
      // existing-memory support boost.
      const nativeCorroboration =
        settings.importNativeMemories === "smart"
          ? {
              otherSourceDayTokens: new Map<string, Set<string>>(),
              existingMemories: deps.listSupportMemories
                ? await deps.listSupportMemories()
                : [],
            }
          : undefined;
      const nativeMemoryGen: WearableMemoryGenDeps = {
        ...deps.memoryGen,
        ...(nativeCorroboration !== undefined
          ? { corroboration: nativeCorroboration }
          : {}),
      };
      let cursor: string | null | undefined = undefined;
      for (let page = 0; page < MAX_NATIVE_PAGES; page++) {
        const result = await connector.fetchNativeMemories({
          cursor,
          signal: options.signal,
        });
        const imported = await importNativeMemories(
          connector.id,
          result.memories,
          alreadyImported,
          settings,
          nativeMemoryGen,
        );
        summary.warnings.push(...imported.warnings);
        summary.nativeMemoriesImported += imported.imported;
        importedNativeIds.push(...imported.importedIds);
        for (const id of imported.importedIds) alreadyImported.add(id);
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
        if (page === MAX_NATIVE_PAGES - 1) {
          summary.warnings.push(
            `${connector.id}: stopped native-memory import after ${MAX_NATIVE_PAGES} pages — remaining items import on the next sync`,
          );
        }
      }
    }
  }

  const wroteAnything =
    summary.transcriptsWritten.length > 0 ||
    summary.memoriesCreated > 0 ||
    summary.memoriesPromoted > 0 ||
    summary.memoriesDemoted > 0 ||
    summary.nativeMemoriesImported > 0;
  if (wroteAnything && deps.afterWrites) {
    try {
      await deps.afterWrites();
    } catch (err) {
      summary.warnings.push(
        `search reindex failed (writes are stored and will index on the next update): ${describeErrorForOperator(err)}`,
      );
    }
  }

  // Watermark advances only now — after transcript writes, memory
  // writes, and native imports all succeeded.
  syncState = updateSourceSyncState(syncState, connector.id, {
    syncedAt: now.toISOString(),
    days: dates,
    dayHashes,
    memoryDayHashes,
    clearMemoryDays: failedMemoryDays,
    importedNativeMemoryIds: importedNativeIds,
  });
  // New same-day evidence invalidates OTHER sources' memory-pass
  // completion for the days this source just (re)wrote: their next
  // sync re-scores with this transcript available, and the promotion
  // path upgrades earlier borderline writes in place (Cursor review on
  // PR #1462).
  if (summary.transcriptsWritten.length > 0) {
    const cleared: typeof syncState.sources = {};
    for (const [otherId, otherState] of Object.entries(syncState.sources)) {
      if (otherId === connector.id || otherState.memoryDayHashes === undefined) {
        cleared[otherId] = otherState;
        continue;
      }
      const memoryDays = { ...otherState.memoryDayHashes };
      let touched = false;
      for (const date of summary.transcriptsWritten) {
        if (date in memoryDays) {
          delete memoryDays[date];
          touched = true;
        }
      }
      cleared[otherId] = touched
        ? { ...otherState, memoryDayHashes: memoryDays }
        : otherState;
    }
    syncState = { version: 1, sources: cleared };
  }
  await saveSyncState(deps.memoryDir, syncState);

  return summary;
}

/**
 * Assemble smart-mode corroboration evidence: other sources' same-day
 * transcript tokens + existing active memories. The memory list loads
 * fresh per day (not per run) so facts written on earlier days of a
 * multi-day backfill are visible as support evidence on later days —
 * the underlying readAllMemories is cached in storage and invalidated
 * by writes, so the per-day refresh is cheap (Cursor review on PR
 * #1462).
 */
async function buildCorroborationContext(
  sourceId: string,
  date: string,
  deps: WearableSyncDeps,
): Promise<CorroborationContext> {
  const otherSourceDayTokens = new Map<string, Set<string>>();
  if (deps.readOtherSourceDayBodies) {
    const bodies = await deps.readOtherSourceDayBodies(date, sourceId);
    for (const [otherSource, body] of bodies) {
      otherSourceDayTokens.set(otherSource, tokenizeDayBody(body));
    }
  }
  const existingMemories = deps.listSupportMemories
    ? await deps.listSupportMemories()
    : [];
  return { otherSourceDayTokens, existingMemories };
}

export function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
