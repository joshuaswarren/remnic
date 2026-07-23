/**
 * WearablesService — the single implementation behind every wearables
 * access surface (CLI, MCP tools, HTTP routes). Surfaces stay thin and
 * delegate here; formatting differences live with the surface, behavior
 * lives here (same renderer-sharing rule as recall explain/xray).
 */

import {
  correctionsFilePath,
  loadCorrectionsFile,
  saveCorrectionsFile,
  compileCorrectionRule,
} from "./corrections.js";
import { describeErrorForOperator, WearablesInputError } from "./errors.js";
import { inferMemoryStatus } from "../memory-lifecycle-ledger-utils.js";
import {
  bodyIsEscaped,
  decodeTranscriptBody,
  escapeSegmentText,
  isValidTranscriptDate,
  parseDayTranscript,
} from "./day-store.js";
import {
  composeFusionDayMeta,
  type FusionArtifactStore,
  fuseDay as fuseDayInputs,
  hashFusionBody,
  parseFusionDay,
  reconstructFusionInputs,
  serializeFusionDay,
  type FusedWearableConversation,
} from "./fusion/index.js";
import { stripAttributesSuffix } from "../storage.js";
import { log } from "../logger.js";
import type { MemoryFrontmatter } from "../types.js";
import type { WearableMemoryGenDeps } from "./memory-gen.js";
import { WEARABLE_SOURCE_PREFIX, wearableSourceLabel } from "./memory-gen.js";
import {
  defaultTimezone,
  syncWearableSource,
  type WearableSyncOptions,
} from "./pipeline.js";
import {
  ensureBuiltInWearableConnectors,
  getWearableConnector,
  listWearableConnectors,
} from "./registry.js";
import {
  loadSpeakerRegistry,
  saveSpeakerRegistry,
  speakerRegistryKey,
  type SpeakerRegistry,
} from "./speakers.js";
import { loadSyncState } from "./sync-state.js";
import type {
  WearableCorrectionRule,
  WearableDayTranscript,
  WearableSourceSettings,
  WearableSourceStatus,
  WearableSyncSummary,
  WearablesConfig,
} from "./types.js";

/** Storage capabilities the service needs (satisfied by StorageManager). */
export interface WearableStorageIo {
  readonly dir: string;
  writeWearableDayTranscript(
    sourceId: string,
    date: string,
    serialized: string,
  ): Promise<void>;
  readWearableDayTranscript(
    sourceId: string,
    date: string,
  ): Promise<string | null>;
  listWearableTranscriptDays(
    sourceId?: string,
  ): Promise<Array<{ source: string; date: string }>>;
  fusionArtifactStore(): FusionArtifactStore;
  readAllMemories(): Promise<
    Array<{
      path: string;
      frontmatter: {
        id: string;
        source: string;
        created: string;
        tags: string[];
        status?: string;
        /** Archival timestamp — rows with this set are not support. */
        archivedAt?: string;
        structuredAttributes?: Record<string, string>;
      };
      content: string;
    }>
  >;
  writeSealedMemory: WearableMemoryGenDeps["writer"]["writeSealedMemory"];
  hasFactContentHash(content: string): Promise<boolean>;
  findWearableMemoryByContent(
    content: string,
  ): Promise<{ id: string; status: string | undefined } | null>;
  promoteWearableMemory(
    id: string,
    attributeUpdates: Record<string, string>,
    confidence?: number,
  ): Promise<boolean>;
  demoteWearableMemory(
    id: string,
    attributeUpdates: Record<string, string>,
  ): Promise<boolean>;
}

export interface WearableSearchBackend {
  /** Full-text search over the memory dir; null when unavailable. */
  search(
    query: string,
    maxResults: number,
  ): Promise<Array<{ path: string; score: number; preview: string }> | null>;
}

export interface WearablesServiceDeps {
  config: WearablesConfig;
  getStorage(): Promise<WearableStorageIo>;
  /** Extraction hook; null when no engine is available. */
  extract: WearableMemoryGenDeps["extract"] | null;
  /**
   * LLM-as-judge hook for smart memoryMode (the orchestrator wires the
   * existing extraction judge here). Absent degrades smart mode to
   * confidence x sourceTrust + corroboration scoring.
   */
  judgeFacts?: WearableMemoryGenDeps["judgeFacts"];
  /** Search backend (QMD); null disables indexed search. */
  searchBackend: WearableSearchBackend | null;
  /** Fired after transcript writes so the search index refreshes. */
  reindexSearch?: () => Promise<void>;
  /**
   * Meeting tail-step (issue #1900): fired once after a sync with the union of
   * days it touched, so a dependent subsystem (meeting building) can rebuild the
   * affected day(s). Wired for EVERY sync path — auto-sync AND manual
   * HTTP/MCP/CLI backfill — because they all share this one service. Optional;
   * omitted by hosts that do not build meetings. The hook self-gates and never
   * fails the sync.
   */
  onDaysSynced?: (days: readonly string[]) => void | Promise<void>;
}

export interface WearableTranscriptSearchResult {
  source: string;
  date: string;
  score: number;
  snippet: string;
  /** "indexed" (QMD) or "scan" (substring fallback). */
  backend: "indexed" | "scan";
}

export interface WearableMemorySearchResult {
  id: string;
  source: string;
  date?: string;
  conversationId?: string;
  status?: string;
  content: string;
  created: string;
}

export interface WearableDayTranscriptView {
  source: string;
  date: string;
  meta: WearableDayTranscript["meta"] | null;
  body: string;
  /** Other sources that also recorded during this day (overlap hint). */
  overlapsWith: string[];
}

/**
 * Build the memory writer used by wearable syncs. The storage fact
 * hash index only covers category "fact", so dedup for the other
 * categories wearables write (moment digests, decisions, preferences,
 * commitments) additionally scans existing wearable-tagged memories for
 * an exact content match — without this, a forced or retried day
 * re-writes identical digests and candidates (Codex P2 on PR #1458).
 * The scan is bounded to wearable-sourced memories and sits on the
 * cached readAllMemories() path.
 */
export function createWearableMemoryWriter(
  storage: WearableStorageIo,
): WearableMemoryGenDeps["writer"] {
  return {
    writeSealedMemory: storage.writeSealedMemory.bind(storage),
    findWearableMemoryByContent: async (content: string) =>
      (await storage.findWearableMemoryByContent(content)) as
        | { id: string; status: import("../types.js").MemoryStatus | undefined }
        | null,
    promoteWearableMemory: storage.promoteWearableMemory.bind(storage),
    demoteWearableMemory: storage.demoteWearableMemory.bind(storage),
    hasFactContentHash: async (content: string) => {
      if (await storage.hasFactContentHash(content)) return true;
      // Compare with the "[Attributes: ...]" enrichment suffix removed
      // on BOTH sides — stored wearable bodies carry it, callers pass
      // raw fact text. Without the strip, digest/candidate dedup never
      // matched attribute-bearing memories.
      const needle = stripAttributesSuffix(content);
      const memories = await storage.readAllMemories();
      return memories.some(
        (memory) =>
          typeof memory.frontmatter.source === "string" &&
          memory.frontmatter.source.startsWith(`${WEARABLE_SOURCE_PREFIX}:`) &&
          stripAttributesSuffix(memory.content) === needle,
      );
    },
  };
}

/** Mirrors the storage-layer guard so surface inputs fail as 400s. */
const SOURCE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

function assertValidSourceId(source: string): void {
  if (!SOURCE_ID_PATTERN.test(source)) {
    throw new WearablesInputError(
      `invalid source id '${source}' — expected lowercase letters, digits, and dashes`,
    );
  }
}

const TRANSCRIPT_SEARCH_DEFAULT_LIMIT = 10;
const TRANSCRIPT_SEARCH_MAX_LIMIT = 50;
const MEMORY_LIST_DEFAULT_LIMIT = 50;
const MEMORY_LIST_MAX_LIMIT = 200;

export class WearablesService {
  constructor(private readonly deps: WearablesServiceDeps) {}

  get enabled(): boolean {
    return this.deps.config.enabled;
  }

  private assertEnabled(): void {
    if (!this.deps.config.enabled) {
      throw new WearablesInputError(
        "wearables are not enabled — set `wearables.enabled: true` (and configure at least one source) in the plugin config",
      );
    }
  }

  private timezone(): string {
    return this.deps.config.timezone ?? defaultTimezone();
  }

  private enabledSources(): Array<[string, WearableSourceSettings]> {
    return Object.entries(this.deps.config.sources).filter(
      ([, settings]) => settings.enabled,
    );
  }

  /** Status for every configured source (and connector availability). */
  async status(): Promise<{
    enabled: boolean;
    timezone: string;
    sources: WearableSourceStatus[];
    connectorsInstalled: string[];
  }> {
    await ensureBuiltInWearableConnectors();
    const storage = await this.deps.getStorage();
    const syncState = await loadSyncState(storage.dir);
    const sources: WearableSourceStatus[] = [];
    for (const [sourceId, settings] of Object.entries(this.deps.config.sources)) {
      const registration = getWearableConnector(sourceId);
      const days = await storage.listWearableTranscriptDays(sourceId).catch(() => []);
      const state = syncState.sources[sourceId];
      sources.push({
        source: sourceId,
        displayName: registration?.displayName ?? sourceId,
        enabled: settings.enabled,
        connectorInstalled: registration !== undefined,
        memoryMode: settings.memoryMode,
        lastSyncAt: state?.lastSyncAt ?? null,
        lastDateSynced: state?.lastDateSynced ?? null,
        transcriptDays: days.length,
      });
    }
    return {
      enabled: this.deps.config.enabled,
      timezone: this.timezone(),
      sources,
      connectorsInstalled: listWearableConnectors(),
    };
  }

  /** Run a sync for one source or all enabled sources. */
  async sync(
    options: WearableSyncOptions & { source?: string },
  ): Promise<WearableSyncSummary[]> {
    this.assertEnabled();
    await ensureBuiltInWearableConnectors();
    const storage = await this.deps.getStorage();

    let targets: Array<[string, WearableSourceSettings]>;
    if (options.source !== undefined) {
      assertValidSourceId(options.source);
      const settings = this.deps.config.sources[options.source];
      if (!settings) {
        throw new WearablesInputError(
          `unknown wearable source '${options.source}' — configured sources: ${
            Object.keys(this.deps.config.sources).join(", ") || "(none)"
          }`,
        );
      }
      if (!settings.enabled) {
        throw new WearablesInputError(
          `wearable source '${options.source}' is configured but disabled — set wearables.sources.${options.source}.enabled: true`,
        );
      }
      targets = [[options.source, settings]];
    } else {
      targets = this.enabledSources();
      if (targets.length === 0) {
        throw new WearablesInputError(
          "no wearable sources are enabled — configure wearables.sources.<id>.enabled: true",
        );
      }
    }

    const memoryGen: WearableMemoryGenDeps | null = this.deps.extract
      ? {
          extract: this.deps.extract,
          writer: createWearableMemoryWriter(storage),
          ...(this.deps.judgeFacts !== undefined
            ? { judgeFacts: this.deps.judgeFacts }
            : {}),
        }
      : null;

    const summaries: WearableSyncSummary[] = [];
    for (const [sourceId, settings] of targets) {
      const registration = getWearableConnector(sourceId);
      if (!registration) {
        throw new WearablesInputError(
          `wearable source '${sourceId}' is enabled but its connector package is not installed.\n` +
            `Install it alongside Remnic:\n  npm install @remnic/connector-${sourceId}`,
        );
      }
      const connector = registration.factory({
        settings,
        timezone: this.timezone(),
      });
      const summary = await syncWearableSource(
        connector,
        settings,
        this.deps.config,
        options,
        {
          memoryDir: storage.dir,
          readDayContentHash: async (source, date) => {
            const raw = await storage.readWearableDayTranscript(source, date);
            if (raw === null) return null;
            return parseDayTranscript(raw)?.meta.contentHash ?? null;
          },
          writeDayTranscript: (source, date, serialized) =>
            storage.writeWearableDayTranscript(source, date, serialized),
          afterWrites: this.deps.reindexSearch,
          memoryGen,
          // Cross-device corroboration evidence (smart mode): other
          // sources' stored transcripts for the same day...
          readOtherSourceDayBodies: async (date, excludeSource) => {
            const bodies = new Map<string, string>();
            const days = await storage.listWearableTranscriptDays();
            for (const entry of days) {
              if (entry.date !== date || entry.source === excludeSource) continue;
              if (bodies.size >= 4) break;
              const raw = await storage.readWearableDayTranscript(entry.source, entry.date);
              if (raw === null) continue;
              bodies.set(entry.source, parseDayTranscript(raw)?.body ?? raw);
            }
            return bodies;
          },
          // ...and existing memories for the support boost. Status
          // resolves through the canonical inferMemoryStatus so rows
          // archived via `archivedAt` (or an archive/ path) without an
          // explicit status never count. Explicit allow-list: active
          // rows AND pending_review rows — a borderline fact observed
          // again on a later day is repetition signal and the support
          // boost is how it earns promotion. Rejected/quarantined/
          // superseded/archived/forgotten rows never count (CLAUDE.md
          // rule 53). Bodies feed token matching with the
          // "[Attributes: ...]" enrichment suffix stripped — attribute
          // metadata must never grant corroboration.
          listSupportMemories: async () => {
            const memories = await storage.readAllMemories();
            const support: Array<{ id: string; content: string }> = [];
            for (const memory of memories) {
              // WearableStorageIo narrows MemoryFrontmatter for
              // testability; production hands us the real thing.
              const status = inferMemoryStatus(
                memory.frontmatter as MemoryFrontmatter,
                memory.path,
              );
              if (status !== "active" && status !== "pending_review") {
                continue;
              }
              support.push({
                id: memory.frontmatter.id,
                content: stripAttributesSuffix(memory.content),
              });
            }
            return support;
          },
        },
      );
      summaries.push(summary);
    }
    // Tail step (issue #1900): a wearable sync changed a day's audio, so fan out
    // the affected days to the injected build hook (wired to the meetings
    // service's debounced rebuild). Fires for every sync path — auto-sync and
    // manual HTTP/MCP/CLI backfill alike — since they all share this service.
    // The hook self-gates on meetings.enabled and coalesces; a failure here
    // never fails the sync that called us.
    const syncedDays = [...new Set(summaries.flatMap((summary) => summary.days))];
    if (syncedDays.length > 0 && this.deps.onDaysSynced) {
      try {
        await this.deps.onDaysSynced(syncedDays);
      } catch (err) {
        log.warn(
          `wearables: post-sync meeting build hook failed (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return summaries;
  }

  /** Verify connectivity/credentials for one source. */
  async checkAuth(sourceId: string): Promise<{ ok: boolean; detail?: string }> {
    this.assertEnabled();
    await ensureBuiltInWearableConnectors();
    assertValidSourceId(sourceId);
    const settings = this.deps.config.sources[sourceId];
    if (!settings) {
      throw new WearablesInputError(`unknown wearable source '${sourceId}'`);
    }
    const registration = getWearableConnector(sourceId);
    if (!registration) {
      return {
        ok: false,
        detail: `connector package @remnic/connector-${sourceId} is not installed`,
      };
    }
    const connector = registration.factory({
      settings,
      timezone: this.timezone(),
    });
    try {
      // Connector detail strings are authored guidance (plus
      // name+errno network summaries) — safe to pass through verbatim.
      return await connector.verifyAuth();
    } catch (err) {
      return {
        ok: false,
        detail: describeErrorForOperator(err),
      };
    }
  }

  /**
   * Full transcript(s) for a day. Without `source`, returns every
   * source that recorded that day, annotated with overlap hints.
   */
  async dayTranscript(
    date: string,
    sourceId?: string,
  ): Promise<WearableDayTranscriptView[]> {
    if (!isValidTranscriptDate(date)) {
      throw new WearablesInputError(`invalid date '${date}' — expected YYYY-MM-DD`);
    }
    if (sourceId !== undefined) assertValidSourceId(sourceId);
    const storage = await this.deps.getStorage();
    const targets =
      sourceId !== undefined
        ? [sourceId]
        : (await storage.listWearableTranscriptDays())
            .filter((entry) => entry.date === date)
            .map((entry) => entry.source);
    const views: WearableDayTranscriptView[] = [];
    for (const source of [...new Set(targets)]) {
      const raw = await storage.readWearableDayTranscript(source, date);
      if (raw === null) continue;
      const parsed = parseDayTranscript(raw);
      views.push({
        source,
        date,
        meta: parsed?.meta ?? null,
        // Decode escaped segment text for display: the stored body is an
        // internal line-based serialization (newlines/backslashes escaped
        // so segment text survives the serialize -> reconstruct round
        // trip); user-facing view surfaces must show the original text.
        // The fusion reconstruct path reads raw bodies separately and
        // decodes once during parse, so this never double-decodes (#1849).
        body: decodeTranscriptBody(parsed?.body ?? raw, bodyIsEscaped(parsed?.meta)),
        overlapsWith: [],
      });
    }
    for (const view of views) {
      view.overlapsWith = views
        .map((other) => other.source)
        .filter((other) => other !== view.source);
    }
    return views;
  }

  /** List days that have stored transcripts. */
  async listDays(
    sourceId?: string,
  ): Promise<Array<{ source: string; date: string }>> {
    if (sourceId !== undefined) assertValidSourceId(sourceId);
    const storage = await this.deps.getStorage();
    return storage.listWearableTranscriptDays(sourceId);
  }

  // -- cross-source fusion (#1810) -----------------------------------------

  /**
   * Fuse all enabled sources' stored transcripts for one day into a
   * derived `FusedWearableConversation[]` artifact. Deterministic and
   * idempotent: unchanged inputs and fusion config produce a stable
   * content hash and the derived file is left untouched on re-run. Requires
   * `wearables.fusion.enabled`; otherwise it throws. Raw per-source
   * transcripts are never modified.
   */
  async fuseDay(date: string): Promise<{
    date: string;
    sources: string[];
    conversationCount: number;
    contentHash: string;
    written: boolean;
    skipped?: { reason: string };
  }> {
    this.assertEnabled();
    if (!this.deps.config.fusion.enabled) {
      throw new WearablesInputError(
        "wearables fusion is not enabled — set `wearables.fusion.enabled: true` in the plugin config",
      );
    }
    if (!isValidTranscriptDate(date)) {
      throw new WearablesInputError(`invalid date '${date}' — expected YYYY-MM-DD`);
    }
    const storage = await this.deps.getStorage();
    const enabled = this.enabledSources();
    const bodies: Array<{ source: string; body: string; escaped?: boolean }> = [];
    const sourceTimezones: string[] = [];
    for (const [source] of enabled) {
      const raw = await storage.readWearableDayTranscript(source, date);
      if (raw === null) continue;
      const parsed = parseDayTranscript(raw);
      bodies.push({
        source,
        body: parsed?.body ?? raw,
        escaped: bodyIsEscaped(parsed?.meta),
      });
      sourceTimezones.push(parsed?.meta.timezone ?? "");
    }
    // Reconstruct the normalized inputs once and derive the sources that
    // actually CONTRIBUTE conversations/clocks for the day. The sync path
    // can persist an explicit EMPTY (all-elided / zero-conversation)
    // transcript for days whose segments were all dropped; such a file
    // contributes no clocks, so it must not influence the timezone guard
    // below.
    const reconstructed = reconstructFusionInputs(date, bodies);
    const contributing = bodies
      .map((entry, i) => ({
        source: entry.source,
        timezone: sourceTimezones[i] ?? "",
      }))
      .filter((entry) =>
        reconstructed.some((input) => input.source === entry.source),
      );
    // Mixed-timezone guard: reconstructFusionInputs rebuilds every clock as
    // `${date}T${HH}:${MM}:00Z` and compares local HH:MM clocks across sources
    // as if they shared one timezone. That comparison is ONLY valid when every
    // CONTRIBUTING source (one that reconstructs to >=1 conversation) carries
    // the SAME explicit IANA timezone id (meta.timezone). Sources that
    // reconstruct to zero conversations contribute no clocks and are ignored,
    // so an empty/all-elided transcript rendered under a different (or
    // missing) timezone cannot block a genuine same-zone fusion. Sampling one
    // UTC offset per source is insufficient: on DST-transition dates two
    // different zones can share a noon offset yet differ during recorded hours
    // (e.g. America/Los_Angeles vs America/Phoenix on 2026-03-08 — both UTC-7
    // by noon, an hour apart before LA's spring-forward). A source whose
    // timezone id is missing/empty is treated as unresolvable rather than
    // silently coerced to a default, so any unknown tz fails safe. Require
    // exact tz-id identity across all contributing sources.
    if (contributing.length > 1) {
      const referenceTz = contributing[0]!.timezone;
      const allSameExplicitTz =
        referenceTz.trim().length > 0 &&
        contributing.every((entry) => entry.timezone === referenceTz);
      if (!allSameExplicitTz) {
        const detail = contributing
          .map((entry) => `${entry.source}=${entry.timezone || "?"}`)
          .join(", ");
        log.warn(
          `wearables fusion: skipping ${date} — sources were rendered under differing timezones (${detail}); reconstructFusionInputs only compares local clocks correctly when every source shares one explicit IANA timezone id`,
        );
        // Clear any previously-fused artifact for this day: a day that
        // fused successfully before must not keep serving a stale view
        // now that this run explicitly refuses to fuse (issue #1849).
        await storage.fusionArtifactStore().deleteFusedDay(date);
        return {
          date,
          sources: [],
          conversationCount: 0,
          contentHash: "",
          written: false,
          skipped: { reason: "conflicting-timezones" },
        };
      }
    }
    const sourceTrust: Record<string, number> = {};
    for (const [id, settings] of enabled) {
      sourceTrust[id] = settings.sourceTrust;
    }
    const result = fuseDayInputs(date, reconstructed, {
      proximityGapMs: this.deps.config.fusion.proximityGapMs,
      windowToleranceMs: this.deps.config.fusion.windowToleranceMs,
      sourceTrust,
    });
    // Idempotent skip-unchanged: do not rewrite when the input content
    // hash matches the stored artifact, the stored body parsed cleanly
    // into a well-formed conversation set, AND the stored body hash still
    // matches a recompute over the stored body itself. A
    // truncated/corrupt/malformed-element body fails to parse
    // (parseOk:false) even when the frontmatter hash matches, and a body
    // whose bytes drifted fails the body-hash recompute even when the
    // input hash + conversation count still match — so either forces a
    // self-repair rewrite instead of trusting the hashes alone.
    const existingRaw = await storage.fusionArtifactStore().readFusedDay(date);
    const existing = parseFusionDay(existingRaw ?? "");
    // parseOk is bound to a local so the skip condition can keep the
    // explicit `existing !== null` guard for the `.meta` access below —
    // an inline `existing.parseOk` member check there trips
    // useOptionalChain (whose suggested fix would drop the guard and
    // null-deref the later access), so we read it via optional chain.
    const parsedCleanly = existing?.parseOk === true;
    const skipUnchanged =
      existing !== null &&
      parsedCleanly &&
      existing.meta.contentHash === result.contentHash &&
      existing.meta.bodyHash === hashFusionBody(existing.conversations);
    const written = !skipUnchanged;
    if (written) {
      const meta = composeFusionDayMeta(
        date,
        result.conversations,
        result.sources,
        result.contentHash,
        new Date().toISOString(),
      );
      await storage.fusionArtifactStore().writeFusedDay(
        date,
        serializeFusionDay(meta, result.conversations),
      );
    }
    return {
      date: result.date,
      sources: result.sources,
      conversationCount: result.conversations.length,
      contentHash: result.contentHash,
      written,
    };
  }

  /**
   * List fused conversations for a date (the fusion listing surface).
   * Returns the persisted derived artifact's conversations, or an empty
   * array when no fused artifact has been written for that day. When a
   * file EXISTS but its body is corrupt (parseOk:false), throws
   * WearablesInputError so the caller can distinguish a broken artifact
   * from a day that was never fused — never silently returns an empty
   * list that looks identical to "no artifact" (issue #1849).
   */
  async fusedConversations(
    date: string,
  ): Promise<FusedWearableConversation[]> {
    if (!isValidTranscriptDate(date)) {
      throw new WearablesInputError(`invalid date '${date}' — expected YYYY-MM-DD`);
    }
    const storage = await this.deps.getStorage();
    const raw = await storage.fusionArtifactStore().readFusedDay(date);
    if (raw === null) return [];
    const parsed = parseFusionDay(raw);
    if (parsed === null) return [];
    if (!parsed.parseOk) {
      throw new WearablesInputError(
        `fused artifact for ${date} is corrupt — re-run \`wearables fuse ${date}\` to repair`,
      );
    }
    return parsed.conversations;
  }

  /** List dates with stored fused artifacts, newest first. */
  async listFusedDays(): Promise<string[]> {
    const storage = await this.deps.getStorage();
    return storage.fusionArtifactStore().listFusedDays();
  }

  /**
   * Search stored transcripts. Uses the indexed backend when available
   * and falls back to a bounded substring scan otherwise — the two
   * paths are distinguishable in the result (`backend`) so callers can
   * tell "no hits" from "weaker search ran".
   */
  async searchTranscripts(
    query: string,
    options: {
      source?: string;
      from?: string;
      to?: string;
      limit?: number;
    } = {},
  ): Promise<WearableTranscriptSearchResult[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      throw new WearablesInputError("transcript search requires a non-empty query");
    }
    if (options.source !== undefined) assertValidSourceId(options.source);
    for (const [name, value] of [
      ["from", options.from],
      ["to", options.to],
    ] as const) {
      if (value !== undefined && !isValidTranscriptDate(value)) {
        throw new WearablesInputError(`invalid ${name} date '${value}' — expected YYYY-MM-DD`);
      }
    }
    const limit = clampLimit(
      options.limit,
      TRANSCRIPT_SEARCH_DEFAULT_LIMIT,
      TRANSCRIPT_SEARCH_MAX_LIMIT,
      "limit",
    );

    const matchesScope = (source: string, date: string): boolean => {
      if (options.source !== undefined && source !== options.source) return false;
      if (options.from !== undefined && date < options.from) return false;
      // Half-open scan semantics aren't meaningful for whole-day files;
      // `to` is inclusive of the named day.
      if (options.to !== undefined && date > options.to) return false;
      return true;
    };

    if (this.deps.searchBackend) {
      // The index stores escaped segment text (real newlines become
      // the two characters \n, lone backslashes are doubled). A query
      // containing those characters in their ORIGINAL decoded form will
      // not match the indexed representation, so we ALSO search the
      // escaped form. This keeps the indexed path at parity with the
      // scan fallback, which decodes the body before searching (#1849).
      const escaped = escapeSegmentText(trimmed);
      const queries =
        escaped === trimmed ? [trimmed] : [trimmed, escaped];
      const seen = new Set<string>();
      const results: WearableTranscriptSearchResult[] = [];
      const idxStorage = await this.deps.getStorage();
      for (const q of queries) {
        const hits = await this.deps.searchBackend.search(q, limit * 5);
        if (hits === null) break; // backend unavailable
        for (const hit of hits) {
          const located = locateTranscriptPath(hit.path);
          if (!located) continue;
          if (!matchesScope(located.source, located.date)) continue;
          const dedupeKey = `${located.source}:${located.date}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          // The indexed snippet mirrors the stored body's escape encoding.
          // Read the file once to learn whether it was written by the
          // escape-aware serializer so a LEGACY file's literal two-character
          // \n/\r is never decoded (#1849).
          const idxRaw =
            await idxStorage.readWearableDayTranscript(located.source, located.date);
          const idxMeta = parseDayTranscript(idxRaw ?? "")?.meta ?? null;
          results.push({
            source: located.source,
            date: located.date,
            score: hit.score,
            snippet: decodeTranscriptBody(hit.preview, bodyIsEscaped(idxMeta)),
            backend: "indexed",
          });
          if (results.length >= limit) break;
        }
        if (results.length >= limit) break;
      }
      // The index spans the whole memory dir, so ordinary memory
      // files can crowd transcripts out of the top hits entirely.
      // Zero in-scope hits therefore doesn't mean "no transcript
      // matches" — fall through to the bounded scan in that case
      // (Codex P2 on PR #1458). Partial result sets stay indexed-only
      // so the two backends never interleave in one response.
      if (results.length > 0) {
        return results;
      }
    }

    // Fallback scan: newest days first, bounded, case-insensitive.
    const storage = await this.deps.getStorage();
    const days = await storage.listWearableTranscriptDays(options.source);
    const needle = trimmed.toLowerCase();
    const results: WearableTranscriptSearchResult[] = [];
    for (const { source, date } of days) {
      if (!matchesScope(source, date)) continue;
      const raw = await storage.readWearableDayTranscript(source, date);
      if (raw === null) continue;
      const scanParsed = parseDayTranscript(raw);
      // Decode escaped segment text so searches match AND snippets show
      // the ORIGINAL text (e.g. a real newline or backslash), not the
      // internal escape serialization — but ONLY for bodies written by
      // the escape-aware serializer; legacy bodies are searched verbatim
      // (#1849).
      const body = decodeTranscriptBody(
        scanParsed?.body ?? raw,
        bodyIsEscaped(scanParsed?.meta),
      );
      const lower = body.toLowerCase();
      const index = lower.indexOf(needle);
      if (index === -1) continue;
      results.push({
        source,
        date,
        score: 0,
        snippet: extractSnippet(body, index, needle.length),
        backend: "scan",
      });
      if (results.length >= limit) break;
    }
    return results;
  }

  /**
   * Memories created from wearable transcripts, filterable by source
   * and/or day. Includes pending_review candidates — the whole point of
   * review mode is seeing what's queued.
   */
  async transcriptMemories(
    options: {
      source?: string;
      date?: string;
      limit?: number;
    } = {},
  ): Promise<WearableMemorySearchResult[]> {
    if (options.date !== undefined && !isValidTranscriptDate(options.date)) {
      throw new WearablesInputError(`invalid date '${options.date}' — expected YYYY-MM-DD`);
    }
    if (options.source !== undefined) assertValidSourceId(options.source);
    const limit = clampLimit(
      options.limit,
      MEMORY_LIST_DEFAULT_LIMIT,
      MEMORY_LIST_MAX_LIMIT,
      "limit",
    );
    const storage = await this.deps.getStorage();
    const memories = await storage.readAllMemories();
    const results: WearableMemorySearchResult[] = [];
    for (const memory of memories) {
      const source = memory.frontmatter.source;
      if (typeof source !== "string" || !source.startsWith(`${WEARABLE_SOURCE_PREFIX}:`)) {
        continue;
      }
      const attrs = memory.frontmatter.structuredAttributes ?? {};
      const sourceId = attrs.wearableSource;
      if (options.source !== undefined) {
        if (
          sourceId !== options.source &&
          source !== wearableSourceLabel(options.source) &&
          source !== `${wearableSourceLabel(options.source)}:native`
        ) {
          continue;
        }
      }
      if (options.date !== undefined && attrs.wearableDate !== options.date) {
        continue;
      }
      results.push({
        id: memory.frontmatter.id,
        source: sourceId ?? source,
        date: attrs.wearableDate,
        conversationId: attrs.wearableConversationId,
        status: memory.frontmatter.status,
        content: memory.content,
        created: memory.frontmatter.created,
      });
    }
    results.sort((a, b) => {
      if (a.created > b.created) return -1;
      if (a.created < b.created) return 1;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
    return results.slice(0, limit);
  }

  // -- speakers -------------------------------------------------------------

  async listSpeakers(): Promise<SpeakerRegistry> {
    const storage = await this.deps.getStorage();
    return loadSpeakerRegistry(storage.dir);
  }

  async setSpeaker(
    sourceId: string,
    speakerKey: string,
    name: string,
    opts: { isSelf?: boolean } = {},
  ): Promise<SpeakerRegistry> {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new WearablesInputError("speaker name must be a non-empty string");
    }
    if (typeof speakerKey !== "string" || speakerKey.trim().length === 0) {
      throw new WearablesInputError("speaker key must be a non-empty string");
    }
    const storage = await this.deps.getStorage();
    const registry = await loadSpeakerRegistry(storage.dir);
    registry.speakers[speakerRegistryKey(sourceId, speakerKey.trim())] = {
      name: name.trim(),
      ...(opts.isSelf === true ? { isSelf: true } : {}),
      updatedAt: new Date().toISOString(),
    };
    await saveSpeakerRegistry(storage.dir, registry);
    return registry;
  }

  async setSelfName(name: string): Promise<SpeakerRegistry> {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new WearablesInputError("self name must be a non-empty string");
    }
    const storage = await this.deps.getStorage();
    const registry = await loadSpeakerRegistry(storage.dir);
    registry.selfName = name.trim();
    await saveSpeakerRegistry(storage.dir, registry);
    return registry;
  }

  async removeSpeaker(
    sourceId: string,
    speakerKey: string,
  ): Promise<SpeakerRegistry> {
    const storage = await this.deps.getStorage();
    const registry = await loadSpeakerRegistry(storage.dir);
    const key = speakerRegistryKey(sourceId, speakerKey.trim());
    if (!(key in registry.speakers)) {
      throw new WearablesInputError(`no speaker override stored for '${key}'`);
    }
    delete registry.speakers[key];
    await saveSpeakerRegistry(storage.dir, registry);
    return registry;
  }

  // -- corrections ----------------------------------------------------------

  async listCorrections(): Promise<{
    fromConfig: WearableCorrectionRule[];
    fromState: WearableCorrectionRule[];
    stateFilePath: string;
  }> {
    const storage = await this.deps.getStorage();
    return {
      fromConfig: this.deps.config.corrections,
      fromState: await loadCorrectionsFile(storage.dir),
      stateFilePath: correctionsFilePath(storage.dir),
    };
  }

  async addCorrection(rule: WearableCorrectionRule): Promise<void> {
    // Validate before persisting so a bad rule fails the command, not
    // the next sync.
    compileCorrectionRule(rule, "correction");
    const storage = await this.deps.getStorage();
    const rules = await loadCorrectionsFile(storage.dir);
    const duplicate = rules.some(
      (existing) =>
        existing.match === rule.match &&
        existing.replace === rule.replace &&
        (existing.regex === true) === (rule.regex === true),
    );
    if (duplicate) {
      throw new WearablesInputError(
        `an identical correction rule already exists (match: ${JSON.stringify(rule.match)})`,
      );
    }
    rules.push(rule);
    await saveCorrectionsFile(storage.dir, rules);
  }

  async removeCorrection(index: number): Promise<WearableCorrectionRule> {
    if (!Number.isInteger(index) || index < 0) {
      throw new WearablesInputError(`invalid correction index '${index}'`);
    }
    const storage = await this.deps.getStorage();
    const rules = await loadCorrectionsFile(storage.dir);
    if (index >= rules.length) {
      throw new WearablesInputError(
        `correction index ${index} is out of range (have ${rules.length} state rule${rules.length === 1 ? "" : "s"})`,
      );
    }
    const [removed] = rules.splice(index, 1);
    await saveCorrectionsFile(storage.dir, rules);
    return removed;
  }
}

function clampLimit(
  value: number | undefined,
  fallback: number,
  max: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > max) {
    throw new WearablesInputError(
      `invalid ${label} '${value}' — expected an integer between 1 and ${max}`,
    );
  }
  return value;
}

/** Map an indexed-search hit path back to (source, date), or null. */
export function locateTranscriptPath(
  hitPath: string,
): { source: string; date: string } | null {
  const normalized = hitPath.replace(/\\/g, "/");
  const match = normalized.match(
    /(?:^|\/)wearables\/([a-z][a-z0-9-]{0,63})\/(\d{4}-\d{2}-\d{2})\.md$/,
  );
  if (!match) return null;
  if (!isValidTranscriptDate(match[2])) return null;
  return { source: match[1], date: match[2] };
}

function extractSnippet(body: string, index: number, matchLength: number): string {
  const start = Math.max(0, index - 80);
  const end = Math.min(body.length, index + matchLength + 80);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < body.length ? "…" : "";
  return `${prefix}${body.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}
