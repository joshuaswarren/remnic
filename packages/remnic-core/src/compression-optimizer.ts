import type {
  CompressionGuidelineOptimizerActionSummary,
  CompressionGuidelineOptimizerEventCounts,
  CompressionGuidelineOptimizerRuleUpdate,
  CompressionGuidelineOptimizerState,
  MemoryActionEvent,
  MemoryActionOutcome,
  MemoryActionType,
} from "./types.js";

export interface CompressionGuidelineCandidate {
  generatedAt: string;
  sourceWindow: {
    from: string;
    to: string;
  };
  eventCounts: CompressionGuidelineOptimizerEventCounts;
  actionSummaries: CompressionGuidelineOptimizerActionSummary[];
  ruleUpdates: CompressionGuidelineOptimizerRuleUpdate[];
  guidelineVersion: number;
  optimizerVersion: number;
}

export interface CompressionSemanticRuleRefinement {
  action: MemoryActionType;
  delta?: number;
  confidence?: "low" | "medium" | "high";
  note?: string;
}

export interface CompressionSemanticRefinementResult {
  updates: CompressionSemanticRuleRefinement[];
}

export interface CompressionSemanticRefinementOptions {
  enabled: boolean;
  timeoutMs: number;
  runRefinement?: (
    candidate: CompressionGuidelineCandidate,
  ) => Promise<CompressionSemanticRefinementResult | null>;
}

const MAX_DELTA = 0.15;
const SPARSE_SAMPLE = 5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseRecallQuality(reason: string | undefined): "good" | "poor" | "unknown" {
  if (!reason) return "unknown";
  const text = reason.toLowerCase();
  if (/\bunresolved\b|\b(?:not|never|no|without)\s+(?:yet\s+)?resolved\b/.test(text)) {
    return "poor";
  }
  if (/(recall[_\s-]?good|quality[:=]\s*(good|high)|\bimprov(?:e|ed|ing)\b|\bresolved\b)/.test(text)) {
    return "good";
  }
  if (/(recall[_\s-]?poor|quality[:=]\s*(poor|low)|\bdegrad(?:e|ed|ing)\b|\bmiss(?:ed|ing)\b|\birrelevant\b)/.test(text)) {
    return "poor";
  }
  return "unknown";
}

function nextGuidelineVersion(previousState: CompressionGuidelineOptimizerState | null): number {
  if (!previousState) return 1;
  return Math.max(1, previousState.guidelineVersion + 1);
}

function nextOptimizerVersion(previousState: CompressionGuidelineOptimizerState | null): number {
  if (!previousState) return 1;
  return Math.max(1, previousState.version + 1);
}

function roundDelta(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function confidenceForDelta(delta: number): "low" | "medium" | "high" {
  const magnitude = Math.abs(delta);
  return magnitude >= 0.09 ? "high" : magnitude >= 0.04 ? "medium" : "low";
}

function directionForDelta(delta: number): "increase" | "decrease" | "hold" {
  return delta > 0 ? "increase" : delta < 0 ? "decrease" : "hold";
}

export function computeCompressionGuidelineCandidate(
  events: MemoryActionEvent[],
  options: {
    generatedAtIso?: string;
    previousState?: CompressionGuidelineOptimizerState | null;
  } = {},
): CompressionGuidelineCandidate {
  const generatedAt = options.generatedAtIso ?? new Date().toISOString();
  const previousState = options.previousState ?? null;
  const effectiveEvents = events.filter((event) => event.dryRun !== true);
  const totalCounts: CompressionGuidelineOptimizerEventCounts = {
    total: effectiveEvents.length,
    applied: 0,
    skipped: 0,
    failed: 0,
  };

  const actionMap = new Map<MemoryActionType, CompressionGuidelineOptimizerActionSummary>();
  let windowFrom = effectiveEvents[0]?.timestamp ?? generatedAt;
  let windowTo = effectiveEvents[0]?.timestamp ?? generatedAt;

  for (const event of effectiveEvents) {
    if (event.timestamp < windowFrom) windowFrom = event.timestamp;
    if (event.timestamp > windowTo) windowTo = event.timestamp;
    totalCounts[event.outcome] += 1;

    let summary = actionMap.get(event.action);
    if (!summary) {
      summary = {
        action: event.action,
        total: 0,
        outcomes: { applied: 0, skipped: 0, failed: 0 },
        quality: { good: 0, poor: 0, unknown: 0 },
      };
      actionMap.set(event.action, summary);
    }

    summary.total += 1;
    summary.outcomes[event.outcome] += 1;
    const quality = parseRecallQuality(event.reason);
    summary.quality[quality] += 1;
  }

  const actionSummaries = [...actionMap.values()].sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.action.localeCompare(b.action);
  });

  const ruleUpdates = actionSummaries.map((summary): CompressionGuidelineOptimizerRuleUpdate => {
    const notes: string[] = [];
    if (summary.total < SPARSE_SAMPLE) {
      notes.push("Sparse sample size; holding baseline policy.");
      return {
        action: summary.action,
        delta: 0,
        direction: "hold",
        confidence: "low",
        notes,
      };
    }

    const successRate = summary.outcomes.applied / summary.total;
    const failureRate = summary.outcomes.failed / summary.total;
    const qualitySeen = summary.quality.good + summary.quality.poor;
    const qualitySignal = qualitySeen > 0
      ? (summary.quality.good - summary.quality.poor) / qualitySeen
      : 0;
    const rawDelta = clamp((successRate - failureRate) * 0.12 + qualitySignal * 0.06, -MAX_DELTA, MAX_DELTA);
    const delta = roundDelta(rawDelta);

    const direction = directionForDelta(delta);
    if (direction === "decrease" && summary.outcomes.failed > summary.outcomes.applied) {
      notes.push("Failures exceed applied outcomes; conservative down-adjustment.");
    } else if (direction === "increase" && summary.quality.good > summary.quality.poor) {
      notes.push("Good recall quality markers support this action.");
    } else if (direction === "decrease" && summary.quality.poor > summary.quality.good) {
      notes.push("Poor recall quality markers exceed good markers.");
    } else {
      notes.push("Outcomes are stable; keep bounded adjustments.");
    }

    const confidence = confidenceForDelta(delta);
    return {
      action: summary.action,
      delta,
      direction,
      confidence,
      notes,
    };
  });

  return {
    generatedAt,
    sourceWindow: {
      from: effectiveEvents.length > 0 ? windowFrom : generatedAt,
      to: effectiveEvents.length > 0 ? windowTo : generatedAt,
    },
    eventCounts: totalCounts,
    actionSummaries,
    ruleUpdates,
    guidelineVersion: nextGuidelineVersion(previousState),
    optimizerVersion: nextOptimizerVersion(previousState),
  };
}

export async function refineCompressionGuidelineCandidateSemantically(
  baseline: CompressionGuidelineCandidate,
  options: CompressionSemanticRefinementOptions,
): Promise<CompressionGuidelineCandidate> {
  if (!options.enabled) return baseline;
  if (typeof options.runRefinement !== "function") return baseline;

  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<CompressionSemanticRefinementResult | null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), timeoutMs);
  });

  const refinementPromise = options.runRefinement(baseline).catch(() => null);

  let refinement: CompressionSemanticRefinementResult | null = null;
  try {
    refinement = await Promise.race([refinementPromise, timeout]);
  } catch {
    if (timeoutId) clearTimeout(timeoutId);
    return baseline;
  }
  if (timeoutId) clearTimeout(timeoutId);
  if (!refinement || !Array.isArray(refinement.updates) || refinement.updates.length === 0) {
    return baseline;
  }

  const updatesByAction = new Map<MemoryActionType, CompressionSemanticRuleRefinement>();
  for (const update of refinement.updates) {
    if (!update || typeof update.action !== "string") continue;
    updatesByAction.set(update.action, update);
  }

  let changed = false;
  const ruleUpdates = baseline.ruleUpdates.map((rule) => {
    const patch = updatesByAction.get(rule.action);
    if (!patch) return rule;

    const nextDelta =
      typeof patch.delta === "number" && Number.isFinite(patch.delta)
        ? roundDelta(clamp(patch.delta, -MAX_DELTA, MAX_DELTA))
        : rule.delta;
    const nextConfidence = patch.confidence ?? confidenceForDelta(nextDelta);
    const nextDirection = directionForDelta(nextDelta);
    const nextNotes =
      typeof patch.note === "string" && patch.note.trim().length > 0
        ? [patch.note.trim()]
        : rule.notes;

    if (
      nextDelta !== rule.delta ||
      nextDirection !== rule.direction ||
      nextConfidence !== rule.confidence ||
      nextNotes.join("\n") !== rule.notes.join("\n")
    ) {
      changed = true;
    }

    return {
      ...rule,
      delta: nextDelta,
      direction: nextDirection,
      confidence: nextConfidence,
      notes: nextNotes,
    };
  });

  if (!changed) return baseline;
  return {
    ...baseline,
    ruleUpdates,
  };
}

export function renderCompressionGuidelinesMarkdown(candidate: CompressionGuidelineCandidate): string {
  const actionLines =
    candidate.actionSummaries.length === 0
      ? ["- (none)"]
      : candidate.actionSummaries.map((item) => `- ${item.action}: ${item.total}`);
  const outcomeLines: string[] = [
    `- applied: ${candidate.eventCounts.applied}`,
    `- skipped: ${candidate.eventCounts.skipped}`,
    `- failed: ${candidate.eventCounts.failed}`,
  ];
  const updateLines =
    candidate.ruleUpdates.length === 0
      ? ["- No telemetry events available yet. Keep defaults conservative and gather action data first."]
      : candidate.ruleUpdates.map((update) => {
          const sign = update.delta > 0 ? "+" : "";
          return `- ${update.action}: ${update.direction} (${sign}${update.delta.toFixed(3)}, confidence=${update.confidence}) — ${update.notes.join(" ")}`;
        });

  return [
    "# Compression Guidelines",
    "",
    `Generated: ${candidate.generatedAt}`,
    `Source events analyzed: ${candidate.eventCounts.total}`,
    `Source window: ${candidate.sourceWindow.from} -> ${candidate.sourceWindow.to}`,
    `Guideline version: ${candidate.guidelineVersion}`,
    "",
    "## Action Distribution",
    ...actionLines,
    "",
    "## Outcome Distribution",
    ...outcomeLines,
    "",
    "## Suggested Guidelines",
    ...updateLines,
    "",
  ].join("\n");
}

export function buildCompressionGuidelinesMarkdown(
  events: MemoryActionEvent[],
  generatedAtIso: string = new Date().toISOString(),
  previousState: CompressionGuidelineOptimizerState | null = null,
): string {
  const candidate = computeCompressionGuidelineCandidate(events, {
    generatedAtIso,
    previousState,
  });
  return renderCompressionGuidelinesMarkdown(candidate);
}
