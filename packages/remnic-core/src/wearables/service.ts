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
import { isValidTranscriptDate, parseDayTranscript } from "./day-store.js";
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
  readAllMemories(): Promise<
    Array<{
      path: string;
      frontmatter: {
        id: string;
        source: string;
        created: string;
        tags: string[];
        status?: string;
        structuredAttributes?: Record<string, string>;
      };
      content: string;
    }>
  >;
  writeMemory: WearableMemoryGenDeps["writer"]["writeMemory"];
  hasFactContentHash(content: string): Promise<boolean>;
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
  /** Search backend (QMD); null disables indexed search. */
  searchBackend: WearableSearchBackend | null;
  /** Fired after transcript writes so the search index refreshes. */
  reindexSearch?: () => Promise<void>;
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
    writeMemory: storage.writeMemory.bind(storage),
    hasFactContentHash: async (content: string) => {
      if (await storage.hasFactContentHash(content)) return true;
      const needle = content.trim();
      const memories = await storage.readAllMemories();
      return memories.some(
        (memory) =>
          typeof memory.frontmatter.source === "string" &&
          memory.frontmatter.source.startsWith(`${WEARABLE_SOURCE_PREFIX}:`) &&
          memory.content.trim() === needle,
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
          afterTranscriptsWritten: this.deps.reindexSearch,
          memoryGen,
        },
      );
      summaries.push(summary);
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
        body: parsed?.body ?? raw,
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
      const hits = await this.deps.searchBackend.search(trimmed, limit * 5);
      if (hits !== null) {
        const results: WearableTranscriptSearchResult[] = [];
        for (const hit of hits) {
          const located = locateTranscriptPath(hit.path);
          if (!located) continue;
          if (!matchesScope(located.source, located.date)) continue;
          results.push({
            source: located.source,
            date: located.date,
            score: hit.score,
            snippet: hit.preview,
            backend: "indexed",
          });
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
      const body = parseDayTranscript(raw)?.body ?? raw;
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
