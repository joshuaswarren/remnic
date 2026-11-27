
import { fillWearableConversationLocations } from "../location/tagging.js";
import { isAbortError } from "../abort-error.js";
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
import {
  applyOffTheRecord,
  compileOffTheRecordMarkers,
  compileRedactionPatterns,
  redactText,
  type CompiledOffTheRecordMarkers,
} from "./redaction.js";
import { loadSpeakerRegistry } from "./speakers.js";
import {
  loadSyncState,
  saveSyncState,
  updateSourceSyncState,
} from "./sync-state.js";
import type { LocationConfig } from "../location/types.js";
import type {
  WearableConversation,
  WearableSourceConnector,
  WearableSourceSettings,
  WearableSyncSummary,
  WearablesConfig,
} from "./types.js";

const PAGE_SAFETY_CEILING = 10_000;
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
  /**
   * Location config for the missing-only conversation location fill
   * (issue #2925). Absent, or location tagging disabled, changes nothing.
   */
  locationConfig?: LocationConfig;
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
  const byId = new Map<string, WearableConversation>();
  let cursor: string | null | undefined = undefined;
  const seenCursors = new Set<string>();
  const collect = () => [...byId.values()];
  for (let page = 0; page < PAGE_SAFETY_CEILING; page++) {
    const result = await connector.fetchConversations({
      date,
      timezone,
      cursor,
      signal,
    });
    for (const conversation of result.conversations) {
      byId.set(conversation.id, conversation);
    }
    if (!result.nextCursor) return { conversations: collect(), partial: false };
    if (seenCursors.has(result.nextCursor)) {
      warnings.push(
        `${connector.id}: provider pagination repeated cursor on ${date} — stopped to avoid an infinite loop; day may be partially synced (every sync refetches and re-warns while the provider misbehaves)`,
      );
      return { conversations: collect(), partial: true };
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  warnings.push(
    `${connector.id}: stopped paginating ${date} after the ${PAGE_SAFETY_CEILING}-page safety ceiling — day may be partially synced (every sync refetches and re-warns while this persists)`,
  );
  return { conversations: collect(), partial: true };
}

/** Visible marker appended to day files whose fetch hit the page cap. */
const PARTIAL_DAY_MARKER =
  "\n*Note: pagination safety cap reached during sync — this day may be incomplete.*\n";

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
  offTheRecordMarkers: CompiledOffTheRecordMarkers,
): CleanedDay {
  const { offTheRecordEnabled, redactionEnabled } = config;
  const out: CleanedDay = {
    conversations: [],
    segmentsKept: 0,
    segmentsDropped: 0,
    redactions: 0,
    correctionsApplied: 0,
  };
  for (const conversation of raw) {
    let current = conversation;
    if (offTheRecordEnabled) {
      const otr = applyOffTheRecord(current, offTheRecordMarkers);
      current = otr.conversation;
      out.segmentsDropped += otr.droppedSegments;
    }
    const cleaned = cleanConversation(
      current,
      settings.cleanup,
      config.fillerTokens,
    );
    current = cleaned.conversation;
    out.segmentsDropped += cleaned.droppedSegments;

    const segments = current.segments.map((segment) => {
      let text = segment.text;
      if (redactionEnabled) {
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
    memoriesBlocked: 0,
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
  const offTheRecordMarkers = compileOffTheRecordMarkers(
    config.offTheRecordMarkers,
  );

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
      offTheRecordMarkers,
    );
    summary.conversations += cleaned.conversations.length;
    summary.segmentsKept += cleaned.segmentsKept;
    summary.segmentsDropped += cleaned.segmentsDropped;
    summary.redactions += cleaned.redactions;
    summary.correctionsApplied += cleaned.correctionsApplied;

    if (deps.locationConfig) {
      await fillWearableConversationLocations(cleaned.conversations, {
        memoryDir: deps.memoryDir,
        config: deps.locationConfig,
      });
    }

    if (fetched.conversations.length === 0) {
      const existing = await deps.readDayContentHash(connector.id, date);
      if (existing !== null) {
        summary.warnings.push(
          `${connector.id}: provider returned no conversations for ${date} but a stored transcript exists — leaving it in place; delete the day file manually if the recordings were intentionally removed upstream`,
        );
      }
      continue;
    }

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
    const existingHash = await deps.readDayContentHash(connector.id, date);
    const changed = existingHash !== bodyHash;
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
          summary.memoriesBlocked += generated.tombstoneBlocked;
          summary.warnings.push(...generated.warnings);
          passClean = generated.completed;
          const { digestEnabled } = config;
          if (digestEnabled) {
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
      const seenNativeCursors = new Set<string>();
      for (let page = 0; page < PAGE_SAFETY_CEILING; page++) {
        let result;
        try {
          result = await connector.fetchNativeMemories({
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
          summary.memoriesBlocked += imported.tombstoneBlocked;
          importedNativeIds.push(...imported.importedIds);
          for (const id of imported.importedIds) alreadyImported.add(id);
        } catch (err) {
          if (isAbortError(err)) throw err;
          summary.warnings.push(
            `${connector.id}: native-memory import failed: ${describeErrorForOperator(err)} — skipped; it retries on the next sync`,
          );
          break;
        }
        if (!result.nextCursor) break;
        if (seenNativeCursors.has(result.nextCursor)) {
          summary.warnings.push(
            `${connector.id}: provider pagination repeated cursor during native-memory import — stopped to avoid an infinite loop; remaining items import on the next sync`,
          );
          break;
        }
        seenNativeCursors.add(result.nextCursor);
        cursor = result.nextCursor;
        if (page === PAGE_SAFETY_CEILING - 1) {
          summary.warnings.push(
            `${connector.id}: stopped native-memory import at the ${PAGE_SAFETY_CEILING}-page safety ceiling — remaining items import on the next sync`,
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
    summary.memoriesBlocked > 0 ||
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

  syncState = updateSourceSyncState(syncState, connector.id, {
    syncedAt: now.toISOString(),
    days: dates,
    dayHashes,
    memoryDayHashes,
    clearMemoryDays: failedMemoryDays,
    importedNativeMemoryIds: importedNativeIds,
  });
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
