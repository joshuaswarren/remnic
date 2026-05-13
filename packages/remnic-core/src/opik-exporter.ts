import { createHash, randomBytes } from "node:crypto";
/**
 * opik-exporter.ts — Engram-native Opik trace exporter
 *
 * Subscribes to the globalThis.__openclawEngramTrace slot that Engram already
 * emits on, and forwards recall + LLM events to a self-hosted (or cloud) Opik
 * instance via its REST API. No extra npm dependencies — uses Node's built-in
 * fetch.
 *
 * Auto-detects apiUrl / projectName from the opik-openclaw plugin config so
 * traces land in the same project and are grouped by session thread.
 */

import fs from "node:fs";
import path from "node:path";

import type { LoggerBackend } from "./logger.js";
import { readEnvVar, resolveHomeDir } from "./runtime/env.js";

// GlobalThis slot that tracks the active OpikExporter instance.
// Used to make subscribe() idempotent across hot-reload / stop-start cycles.
const OPIK_EXPORTER_SLOT = "__openclawOpikExporter";

// ---------------------------------------------------------------------------
// Engram event types (mirrors types.ts without importing from it)
// ---------------------------------------------------------------------------

type EngramLlmTraceEvent = {
  kind: "llm_start" | "llm_end" | "llm_error";
  traceId: string;
  model: string;
  operation: "extraction" | "consolidation" | "profile_consolidation" | "identity_consolidation" | "day_summary";
  input?: string;
  output?: string;
  durationMs?: number;
  error?: string;
  tokenUsage?: { input?: number; output?: number; total?: number };
};

type EngramRecallTraceEvent = {
  kind: "recall_summary";
  traceId: string;
  operation: "recall";
  sessionKey?: string;
  promptLength: number;
  retrievalQueryLength: number;
  recallMode: string;
  recallResultLimit: number;
  qmdEnabled: boolean;
  qmdAvailable: boolean;
  recallNamespaces: string[];
  source: string;
  recalledMemoryCount: number;
  injected: boolean;
  contextChars: number;
  identityInjectionMode?: string;
  identityInjectedChars?: number;
  durationMs: number;
  timings?: Record<string, string>;
  recalledContent?: string;
};

type EngramTraceEvent = EngramLlmTraceEvent | EngramRecallTraceEvent;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OpikExporterConfig {
  enabled: boolean;
  /** Base URL of the Opik API, e.g. http://192.168.3.147:5173/api */
  apiUrl: string;
  projectName: string;
  workspaceName: string;
  /** Optional API key (not required for self-hosted deployments) */
  apiKey?: string;
  /** Include recalled memory text in spans (default false) */
  traceRecallContent: boolean;
}

// ---------------------------------------------------------------------------
// Auto-detect from opik-openclaw plugin config
// ---------------------------------------------------------------------------

function readOpikOpenclawConfig(log?: LoggerBackend): Partial<OpikExporterConfig> {
  try {
    const configPath =
      readEnvVar("OPENCLAW_ENGRAM_CONFIG_PATH") ||
      readEnvVar("OPENCLAW_CONFIG_PATH") ||
      path.join(resolveHomeDir(), ".openclaw", "openclaw.json");
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const entry = raw?.plugins?.entries?.["opik-openclaw"];
    if (!entry?.enabled || !entry?.config) return {};
    const c = entry.config as Record<string, unknown>;
    return {
      apiUrl: typeof c.apiUrl === "string" && c.apiUrl.length > 0 ? c.apiUrl : undefined,
      projectName: typeof c.projectName === "string" ? c.projectName : undefined,
      workspaceName: typeof c.workspaceName === "string" ? c.workspaceName : undefined,
      apiKey: typeof c.apiKey === "string" && c.apiKey.length > 0 ? c.apiKey : undefined,
    };
  } catch (err) {
    log?.debug?.(`[opik-exporter] could not read opik-openclaw config: ${err}`);
    return {};
  }
}

// ---------------------------------------------------------------------------
// UUID v7 generator (Opik requires v7, not v4)
// ---------------------------------------------------------------------------

function uuidV7(): string {
  const now = Date.now();
  const bytes = randomBytes(16);
  // Timestamp: 48-bit ms since epoch in bytes 0-5
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  // Version 7
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // Variant 10xx
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------

function buildHeaders(cfg: OpikExporterConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.workspaceName) headers["Comet-Workspace"] = cfg.workspaceName;
  // Opik expects the raw API key in the authorization header without a Bearer prefix.
  if (cfg.apiKey) headers["authorization"] = cfg.apiKey;
  return headers;
}

async function postSpanBatch(
  cfg: OpikExporterConfig,
  spans: unknown[],
  log: LoggerBackend,
): Promise<void> {
  const url = `${cfg.apiUrl.replace(/\/$/, "")}/v1/private/spans/batch`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(cfg),
      body: JSON.stringify({ spans }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.debug?.(`[opik-exporter] span batch failed ${res.status}: ${text}`);
    }
  } catch (err) {
    log.debug?.(`[opik-exporter] span batch error: ${err}`);
  }
}

async function postTraceBatch(
  cfg: OpikExporterConfig,
  traces: unknown[],
  log: LoggerBackend,
): Promise<boolean> {
  const url = `${cfg.apiUrl.replace(/\/$/, "")}/v1/private/traces/batch`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(cfg),
      body: JSON.stringify({ traces }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.debug?.(`[opik-exporter] trace batch failed ${res.status}: ${text}`);
      return false;
    }
    return true;
  } catch (err) {
    log.debug?.(`[opik-exporter] trace batch error: ${err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// In-flight LLM span tracking
// ---------------------------------------------------------------------------

type InFlightLlm = {
  startedAt: number;
  startTime: string;
  model: string;
  operation: string;
  input?: string;
  spanId: string;
  traceId: string;
};

// ---------------------------------------------------------------------------
// Main exporter class
// ---------------------------------------------------------------------------

export class OpikExporter {
  private readonly cfg: OpikExporterConfig;
  private readonly log: LoggerBackend;
  private _handler: ((e: EngramTraceEvent) => void) | undefined;
  private readonly inFlight = new Map<string, InFlightLlm>();
  /** Track which trace_ids we have already created parent trace objects for. */
  private readonly createdTraces = new Set<string>();
  /** In-flight ensureTrace promises keyed by traceId — concurrent callers await the same promise. */
  private readonly pendingTraces = new Map<string, Promise<void>>();
  /** TTL for in-flight LLM entries (ms). Entries older than this are discarded. */
  private static readonly IN_FLIGHT_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(cfg: OpikExporterConfig, log: LoggerBackend) {
    this.cfg = cfg;
    this.log = log;
  }

  /**
   * Subscribe to Engram's global trace slot. Safe to call multiple times —
   * chains with existing subscribers (e.g. Langfuse) rather than replacing.
   */
  subscribe(): void {
    if (!this.cfg.enabled) return;

    // Idempotency guard: if this exact instance is already registered on globalThis,
    // skip re-wrapping to avoid stacking callbacks on hot-reload / stop-start cycles.
    const g = globalThis as Record<string, unknown>;
    const active = g[OPIK_EXPORTER_SLOT] as OpikExporter | undefined;
    if (active === this) {
      this.log.debug?.("[opik-exporter] already subscribed — skipping duplicate");
      return;
    }
    // If a different (stale) exporter instance is registered, evict it first.
    if (active) active._detach();

    g[OPIK_EXPORTER_SLOT] = this;

    const existing = g.__openclawEngramTrace as
      | ((e: EngramTraceEvent) => void)
      | undefined;

    const handler = (event: EngramTraceEvent) => {
      try {
        this.handleEvent(event);
      } catch (err) {
        this.log.debug?.(`[opik-exporter] handler error: ${err}`);
      }
    };
    // Store handler ref so _detach() can remove it from the chain.
    this._handler = handler;

    // Chain: call existing subscribers first, then ours.
    // NOTE: when _detach() is later called, it marks this.cfg.enabled = false
    // rather than restoring the chain, so that any subscriber that chained
    // *after* us is not dropped. The cost is one disabled no-op wrapper
    // remaining in the chain per stop/start cycle. In practice, Engram
    // restarts Opik only a handful of times per process lifetime, so the
    // overhead is negligible (one boolean check per leftover closure).
    g.__openclawEngramTrace =
      typeof existing === "function"
        ? (event: EngramTraceEvent) => {
            try { existing(event); } catch { /* prior subscriber threw; continue */ }
            handler(event);
          }
        : handler;

    this.log.info(
      `[opik-exporter] subscribed — apiUrl=${this.cfg.apiUrl} project=${this.cfg.projectName}`,
    );
  }

  /** Deactivate this exporter instance.
   *
   * We intentionally do NOT restore __openclawEngramTrace to a prior handler
   * because any subscriber that chained *after* us would be silently dropped
   * by such a restoration. Instead we mark the instance as disabled so that
   * handleEvent() becomes a no-op while the callback chain itself is left
   * untouched. The next subscribe() call from a fresh instance will re-enter
   * the chain on top of whatever is there at that point.
   */
  _detach(): void {
    const g = globalThis as Record<string, unknown>;
    // Only clear the global slot if we are still the active exporter.
    // A stale instance must not evict a newer exporter that already took over.
    if (g[OPIK_EXPORTER_SLOT] === this) delete g[OPIK_EXPORTER_SLOT];
    // Disable event processing; the wrapper closure in the chain becomes a no-op.
    (this.cfg as OpikExporterConfig & { enabled: boolean }).enabled = false;
    this._handler = undefined;
    this.log.debug?.("[opik-exporter] detached — events silenced, chain preserved");
  }

  unsubscribe(): void {
    this._detach();
  }

  private handleEvent(event: EngramTraceEvent): void {
    if (!this.cfg.enabled) return; // guard for after _detach()
    if (event.kind === "recall_summary") {
      void this.onRecall(event);
    } else if (event.kind === "llm_start") {
      this.onLlmStart(event);
    } else if (event.kind === "llm_end" || event.kind === "llm_error") {
      void this.onLlmEnd(event);
    }
  }

  // -------------------------------------------------------------------------
  // Recall events → general span
  // -------------------------------------------------------------------------

  private async onRecall(evt: EngramRecallTraceEvent): Promise<void> {
    const now = new Date();
    const startTime = new Date(now.getTime() - evt.durationMs).toISOString();
    const endTime = now.toISOString();

    const input: Record<string, unknown> = {
      recallMode: evt.recallMode,
      recalledMemoryCount: evt.recalledMemoryCount,
      recallNamespaces: evt.recallNamespaces,
      source: evt.source,
      qmdEnabled: evt.qmdEnabled,
      qmdAvailable: evt.qmdAvailable,
      retrievalQueryLength: evt.retrievalQueryLength,
      recallResultLimit: evt.recallResultLimit,
      promptLength: evt.promptLength,
    };

    if (this.cfg.traceRecallContent && evt.recalledContent) {
      input.recalledContent = evt.recalledContent;
    }

    const metadata: Record<string, unknown> = {
      source: "engram",
      injected: evt.injected,
      contextChars: evt.contextChars,
      durationMs: evt.durationMs,
    };

    if (evt.identityInjectionMode) {
      metadata.identityInjectionMode = evt.identityInjectionMode;
      metadata.identityInjectedChars = evt.identityInjectedChars;
    }

    if (evt.timings) metadata.timings = evt.timings;

    const traceId = evt.sessionKey ? this.sessionToTraceId(evt.sessionKey) : uuidV7();

    // Ensure parent trace exists so the span is not orphaned in Opik.
    await this.ensureTrace(traceId, evt.sessionKey ?? "engram:recall", startTime, endTime);

    const output: Record<string, unknown> = {
      injected: evt.injected,
      recalledMemoryCount: evt.recalledMemoryCount,
      contextChars: evt.contextChars,
      durationMs: evt.durationMs,
    };
    if (this.cfg.traceRecallContent && evt.recalledContent) {
      output.recalledContent = evt.recalledContent;
    }

    const span = {
      id: uuidV7(),
      trace_id: traceId,
      project_name: this.cfg.projectName,
      name: "engram:recall",
      type: "general",
      start_time: startTime,
      end_time: endTime,
      input,
      output,
      metadata,
      tags: ["engram", "recall"],
    };

    await postSpanBatch(this.cfg, [span], this.log);
  }

  // -------------------------------------------------------------------------
  // Engram internal LLM events (extraction / consolidation) → llm span
  // -------------------------------------------------------------------------

  private onLlmStart(evt: EngramLlmTraceEvent): void {
    // Use evt.traceId (Engram's correlation key) as the Opik spanId so spans
    // are deterministic and stable across retries. Derive a per-call Opik
    // trace_id from the same key so each LLM call maps to its own trace.
    this.inFlight.set(evt.traceId, {
      startedAt: Date.now(),
      startTime: new Date().toISOString(),
      model: evt.model,
      operation: evt.operation,
      input: evt.input,
      spanId: this.sessionToTraceId(evt.traceId + ":span"),
      traceId: this.sessionToTraceId(evt.traceId),
    });
  }

  private sweepStaleInFlight(): void {
    const cutoff = Date.now() - OpikExporter.IN_FLIGHT_TTL_MS;
    for (const [id, entry] of this.inFlight) {
      if (entry.startedAt < cutoff) {
        this.inFlight.delete(id);
      }
    }
  }

  private async onLlmEnd(evt: EngramLlmTraceEvent): Promise<void> {
    // Opportunistically sweep stale entries to prevent unbounded map growth.
    if (this.inFlight.size > 20) this.sweepStaleInFlight();
    const state = this.inFlight.get(evt.traceId);
    this.inFlight.delete(evt.traceId);

    const startTime = state?.startTime ?? new Date().toISOString();
    const endTime = new Date().toISOString();

    const usage: Record<string, number> = {};
    if (evt.tokenUsage?.input != null) usage.prompt_tokens = evt.tokenUsage.input;
    if (evt.tokenUsage?.output != null) usage.completion_tokens = evt.tokenUsage.output;
    if (evt.tokenUsage?.total != null) usage.total_tokens = evt.tokenUsage.total;

    const traceId = state?.traceId ?? uuidV7();

    // Ensure parent trace exists so the span is not orphaned in Opik.
    await this.ensureTrace(traceId, `engram:${evt.operation}`, startTime, endTime);

    const span: Record<string, unknown> = {
      id: state?.spanId ?? uuidV7(),
      trace_id: traceId,
      project_name: this.cfg.projectName,
      name: `engram:${evt.operation}`,
      type: "llm",
      model: evt.model,
      start_time: startTime,
      end_time: endTime,
      input: state?.input != null ? { prompt: state.input } : undefined,
      output:
        evt.kind === "llm_end" && evt.output != null
          ? { completion: evt.output }
          : evt.kind === "llm_error"
            ? { error: evt.error }
            : undefined,
      metadata: {
        source: "engram",
        operation: evt.operation,
        durationMs: evt.durationMs ?? (state ? Date.now() - state.startedAt : undefined),
      },
      tags: ["engram", evt.operation],
      usage: Object.keys(usage).length > 0 ? usage : undefined,
    };

    await postSpanBatch(this.cfg, [span], this.log);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Create a parent trace object in Opik if we haven't already.
   * Opik does NOT auto-create traces from spans, so without this
   * the spans are orphaned and don't show up in the trace list UI.
   */
  private async ensureTrace(
    traceId: string,
    name: string,
    startTime: string,
    endTime: string,
  ): Promise<void> {
    if (this.createdTraces.has(traceId)) return;

    // If another call is already creating this trace, wait for it and then
    // re-check — if the first attempt failed we'll retry below.
    const existing = this.pendingTraces.get(traceId);
    if (existing) {
      await existing;
      if (this.createdTraces.has(traceId)) return;
      // First attempt failed — check if another waiter is already retrying.
      const retrying = this.pendingTraces.get(traceId);
      if (retrying) {
        await retrying;
        // Only return if the retry actually succeeded.
        if (this.createdTraces.has(traceId)) return;
      }
      // No one else retrying; fall through to create.
    }

    const work = (async () => {
      const trace = {
        id: traceId,
        project_name: this.cfg.projectName,
        name,
        start_time: startTime,
        end_time: endTime,
        tags: ["engram"],
      };

      const ok = await postTraceBatch(this.cfg, [trace], this.log);
      if (!ok) {
        this.pendingTraces.delete(traceId);
        return; // transient failure — allow retry on next span
      }

      this.createdTraces.add(traceId);
      this.pendingTraces.delete(traceId);

      // Cap the set size to prevent unbounded growth in long-running processes.
      if (this.createdTraces.size > 10_000) {
        const first = this.createdTraces.values().next().value;
        if (first) this.createdTraces.delete(first);
      }
    })();

    this.pendingTraces.set(traceId, work);
    await work;
  }

  /**
   * Convert a sessionKey to a stable, deterministic UUID v7-shaped ID so that
   * spans for the same session share a trace_id and are threaded in Opik.
   * Uses SHA-256 for collision resistance. The timestamp bytes (0-5) come from
   * the hash itself — they don't reflect real time, but Opik only validates
   * the version/variant bits, not timestamp ordering.
   */
  private sessionToTraceId(sessionKey: string): string {
    const digest = createHash("sha256").update(sessionKey).digest();
    // Version 7 (bytes 0-5 are hash-derived, not real timestamps)
    digest[6] = (digest[6] & 0x0f) | 0x70;
    // Variant 10xx
    digest[8] = (digest[8] & 0x3f) | 0x80;
    const hex = digest.slice(0, 16).toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}

// ---------------------------------------------------------------------------
// Factory: build from Engram resolved config + auto-detect from opik-openclaw
// ---------------------------------------------------------------------------

export interface OpikExporterRawConfig {
  opikTraceEnabled?: boolean;
  opikApiUrl?: string;
  opikProjectName?: string;
  opikWorkspaceName?: string;
  opikApiKey?: string;
  opikTraceRecallContent?: boolean;
}

export function createOpikExporter(
  raw: OpikExporterRawConfig,
  log: LoggerBackend,
): OpikExporter | null {
  // Explicit opt-out: if set to false, never enable.
  if (raw.opikTraceEnabled === false) return null;

  // Auto-detect from opik-openclaw plugin config.
  // If opikTraceEnabled is not set (undefined), we enable automatically
  // whenever opik-openclaw is configured — avoids needing extra fields in
  // Engram's openclaw.json config section (which would fail schema validation).
  const detected = readOpikOpenclawConfig(log);

  const apiUrl = raw.opikApiUrl ?? detected.apiUrl;
  if (!apiUrl) {
    // Only warn when the user explicitly opted in but forgot to set the URL.
    // When auto-detecting (opikTraceEnabled not set), return silently so non-Opik
    // users see no log noise on every startup.
    if (raw.opikTraceEnabled === true) {
      log.warn(
        "[opik-exporter] opikTraceEnabled=true but no apiUrl found — " +
          "set opikApiUrl in Engram config or ensure opik-openclaw plugin is configured",
      );
    }
    return null;
  }

  const cfg: OpikExporterConfig = {
    enabled: true,
    apiUrl,
    projectName: raw.opikProjectName ?? detected.projectName ?? "openclaw",
    workspaceName: raw.opikWorkspaceName ?? detected.workspaceName ?? "default",
    apiKey: raw.opikApiKey ?? detected.apiKey,
    traceRecallContent: raw.opikTraceRecallContent === true,
  };

  return new OpikExporter(cfg, log);
}
