/**
 * Production timeline/activity regenerate flow (issue #2050).
 *
 * Builds deterministic cards, optionally runs analysis once, and persists
 * the day. Analysis failure keeps the deterministic cards. Concurrent
 * callers share one in-flight run. Surfaces (sync, CLI) call this function.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { FallbackLlmClient, fallbackLlmRuntimeContextFromConfig } from "../../fallback-llm.js";
import { LocalLlmClient } from "../../local-llm.js";
import type { PluginConfig } from "../../types.js";
import {
  activityDateInTimezone,
  activityDayWindow,
  hashActivityBody,
  isValidActivityDate,
} from "../digest.js";
import type { ActivitySnapshot, ActivityTimelineAnalysisConfig } from "../types.js";
import { applyTimelineCorrections, TimelineCorrectionStore } from "./corrections.js";
import { buildTimelineDay } from "./build.js";
import { runTimelineCardAnalysis, type TimelineAnalysisRunResult } from "./analysis-run.js";
import type {
  TimelineAnalysisLocalLlm,
  TimelineAnalysisRemoteLlm,
} from "./analysis-provider.js";
import type { AnalysisFailure } from "./analysis-failure.js";
import type { AnalysisRunMetadata } from "./analysis-metadata.js";
import type { TimelineAnalysisStatus } from "./analysis.js";
import type { TimelineCard, TimelineCorrection, TimelineObservation } from "./types.js";

export const TIMELINE_DAY_FORMAT_VERSION = 1;
export const TIMELINE_DAY_DIR = path.join("activity", "timeline");

export interface TimelineAnalysisClients {
  localLlm?: TimelineAnalysisLocalLlm | null;
  remoteLlm?: TimelineAnalysisRemoteLlm | null;
}

export interface RegenerateTimelineDayInput {
  date: string;
  timezone: string;
  memoryDir: string;
  store: { listSnapshotsForDay: (machine: string | null, startUtc: string, endUtc: string) => ActivitySnapshot[] };
  timelineEnabled: boolean;
  analysis: ActivityTimelineAnalysisConfig;
  deps?: TimelineAnalysisClients;
  pluginConfig?: PluginConfig;
  signal?: AbortSignal;
  corrections?: readonly TimelineCorrection[];
}

export interface PersistedTimelineDay {
  formatVersion: number;
  date: string;
  timezone: string;
  sourceHash: string;
  status: TimelineAnalysisStatus | "timeline_disabled";
  cards: TimelineCard[];
  metadata?: AnalysisRunMetadata;
  failure?: AnalysisFailure;
}

export interface RegenerateTimelineDayResult {
  status: TimelineAnalysisStatus | "timeline_disabled";
  cards: TimelineCard[];
  path: string;
  written: boolean;
  analyzed: boolean;
  metadata?: AnalysisRunMetadata;
  failure?: AnalysisFailure;
}

const inflight = new Map<string, Promise<RegenerateTimelineDayResult>>();

function requireToken(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

export function timelineDayPath(memoryDir: string, date: string): string {
  const root = requireToken(memoryDir, "memoryDir");
  if (!isValidActivityDate(date)) {
    throw new RangeError("date must be a real YYYY-MM-DD day");
  }
  return path.join(path.resolve(root), TIMELINE_DAY_DIR, `${date}.json`);
}

export function snapshotToObservation(snapshot: ActivitySnapshot): TimelineObservation | null {
  if (typeof snapshot.id !== "number") return null;
  return {
    id: snapshot.id,
    machine: snapshot.machine,
    capturedAtUtc: snapshot.capturedAtUtc,
    app: snapshot.app,
    windowTitle: snapshot.windowTitle,
    ...(snapshot.browserUrl === undefined ? {} : { browserUrl: snapshot.browserUrl }),
    contentHash: snapshot.contentHash,
  };
}

export function localDatesForUtcRange(fromMs: number, toMs: number, timezone: string): string[] {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];
  const dates: string[] = [];
  let date = activityDateInTimezone(new Date(fromMs), timezone);
  const last = activityDateInTimezone(new Date(toMs - 1), timezone);
  while (dates.length < 366) {
    dates.push(date);
    if (date === last) break;
    const { endUtc } = activityDayWindow(date, timezone);
    date = activityDateInTimezone(new Date(Date.parse(endUtc)), timezone);
  }
  return dates;
}

export function timelineAnalysisClientsFromConfig(config: PluginConfig): TimelineAnalysisClients {
  return {
    localLlm: new LocalLlmClient(config),
    remoteLlm: new FallbackLlmClient(
      config.gatewayConfig,
      fallbackLlmRuntimeContextFromConfig(config),
    ),
  };
}

function resolveClients(input: RegenerateTimelineDayInput): TimelineAnalysisClients {
  if (input.deps !== undefined) return input.deps;
  if (input.pluginConfig !== undefined) return timelineAnalysisClientsFromConfig(input.pluginConfig);
  return {};
}

function sourceHash(input: {
  observations: readonly TimelineObservation[];
  analysis: ActivityTimelineAnalysisConfig;
  corrections: readonly TimelineCorrection[];
}): string {
  return hashActivityBody(
    JSON.stringify({
      observations: input.observations.map((observation) => ({
        id: observation.id,
        contentHash: observation.contentHash,
        capturedAtUtc: observation.capturedAtUtc,
      })),
      analysis: {
        enabled: input.analysis.enabled,
        provider: input.analysis.provider ?? null,
        model: input.analysis.model ?? null,
        timeoutMs: input.analysis.timeoutMs ?? null,
        preferences: input.analysis.preferences ?? null,
      },
      corrections: input.corrections,
    }),
  );
}

function readPersisted(filePath: string): PersistedTimelineDay | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as PersistedTimelineDay;
    if (parsed?.formatVersion !== TIMELINE_DAY_FORMAT_VERSION || !Array.isArray(parsed.cards)) {
      return null;
    }
    return parsed;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    return null;
  }
}

function persistDay(filePath: string, payload: PersistedTimelineDay): boolean {
  const text = `${JSON.stringify(payload)}\n`;
  try {
    if (readFileSync(filePath, "utf8") === text) return false;
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(tmpPath, text, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup of the temp file.
    }
    throw error;
  }
  return true;
}

function toResult(
  filePath: string,
  written: boolean,
  analyzed: boolean,
  day: Pick<PersistedTimelineDay, "status" | "cards" | "metadata" | "failure">,
): RegenerateTimelineDayResult {
  return {
    status: day.status,
    cards: day.cards,
    path: filePath,
    written,
    analyzed,
    ...(day.metadata === undefined ? {} : { metadata: day.metadata }),
    ...(day.failure === undefined ? {} : { failure: day.failure }),
  };
}

async function regenerateUncached(input: RegenerateTimelineDayInput): Promise<RegenerateTimelineDayResult> {
  const date = requireToken(input.date, "date");
  const timezone = requireToken(input.timezone, "timezone");
  const filePath = timelineDayPath(input.memoryDir, date);
  if (!input.timelineEnabled) {
    return toResult(filePath, false, false, { status: "timeline_disabled", cards: [] });
  }

  const { startUtc, endUtc } = activityDayWindow(date, timezone);
  const observations = input.store
    .listSnapshotsForDay(null, startUtc, endUtc)
    .map(snapshotToObservation)
    .filter((observation): observation is TimelineObservation => observation !== null);

  let corrections = input.corrections;
  let opened: TimelineCorrectionStore | undefined;
  if (corrections === undefined) {
    opened = TimelineCorrectionStore.open(input.memoryDir);
    corrections = opened.list();
  }
  try {
    const built = applyTimelineCorrections(
      buildTimelineDay({ date, timezone, observations }).cards,
      corrections,
    );
    const hash = sourceHash({ observations, analysis: input.analysis, corrections });
    const prior = readPersisted(filePath);
    if (prior !== null && prior.sourceHash === hash && (prior.status === "ok" || prior.status === "disabled")) {
      return toResult(filePath, false, false, prior);
    }

    const deterministic: PersistedTimelineDay = {
      formatVersion: TIMELINE_DAY_FORMAT_VERSION,
      date,
      timezone,
      sourceHash: hash,
      status: "disabled",
      cards: built,
    };
    persistDay(filePath, deterministic);

    if (!input.analysis.enabled) {
      return toResult(filePath, true, false, deterministic);
    }

    const deps = resolveClients(input);
    const analyzed: TimelineAnalysisRunResult = await runTimelineCardAnalysis({
      date,
      timezone,
      cards: built,
      observations,
      corrections,
      config: input.analysis,
      deps,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const next: PersistedTimelineDay = {
      formatVersion: TIMELINE_DAY_FORMAT_VERSION,
      date,
      timezone,
      sourceHash: hash,
      status: analyzed.status,
      cards: analyzed.cards,
      ...(analyzed.metadata === undefined ? {} : { metadata: analyzed.metadata }),
      ...(analyzed.failure === undefined ? {} : { failure: analyzed.failure }),
    };
    persistDay(filePath, next);
    return toResult(filePath, true, analyzed.status === "ok", next);
  } finally {
    opened?.close();
  }
}

/** Build, optionally analyze once, and persist one local day of timeline cards. */
export async function regenerateTimelineDay(
  input: RegenerateTimelineDayInput,
): Promise<RegenerateTimelineDayResult> {
  const key = `${path.resolve(requireToken(input.memoryDir, "memoryDir"))}\0${input.date}`;
  const pending = inflight.get(key);
  if (pending !== undefined) return pending;
  const run = regenerateUncached(input).finally(() => {
    if (inflight.get(key) === run) inflight.delete(key);
  });
  inflight.set(key, run);
  return run;
}
