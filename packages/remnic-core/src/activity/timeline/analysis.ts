/**
 * Optional AI analysis over deterministic timeline cards (issue #2050 first slice).
 *
 * Injected provider only. parseConfig, registries, and surfaces wait.
 * Failures leave cards unchanged. Disabled makes zero provider calls.
 */
import { extractJsonCandidates } from "../../json-extract.js";
import { log } from "../../logger.js";
import { DEFAULT_TIMELINE_CATEGORIES } from "./categories.js";
import type { TimelineCard, TimelineCategory, TimelineCorrection, TimelineEvidenceRange, TimelineObservation } from "./types.js";

export const TIMELINE_ANALYSIS_PROMPT_VERSION = 1;
export const TIMELINE_ANALYSIS_BATCH_SIZE = 40;
export const TIMELINE_ANALYSIS_BATCH_OVERLAP = 2;
export const TIMELINE_ANALYSIS_DEFAULT_TIMEOUT_MS = 15_000;

export class TimelineAnalysisConfigError extends Error {
  override readonly name = "TimelineAnalysisConfigError";
  readonly code = "invalid_config" as const;
  constructor(message: string) {
    super(message);
  }
}

export type TimelineAnalysisStatus = "ok" | "disabled" | "provider_failed" | "invalid_output";

export interface TimelineAnalysisCompleteInput {
  prompt: string;
  provider: string;
  model: string;
  signal: AbortSignal;
}

export type TimelineAnalysisComplete = (input: TimelineAnalysisCompleteInput) => Promise<string>;

export interface TimelineAnalysisInput {
  enabled: boolean;
  cards: readonly TimelineCard[];
  observations: readonly TimelineObservation[];
  provider?: string;
  model?: string;
  complete?: TimelineAnalysisComplete;
  timeoutMs?: number;
  date?: string;
  timezone?: string;
  categories?: readonly TimelineCategory[];
  preferences?: readonly string[];
  priorEdits?: readonly TimelineCorrection[];
  signal?: AbortSignal;
}

export interface TimelineAnalysisResult {
  status: TimelineAnalysisStatus;
  cards: TimelineCard[];
  provider?: string;
  model?: string;
  promptVersion?: number;
}

interface AnalysisOp {
  cardId: string;
  title?: string;
  summary?: string;
  categoryId?: string;
  confidence?: number;
  uncertainty?: string;
  evidenceRange: TimelineEvidenceRange;
}

const INSTRUCTIONS = [
  "Use only supplied evidence.",
  "Preserve chronology.",
  "Do not invent people, places, or tasks.",
  "Avoid productivity or emotional claims.",
  "Merge adjacent activity only when the evidence justifies it.",
  "Return strict JSON: {\"ops\":[...]} with evidenceRange, title, summary, categoryId, confidence, uncertainty.",
  "Cite evidence ranges for every op. Empty ops is a valid no-op.",
].join(" ");

function fail(
  status: Exclude<TimelineAnalysisStatus, "ok" | "disabled">,
  cards: readonly TimelineCard[],
  provider: string,
  model: string,
): TimelineAnalysisResult {
  log.info(`timeline analysis status=${status} provider=${provider} model=${model} promptVersion=${TIMELINE_ANALYSIS_PROMPT_VERSION}`);
  return {
    status,
    cards: cards as TimelineCard[],
    provider,
    model,
    promptVersion: TIMELINE_ANALYSIS_PROMPT_VERSION,
  };
}

function requiredToken(value: string | undefined, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TimelineAnalysisConfigError(`${name} is required`);
  }
  return value.trim();
}

function evidenceKeyOf(observation: TimelineObservation): string {
  const parsed = Date.parse(observation.capturedAtUtc);
  const instant = Number.isFinite(parsed) ? new Date(parsed).toISOString() : observation.capturedAtUtc;
  return `${observation.machine}|${instant}|${observation.contentHash}`;
}

function sortObservations(observations: readonly TimelineObservation[]): TimelineObservation[] {
  return [...observations].sort((a, b) => {
    const time = Date.parse(a.capturedAtUtc) - Date.parse(b.capturedAtUtc);
    if (time !== 0) return time;
    if (a.contentHash !== b.contentHash) return a.contentHash < b.contentHash ? -1 : 1;
    return a.id - b.id;
  });
}

function batchObservations(observations: readonly TimelineObservation[]): TimelineObservation[][] {
  if (observations.length === 0) return [[]];
  const size = TIMELINE_ANALYSIS_BATCH_SIZE;
  const overlap = TIMELINE_ANALYSIS_BATCH_OVERLAP;
  const step = size - overlap;
  const batches: TimelineObservation[][] = [];
  for (let start = 0; start < observations.length; start += step) {
    batches.push(observations.slice(start, start + size));
    if (start + size >= observations.length) break;
  }
  return batches;
}

function safeObservation(observation: TimelineObservation) {
  return {
    id: observation.id,
    machine: observation.machine,
    capturedAtUtc: observation.capturedAtUtc,
    app: observation.app,
    windowTitle: observation.windowTitle,
    ...(observation.browserUrl ? { browserUrl: observation.browserUrl } : {}),
    contentHash: observation.contentHash,
  };
}

function safeCard(card: TimelineCard) {
  return {
    id: card.id,
    kind: card.kind,
    title: card.title,
    summary: card.summary,
    categoryId: card.categoryId,
    confidence: card.confidence,
    startUtc: card.startUtc,
    endUtc: card.endUtc,
    machine: card.machine,
    evidenceIds: card.evidenceIds,
    evidenceRange: card.evidenceRange,
    ...(card.manualEdit ? { manualEdit: card.manualEdit } : {}),
  };
}

export function buildTimelineAnalysisPrompt(input: {
  date?: string;
  timezone?: string;
  cards: readonly TimelineCard[];
  observations: readonly TimelineObservation[];
  categories: readonly TimelineCategory[];
  preferences?: readonly string[];
  priorEdits?: readonly TimelineCorrection[];
}): string {
  const payload = {
    date: input.date ?? null,
    timezone: input.timezone ?? null,
    categories: input.categories.map((category) => ({ id: category.id, name: category.name })),
    preferences: input.preferences ?? [],
    priorEdits: input.priorEdits ?? [],
    cards: input.cards.map(safeCard),
    observations: input.observations.map(safeObservation),
  };
  return `${INSTRUCTIONS}\n${JSON.stringify(payload)}`;
}

async function callComplete(
  complete: TimelineAnalysisComplete,
  prompt: string,
  provider: string,
  model: string,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<string> {
  const { promise: timeoutPromise, reject } = Promise.withResolvers<string>();
  const failOnce = (message: string, name: string) => {
    reject(Object.assign(new Error(message), { name }));
  };
  const timer = setTimeout(() => failOnce("timeline analysis timed out", "TimeoutError"), timeoutMs);
  if (parent?.aborted) {
    clearTimeout(timer);
    throw Object.assign(new Error("timeline analysis aborted"), { name: "AbortError" });
  }
  const onAbort = () => failOnce("timeline analysis aborted", "AbortError");
  parent?.addEventListener("abort", onAbort, { once: true });
  const signal = parent ? AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  try {
    return await Promise.race([complete({ prompt, provider, model, signal }), timeoutPromise]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onAbort);
  }
}

function parseOps(raw: string): AnalysisOp[] | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  for (const candidate of extractJsonCandidates(raw)) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("ops" in parsed)) continue;
      const ops = parsed.ops;
      if (!Array.isArray(ops)) continue;
      const out: AnalysisOp[] = [];
      let valid = true;
      for (const item of ops) {
        const op = asOp(item);
        if (!op) {
          valid = false;
          break;
        }
        out.push(op);
      }
      if (valid) return out;
    } catch {
      continue;
    }
  }
  return null;
}

function asOp(value: unknown): AnalysisOp | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!("cardId" in value) || typeof value.cardId !== "string" || value.cardId.length === 0) return null;
  if (!("evidenceRange" in value)) return null;
  const range = value.evidenceRange;
  if (!range || typeof range !== "object" || Array.isArray(range)) return null;
  if (!("firstKey" in range) || typeof range.firstKey !== "string" || range.firstKey.length === 0) return null;
  if (!("lastKey" in range) || typeof range.lastKey !== "string" || range.lastKey.length === 0) return null;
  if ("title" in value && value.title !== undefined && typeof value.title !== "string") return null;
  if ("summary" in value && value.summary !== undefined && typeof value.summary !== "string") return null;
  if ("categoryId" in value && value.categoryId !== undefined && typeof value.categoryId !== "string") return null;
  if ("uncertainty" in value && value.uncertainty !== undefined && typeof value.uncertainty !== "string") return null;
  if (
    "confidence" in value &&
    value.confidence !== undefined &&
    (typeof value.confidence !== "number" || value.confidence < 0 || value.confidence > 1)
  ) {
    return null;
  }
  return {
    cardId: value.cardId,
    title: "title" in value && typeof value.title === "string" ? value.title : undefined,
    summary: "summary" in value && typeof value.summary === "string" ? value.summary : undefined,
    categoryId: "categoryId" in value && typeof value.categoryId === "string" ? value.categoryId : undefined,
    confidence: "confidence" in value && typeof value.confidence === "number" ? value.confidence : undefined,
    uncertainty: "uncertainty" in value && typeof value.uncertainty === "string" ? value.uncertainty : undefined,
    evidenceRange: { firstKey: range.firstKey, lastKey: range.lastKey },
  };
}

function knownEvidenceKeys(cards: readonly TimelineCard[], observations: readonly TimelineObservation[]): Set<string> {
  const keys = new Set<string>();
  for (const observation of observations) keys.add(evidenceKeyOf(observation));
  for (const card of cards) {
    if (card.evidenceRange) {
      keys.add(card.evidenceRange.firstKey);
      keys.add(card.evidenceRange.lastKey);
    }
  }
  return keys;
}

function applyOps(
  cards: readonly TimelineCard[],
  ops: readonly AnalysisOp[],
  categories: readonly TimelineCategory[],
  evidenceKeys: ReadonlySet<string>,
): TimelineCard[] | null {
  if (ops.length === 0) return cards as TimelineCard[];
  const byId = new Map(cards.map((card) => [card.id, card]));
  const allowedCategories = new Set(categories.map((category) => category.id));
  const next = new Map<string, TimelineCard>();
  for (const op of ops) {
    const card = byId.get(op.cardId);
    if (!card) return null;
    if (!evidenceKeys.has(op.evidenceRange.firstKey) || !evidenceKeys.has(op.evidenceRange.lastKey)) return null;
    if (op.categoryId !== undefined && !allowedCategories.has(op.categoryId)) return null;
    if (card.manualEdit) continue;
    next.set(card.id, {
      ...card,
      ...(op.title !== undefined ? { title: op.title } : {}),
      ...(op.summary !== undefined ? { summary: op.summary } : {}),
      ...(op.categoryId !== undefined ? { categoryId: op.categoryId } : {}),
      ...(op.confidence !== undefined ? { confidence: op.confidence } : {}),
    });
  }
  if (next.size === 0) return cards as TimelineCard[];
  return cards.map((card) => next.get(card.id) ?? card);
}

/** Analyze one day of cards. Failures return the input cards unchanged. */
export async function analyzeTimelineCards(input: TimelineAnalysisInput): Promise<TimelineAnalysisResult> {
  const cards = input.cards as TimelineCard[];
  if (!input.enabled) {
    return { status: "disabled", cards };
  }

  const provider = requiredToken(input.provider, "provider");
  const model = requiredToken(input.model, "model");
  const complete = input.complete;
  if (typeof complete !== "function") {
    throw new TimelineAnalysisConfigError("complete is required");
  }
  const timeoutMs = input.timeoutMs ?? TIMELINE_ANALYSIS_DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TimelineAnalysisConfigError("timeoutMs must be a positive integer");
  }
  if (input.cards.length === 0 && input.observations.length === 0) {
    return fail("invalid_output", cards, provider, model);
  }

  const categories = input.categories ?? DEFAULT_TIMELINE_CATEGORIES;
  const ordered = sortObservations(input.observations);
  const batches = batchObservations(ordered);
  const merged = new Map<string, AnalysisOp>();

  try {
    for (const batch of batches) {
      const prompt = buildTimelineAnalysisPrompt({
        date: input.date,
        timezone: input.timezone,
        cards: input.cards,
        observations: batch,
        categories,
        preferences: input.preferences,
        priorEdits: input.priorEdits,
      });
      const raw = await callComplete(complete, prompt, provider, model, timeoutMs, input.signal);
      const ops = parseOps(raw);
      if (!ops) return fail("invalid_output", cards, provider, model);
      for (const op of ops) merged.set(op.cardId, op);
    }
  } catch {
    return fail("provider_failed", cards, provider, model);
  }

  const applied = applyOps(cards, [...merged.values()], categories, knownEvidenceKeys(cards, ordered));
  if (!applied) return fail("invalid_output", cards, provider, model);

  log.info(`timeline analysis status=ok provider=${provider} model=${model} promptVersion=${TIMELINE_ANALYSIS_PROMPT_VERSION}`);
  return {
    status: "ok",
    cards: applied,
    provider,
    model,
    promptVersion: TIMELINE_ANALYSIS_PROMPT_VERSION,
  };
}
