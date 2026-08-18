/**
 * Sync orchestration (issue #2009): run sources in configured priority
 * order (cheapest first is the recommended arrangement), dedupe by
 * post_id + content fingerprint, stamp provenance, and route the mapped
 * memory through the trust gate (`suggest` → review queue, `store` →
 * direct write). Persisted state lives in `<stateDir>/state.json`
 * (dedupe map, per-source last sync + new counts, monthly cost ledger);
 * every ingested record is materialized under `<stateDir>/records/`.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { expandTildePath } from "@remnic/core";

import {
  monthlyCostCapUsd,
  resolveMcpClientCredentials,
  type XConnectorConfig,
  type XSourceConfig,
} from "./config.js";
import { isXObject } from "./guards.js";
import { recordFingerprint, suggestionForRecord } from "./normalize.js";
import { createXSource, unlimitedBudget, XBudgetTracker, type XSourceDeps } from "./sources.js";
import type {
  XMemorySink,
  XPostRecord,
  XSourceFetchOutcome,
  XSourceStatus,
  XSourceSyncSummary,
  XStatusReport,
  XSyncReport,
} from "./types.js";

const SEEN_CAP = 20_000;

interface SeenEntry {
  fingerprint: string;
  firstSeenAt: string;
  lastSeenAt: string;
  kind: string;
}

interface XSyncState {
  version: 1;
  seen: Record<string, SeenEntry>;
  lastSyncAt: Record<string, string>;
  /** new records recorded by the latest sync, per source id */
  lastNewCount: Record<string, number>;
  /** usd spent per "YYYY-MM", paid sources only */
  costLedger: Record<string, number>;
}

export interface XSyncDeps extends XSourceDeps {
  sink: XMemorySink;
}

function freshState(): XSyncState {
  return { version: 1, seen: {}, lastSyncAt: {}, lastNewCount: {}, costLedger: {} };
}

function monthKeyOf(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

function resolveStateDir(config: XConnectorConfig): string {
  return expandTildePath(config.stateDir);
}

function stringRecord(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

async function loadState(stateDir: string): Promise<{ state: XSyncState; warning?: string }> {
  const statePath = path.join(stateDir, "state.json");
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch {
    return { state: freshState() };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isXObject(parsed) || !isXObject(parsed.seen)) throw new Error("bad shape");
    const costLedger: Record<string, number> = {};
    if (isXObject(parsed.costLedger)) {
      for (const [key, value] of Object.entries(parsed.costLedger)) {
        if (typeof value === "number" && Number.isFinite(value)) costLedger[key] = value;
      }
    }
    const seen: Record<string, SeenEntry> = {};
    for (const [postId, entry] of Object.entries(parsed.seen)) {
      if (isXObject(entry) && typeof entry.fingerprint === "string") {
        seen[postId] = {
          fingerprint: entry.fingerprint,
          firstSeenAt: typeof entry.firstSeenAt === "string" ? entry.firstSeenAt : "",
          lastSeenAt: typeof entry.lastSeenAt === "string" ? entry.lastSeenAt : "",
          kind: typeof entry.kind === "string" ? entry.kind : "",
        };
      }
    }
    const lastNewCountRaw = isXObject(parsed.lastNewCount) ? parsed.lastNewCount : {};
    const lastNewCount: Record<string, number> = {};
    for (const [key, value] of Object.entries(lastNewCountRaw)) {
      if (typeof value === "number" && Number.isFinite(value)) lastNewCount[key] = value;
    }
    return {
      state: {
        version: 1,
        seen,
        lastSyncAt: stringRecord(isXObject(parsed.lastSyncAt) ? parsed.lastSyncAt : {}),
        lastNewCount,
        costLedger,
      },
    };
  } catch {
    // A corrupt state file only costs dedupe history (re-fetch, re-dedupe):
    // quarantine it and start fresh rather than failing the sync.
    const quarantine = `${statePath}.corrupt`;
    try {
      await rename(statePath, quarantine);
    } catch {
      // Leave it; the save below overwrites.
    }
    return {
      state: freshState(),
      warning: `state.json was unreadable and has been quarantined at ${quarantine}`,
    };
  }
}

async function saveState(stateDir: string, state: XSyncState): Promise<void> {
  const entries = Object.entries(state.seen);
  if (entries.length > SEEN_CAP) {
    // ponytail: FIFO prune by firstSeenAt; switch to an LRU store if a
    // single principal ever exceeds 20k live records.
    entries.sort((a, b) => compareIso(a[1].firstSeenAt, b[1].firstSeenAt, a[0], b[0]));
    for (const [postId] of entries.slice(0, entries.length - SEEN_CAP)) {
      delete state.seen[postId];
    }
  }
  const statePath = path.join(stateDir, "state.json");
  const tmpPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tmpPath, statePath);
}

function compareIso(a: string, b: string, idA: string, idB: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  // Total comparator: fall back to id so equal keys keep a stable order.
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}

function orderedSources(config: XConnectorConfig): XSourceConfig[] {
  const byId = new Map(config.sources.map((source) => [source.id, source]));
  const ordered: XSourceConfig[] = [];
  for (const id of config.sourcePriority) {
    const source = byId.get(id);
    if (source !== undefined) ordered.push(source);
  }
  for (const source of config.sources) {
    if (!config.sourcePriority.includes(source.id)) ordered.push(source);
  }
  return ordered;
}

async function writeRecordFile(stateDir: string, record: XPostRecord): Promise<void> {
  const recordsDir = path.join(stateDir, "records");
  await mkdir(recordsDir, { recursive: true });
  const safeName = record.postId.replace(/[^0-9A-Za-z._-]/g, "_");
  const recordPath = path.join(recordsDir, `${safeName}.json`);
  const tmpPath = `${recordPath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(tmpPath, recordPath);
}

/** Runs one sync cycle. Source-level degradation lands in the report, never a throw. */
export async function runXSync(config: XConnectorConfig, deps: XSyncDeps): Promise<XSyncReport> {
  const stateDir = resolveStateDir(config);
  await mkdir(path.join(stateDir, "records"), { recursive: true });
  const { state, warning } = await loadState(stateDir);
  if (warning !== undefined) {
    process.stderr.write(`[remnic-x] warning: ${warning}\n`);
  }
  const now = deps.now ?? (() => Date.now());
  const startedMs = now();
  const runId = randomUUID();
  const monthKey = monthKeyOf(startedMs);
  const knownIds = new Set(Object.keys(state.seen));

  const summaries: XSourceSyncSummary[] = [];
  let suggestionsSubmitted = 0;
  let memoriesStored = 0;
  let sinkFailures = 0;

  for (const sourceConfig of orderedSources(config)) {
    const summary: XSourceSyncSummary = {
      sourceId: sourceConfig.id,
      kind: sourceConfig.kind,
      recordsNew: 0,
      recordsKnown: 0,
      reads: 0,
      pages: 0,
    };
    const source = createXSource(sourceConfig, { ...deps, userId: config.userId });
    const budget =
      sourceConfig.kind === "mcp"
        ? new XBudgetTracker(sourceConfig.budget, state.costLedger[monthKey] ?? 0)
        : unlimitedBudget;
    let outcome: XSourceFetchOutcome;
    try {
      outcome = await source.fetch({ knownIds, budget });
    } catch (err) {
      summary.error = err instanceof Error ? err.message : String(err);
      summaries.push(summary);
      continue;
    }
    summary.reads = outcome.reads;
    summary.pages = outcome.pages;
    summary.skipped = outcome.skipped;

    for (const raw of outcome.records) {
      const record: XPostRecord = {
        ...raw,
        provenance: {
          sourceId: sourceConfig.id,
          sourceKind: sourceConfig.kind,
          syncRunId: runId,
          fetchedAt: new Date(startedMs).toISOString(),
        },
      };
      const fingerprint = recordFingerprint(record);
      const seenEntry = state.seen[record.postId];
      if (seenEntry !== undefined && seenEntry.fingerprint === fingerprint) {
        seenEntry.lastSeenAt = new Date(startedMs).toISOString();
        summary.recordsKnown += 1;
        continue;
      }
      knownIds.add(record.postId);
      state.seen[record.postId] = {
        fingerprint,
        firstSeenAt:
          seenEntry !== undefined && seenEntry.firstSeenAt.length > 0
            ? seenEntry.firstSeenAt
            : new Date(startedMs).toISOString(),
        lastSeenAt: new Date(startedMs).toISOString(),
        kind: record.kind,
      };
      summary.recordsNew += 1;
      try {
        await writeRecordFile(stateDir, record);
      } catch (err) {
        sinkFailures += 1;
        summary.error = `record write failed: ${err instanceof Error ? err.name : "write error"}`;
        continue;
      }
      try {
        const suggestion = suggestionForRecord(record);
        if (config.memoryMode === "store") {
          await deps.sink.storeMemory(suggestion);
          memoriesStored += 1;
        } else {
          await deps.sink.submitSuggestion(suggestion);
          suggestionsSubmitted += 1;
        }
      } catch {
        sinkFailures += 1;
      }
    }

    if (sourceConfig.kind === "mcp" && outcome.reads > 0) {
      state.costLedger[monthKey] =
        (state.costLedger[monthKey] ?? 0) + outcome.reads * sourceConfig.budget.costPerReadUsd;
    }
    state.lastSyncAt[sourceConfig.id] = new Date(startedMs).toISOString();
    state.lastNewCount[sourceConfig.id] = summary.recordsNew;
    summaries.push(summary);
  }

  const finishedMs = now();
  await saveState(stateDir, state);

  return {
    runId,
    startedAt: new Date(startedMs).toISOString(),
    finishedAt: new Date(finishedMs).toISOString(),
    memoryMode: config.memoryMode,
    sources: summaries,
    suggestionsSubmitted,
    memoriesStored,
    sinkFailures,
    monthKey,
    monthSpendUsd: state.costLedger[monthKey] ?? 0,
  };
}

/**
 * Offline status snapshot: config sources, availability, spend vs cap.
 * No network calls, no credit use.
 */
export async function getXStatus(
  config: XConnectorConfig,
  deps: Pick<XSyncDeps, "execImpl" | "env"> = {}
): Promise<XStatusReport> {
  const stateDir = resolveStateDir(config);
  const { state } = await loadState(stateDir);
  const monthKey = monthKeyOf(Date.now());
  const sources: XSourceStatus[] = [];
  for (let index = 0; index < config.sourcePriority.length; index++) {
    const id = config.sourcePriority[index];
    const sourceConfig = config.sources.find((entry) => entry.id === id);
    if (sourceConfig === undefined) continue;
    sources.push({
      sourceId: id,
      kind: sourceConfig.kind,
      priority: index,
      lastSyncAt: state.lastSyncAt[id] ?? null,
      lastRecordsNew: state.lastNewCount[id] ?? 0,
      ...(await probeAvailability(sourceConfig, deps)),
    });
  }
  const lastSyncValues = Object.values(state.lastSyncAt).sort();
  return {
    enabled: config.enabled,
    memoryMode: config.memoryMode,
    syncSchedule: config.syncSchedule,
    sources,
    seenCount: Object.keys(state.seen).length,
    monthKey,
    monthSpendUsd: state.costLedger[monthKey] ?? 0,
    monthlyCostCapUsd: monthlyCostCapUsd(config),
    lastSyncAt: lastSyncValues.length > 0 ? lastSyncValues[lastSyncValues.length - 1] : null,
  };
}

async function probeAvailability(
  sourceConfig: XSourceConfig,
  deps: Pick<XSyncDeps, "execImpl" | "env">
): Promise<{ available: boolean; availabilityDetail?: string }> {
  if (sourceConfig.kind === "corpusDir") {
    const dir = expandTildePath(sourceConfig.path);
    try {
      const info = await stat(dir);
      return info.isDirectory()
        ? { available: true }
        : { available: false, availabilityDetail: `${sourceConfig.path} is not a directory` };
    } catch {
      return { available: false, availabilityDetail: `${sourceConfig.path} not found` };
    }
  }
  if (sourceConfig.kind === "cli") {
    return { available: true, availabilityDetail: `assumed present (${sourceConfig.bin})` };
  }
  const credentials = resolveMcpClientCredentials(sourceConfig, deps.env ?? process.env);
  return credentials.clientId !== undefined && credentials.clientSecret !== undefined
    ? { available: true }
    : { available: false, availabilityDetail: "OAuth2 client credentials missing" };
}
