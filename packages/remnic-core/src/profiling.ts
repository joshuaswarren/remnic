// Performance profiling collector for recall and extraction traces.
// Zero external dependencies — uses only node:fs and node:path.

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  promises as fsp,
} from "node:fs";
import { join } from "node:path";

import { log } from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProfileSpan {
  name: string;
  startOffsetMs: number;
  durationMs: number;
}

export interface ProfileParallelGroupMember {
  name: string;
  durationMs: number;
  resolvedIndex: number;
}

export interface ProfileParallelGroup {
  name: string;
  startOffsetMs: number;
  wallMs: number;
  members: ProfileParallelGroupMember[];
}

export interface ProfileTrace {
  ts: string;
  kind: "recall" | "extraction";
  traceId: string;
  sessionKey?: string;
  totalMs: number;
  spans: ProfileSpan[];
  parallelGroups?: ProfileParallelGroup[];
  configSnapshot?: Record<string, unknown>;
}

export interface ProfilingConfig {
  enabled: boolean;
  storageDir: string;
  maxTraces: number;
}

export interface ParallelGroupHandle {
  name: string;
  startOffsetMs: number;
  traceId?: string;
}

export interface ProfilingStats {
  byKind: Record<string, { count: number; avgMs: number; p50Ms: number; p95Ms: number; maxMs: number }>;
  bySpan: Record<string, { count: number; avgMs: number; p50Ms: number; p95Ms: number; maxMs: number }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function aggregateStats(values: number[]): { count: number; avgMs: number; p50Ms: number; p95Ms: number; maxMs: number } {
  const count = values.length;
  if (count === 0) return { count: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    count,
    avgMs: Math.round(sum / count),
    p50Ms: Math.round(percentile(sorted, 50)),
    p95Ms: Math.round(percentile(sorted, 95)),
    maxMs: sorted[sorted.length - 1],
  };
}

let traceCounter = 0;

// ---------------------------------------------------------------------------
// ProfilingCollector
// ---------------------------------------------------------------------------

export class ProfilingCollector {
  private enabled: boolean;
  private storageDir: string;
  private maxTraces: number;
  private traces: ProfileTrace[] = [];
  private prunePromise: Promise<void> | null = null;

  // Active trace state — keyed by traceId so concurrent pipelines are isolated.
  private activeTraces = new Map<
    string,
    {
      kind: "recall" | "extraction";
      start: number;
      sessionKey?: string;
      configSnapshot?: Record<string, unknown>;
      spans: ProfileSpan[];
      spanStarts: Map<string, number>;
      parallelGroups: ProfileParallelGroup[];
    }
  >();
  private latestTraceId = "";

  constructor(config: ProfilingConfig) {
    this.enabled = config.enabled;
    this.storageDir = config.storageDir;
    this.maxTraces = Math.max(0, config.maxTraces);

    if (this.enabled) {
      if (!existsSync(this.storageDir)) {
        mkdirSync(this.storageDir, { recursive: true });
        log.debug(`profiling: created storage dir ${this.storageDir}`);
      }
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  // ---- Trace lifecycle ---------------------------------------------------

  startTrace(kind: "recall" | "extraction", sessionKey?: string, configSnapshot?: Record<string, unknown>): string {
    if (!this.enabled) return "";
    traceCounter++;
    const traceId = `t${traceCounter}-${Date.now().toString(36)}`;
    this.activeTraces.set(traceId, {
      kind,
      start: Date.now(),
      sessionKey,
      configSnapshot,
      spans: [],
      spanStarts: new Map(),
      parallelGroups: [],
    });
    this.latestTraceId = traceId;
    log.debug(`profiling: started trace ${traceId} kind=${kind}`);
    return traceId;
  }

  startSpan(name: string, traceId?: string): void {
    const tid = traceId ?? this.latestTraceId;
    const t = tid ? this.activeTraces.get(tid) : undefined;
    if (!t) return;
    const offset = Date.now() - t.start;
    t.spanStarts.set(name, Date.now());
    log.debug(`profiling: span ${name} started at +${offset}ms (trace=${tid})`);
  }

  endSpan(name: string, traceId?: string): void {
    const tid = traceId ?? this.latestTraceId;
    const t = tid ? this.activeTraces.get(tid) : undefined;
    if (!t) return;
    const start = t.spanStarts.get(name);
    if (start === undefined) return;
    const duration = Date.now() - start;
    const startOffset = start - t.start;
    t.spans.push({ name, startOffsetMs: startOffset, durationMs: duration });
    t.spanStarts.delete(name);
    log.debug(`profiling: span ${name} ended ${duration}ms (trace=${tid})`);
  }

  endTrace(traceId?: string): ProfileTrace | null {
    const tid = traceId ?? this.latestTraceId;
    const t = tid ? this.activeTraces.get(tid) : undefined;
    if (!t) return null;

    // Auto-close any spans still open when the trace finalizes.
    const now = Date.now();
    for (const [name, start] of t.spanStarts) {
      const duration = now - start;
      const startOffset = start - t.start;
      t.spans.push({ name, startOffsetMs: startOffset, durationMs: duration });
      log.debug(`profiling: auto-closed span ${name} at trace end (${duration}ms, trace=${tid})`);
    }
    t.spanStarts.clear();

    const trace: ProfileTrace = {
      ts: new Date().toISOString(),
      kind: t.kind,
      traceId: tid,
      totalMs: Date.now() - t.start,
      spans: t.spans,
      configSnapshot: t.configSnapshot,
    };

    if (t.sessionKey) {
      trace.sessionKey = t.sessionKey;
    }
    if (t.parallelGroups.length > 0) {
      trace.parallelGroups = t.parallelGroups;
    }

    // Remove from active map.
    this.activeTraces.delete(tid);

    if (!this.enabled) {
      log.debug("profiling: trace discarded (disabled)");
      return null;
    }

    // Persist.
    this.persistTrace(trace);

    // Buffer in memory (FIFO).
    this.traces.push(trace);
    if (this.traces.length > this.maxTraces) {
      this.traces.shift();
    }

    // Single-flight: if a prune is already running, piggyback on it;
    // otherwise start one.  This prevents concurrent prunes from racing
    // on stale directory snapshots.
    if (!this.prunePromise) {
      this.prunePromise = this.pruneFiles().finally(() => {
        this.prunePromise = null;
      });
    }
    log.debug(`profiling: trace ${trace.traceId} finalized totalMs=${trace.totalMs}`);
    return trace;
  }

  // ---- Parallel group tracking -------------------------------------------

  startParallelGroup(name: string, traceId?: string): ParallelGroupHandle {
    const tid = traceId ?? this.latestTraceId;
    const t = tid ? this.activeTraces.get(tid) : undefined;
    const startOffsetMs = t ? Date.now() - t.start : 0;
    return { name, startOffsetMs, traceId: tid };
  }

  async endParallelGroup(
    handle: ParallelGroupHandle,
    members: Array<{ name: string; promise: Promise<unknown> }>,
  ): Promise<void> {
    const wallStart = Date.now();

    let nextResolvedIndex = 0;
    const resolutionOrder = new Map<string, number>();

    const timed = members.map(async (m) => {
      const t0 = Date.now();
      try {
        await m.promise;
      } catch {
        // settled — still record order
      }
      resolutionOrder.set(m.name, nextResolvedIndex++);
      return { name: m.name, durationMs: Date.now() - t0 };
    });
    const timedResults = await Promise.allSettled(timed);

    const tid = handle.traceId ?? this.latestTraceId;
    const t = tid ? this.activeTraces.get(tid) : undefined;
    if (!t) return;

    const wallMs = Date.now() - wallStart;

    const groupMembers: ProfileParallelGroupMember[] = members.map((m, i) => {
      const timedResult = timedResults[i].status === "fulfilled"
        ? timedResults[i].value
        : { name: m.name, durationMs: wallMs };
      return {
        name: timedResult.name,
        durationMs: timedResult.durationMs,
        resolvedIndex: resolutionOrder.get(m.name) ?? i,
      };
    });

    t.parallelGroups.push({
      name: handle.name,
      startOffsetMs: handle.startOffsetMs,
      wallMs,
      members: groupMembers,
    });

    log.debug(`profiling: parallel group ${handle.name} wallMs=${wallMs} (trace=${tid})`);
  }

  // ---- Query methods -----------------------------------------------------

  getRecentTraces(limit?: number): ProfileTrace[] {
    if (limit === undefined || limit === Infinity) {
      return [...this.traces];
    }
    if (!Number.isFinite(limit)) {
      return [];
    }
    const n = Math.floor(limit);
    if (n <= 0) {
      return [];
    }
    return this.traces.slice(-n);
  }

  getStats(): ProfilingStats {
    const byKind: Record<string, number[]> = {};
    const bySpan: Record<string, number[]> = {};

    for (const trace of this.traces) {
      if (!byKind[trace.kind]) byKind[trace.kind] = [];
      byKind[trace.kind].push(trace.totalMs);

      for (const span of trace.spans) {
        if (!bySpan[span.name]) bySpan[span.name] = [];
        bySpan[span.name].push(span.durationMs);
      }
    }

    const result: ProfilingStats = { byKind: {}, bySpan: {} };
    for (const [k, v] of Object.entries(byKind)) {
      result.byKind[k] = aggregateStats(v);
    }
    for (const [k, v] of Object.entries(bySpan)) {
      result.bySpan[k] = aggregateStats(v);
    }
    return result;
  }

  identifyBottleneck(): string | null {
    if (this.traces.length === 0) return null;
    const latest = this.traces[this.traces.length - 1];
    if (latest.spans.length === 0) return null;
    let slowest = latest.spans[0];
    for (const span of latest.spans) {
      if (span.durationMs > slowest.durationMs) slowest = span;
    }
    return slowest.name;
  }

  // ---- Persistence -------------------------------------------------------

  private persistTrace(trace: ProfileTrace): void {
    const filename = `${trace.kind}-${trace.traceId}.jsonl`;
    const filepath = join(this.storageDir, filename);
    try {
      writeFileSync(filepath, JSON.stringify(trace) + "\n", "utf-8");
      log.debug(`profiling: persisted ${filename}`);
    } catch (err) {
      log.warn(`profiling: failed to persist ${filename}`, err);
    }
  }

  async pruneFiles(): Promise<void> {
    try {
      const dir = this.storageDir;
      const entries = await fsp.readdir(dir);
      const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));
      const withMtime = await Promise.all(
        jsonlFiles.map(async (f) => ({
          name: f,
          mtime: (await fsp.stat(join(dir, f))).mtimeMs,
        })),
      );
      const files = withMtime.sort((a, b) => a.mtime - b.mtime).map((f) => f.name);

      while (files.length > this.maxTraces) {
        const oldest = files.shift()!;
        await fsp.unlink(join(dir, oldest));
        log.debug(`profiling: pruned ${oldest}`);
      }
    } catch (err) {
      log.warn("profiling: prune failed", err);
    }
  }
}

// ---------------------------------------------------------------------------
// ASCII formatter
// ---------------------------------------------------------------------------

export function formatProfileTraceAscii(trace: ProfileTrace): string {
  const lines: string[] = [];
  const BAR_WIDTH = 40;

  lines.push(`=== Profile: ${trace.kind} ===`);
  lines.push(`Trace ID : ${trace.traceId}`);
  lines.push(`Total    : ${trace.totalMs}ms`);
  if (trace.sessionKey) lines.push(`Session  : ${trace.sessionKey}`);
  lines.push("");

  // Identify bottleneck.
  let bottleneckName: string | null = null;
  if (trace.spans.length > 0) {
    let slowest = trace.spans[0];
    for (const s of trace.spans) {
      if (s.durationMs > slowest.durationMs) slowest = s;
    }
    bottleneckName = slowest.name;
  }

  // Spans.
  if (trace.spans.length > 0) {
    const maxDuration = Math.max(...trace.spans.map((s) => s.durationMs), 1);
    lines.push("Spans:");
    for (const span of trace.spans) {
      const barLen = Math.max(1, Math.round((span.durationMs / maxDuration) * BAR_WIDTH));
      const bar = "\u2588".repeat(barLen);
      const suffix = span.name === bottleneckName ? " \u2190 bottleneck" : "";
      lines.push(`  ${span.name.padEnd(30)} ${String(span.durationMs).padStart(6)}ms ${bar}${suffix}`);
    }
    lines.push("");
  }

  // Parallel groups.
  if (trace.parallelGroups && trace.parallelGroups.length > 0) {
    lines.push("Parallel Groups:");
    for (const group of trace.parallelGroups) {
      lines.push(`  ${group.name}:`);
      lines.push(`    Wall time    : ${group.wallMs}ms`);
      const efficiency = parallelEfficiency(group);
      if (efficiency !== null) {
        lines.push(`    Efficiency   : ${efficiency}%`);
      }
      for (const member of group.members) {
        lines.push(`    [${String(member.resolvedIndex).padStart(2)}] ${member.name.padEnd(28)} ${String(member.durationMs).padStart(6)}ms`);
      }
    }
    lines.push("");
  }

  lines.push("---");
  return lines.join("\n");
}

function parallelEfficiency(group: ProfileParallelGroup): number | null {
  if (group.members.length <= 1) return null;
  const idealMs = Math.max(...group.members.map((m) => m.durationMs));
  if (group.wallMs === 0) return null;
  return Math.round((idealMs / group.wallMs) * 100);
}
