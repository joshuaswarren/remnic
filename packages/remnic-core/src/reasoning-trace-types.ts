/**
 * Reasoning-trace memory structural types (issue #564).
 *
 * Captures stored solution chains / chain-of-thought the user walked through
 * to solve a problem. Traces have an ordered list of steps, a final answer,
 * and an optional observed outcome.
 */

export interface ReasoningTraceStep {
  /** 1-based ordinal within the trace. */
  order: number;
  /** Human-readable description of what happened at this step. */
  description: string;
}

export interface ReasoningTraceStructuredData {
  steps: ReasoningTraceStep[];
  finalAnswer: string;
  /** Optional confirmation of how the answer played out in practice. */
  observedOutcome?: string;
}

/** Normalize loose extraction JSON into ReasoningTraceStep records. */
export function normalizeReasoningTraceSteps(raw: unknown): ReasoningTraceStep[] {
  if (!Array.isArray(raw)) return [];
  const out: ReasoningTraceStep[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    let description = "";
    let orderRaw: unknown;
    if (typeof s === "string") {
      description = s.trim();
    } else if (s && typeof s === "object") {
      const o = s as Record<string, unknown>;
      if (typeof o.description === "string") description = o.description.trim();
      else if (typeof o.intent === "string") description = o.intent.trim();
      else if (typeof o.step === "string") description = o.step.trim();
      else if (typeof o.text === "string") description = o.text.trim();
      orderRaw = o.order;
    }
    if (!description) continue;
    const order =
      typeof orderRaw === "number" && Number.isFinite(orderRaw)
        ? Math.max(1, Math.floor(orderRaw))
        : i + 1;
    out.push({ order, description });
  }
  return out;
}

/**
 * Normalize a loose reasoningTrace object (e.g. coming back from the LLM) to
 * a strict ReasoningTraceStructuredData shape. Returns null when the data is
 * clearly incomplete (no steps or no final answer).
 */
export function normalizeReasoningTrace(raw: unknown): ReasoningTraceStructuredData | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const steps = normalizeReasoningTraceSteps(o.steps);
  const finalAnswer =
    typeof o.finalAnswer === "string"
      ? o.finalAnswer.trim()
      : typeof o.final_answer === "string"
      ? (o.final_answer as string).trim()
      : "";
  // Prompts describe reasoning_trace as requiring ≥2 ordered steps + a final
  // answer. Rejecting one-step payloads here keeps the category semantically
  // distinct from ordinary `decision` facts and prevents malformed traces
  // from sneaking through loose local/direct extraction JSON.
  if (steps.length < 2 || finalAnswer.length === 0) return null;
  const observedRaw =
    typeof o.observedOutcome === "string"
      ? o.observedOutcome
      : typeof o.observed_outcome === "string"
      ? (o.observed_outcome as string)
      : undefined;
  const observedOutcome = observedRaw?.trim();
  return {
    steps,
    finalAnswer,
    observedOutcome: observedOutcome && observedOutcome.length > 0 ? observedOutcome : undefined,
  };
}

/**
 * Serialize a normalized reasoning trace into a human-readable markdown body.
 * Output shape mirrors the procedure body format: ## Step N sections followed
 * by final answer and optional observed outcome.
 */
export function buildReasoningTraceMarkdownBody(trace: ReasoningTraceStructuredData): string {
  const sorted = [...trace.steps].sort((a, b) => a.order - b.order);
  const lines: string[] = [];
  for (const step of sorted) {
    const n = Number.isFinite(step.order) ? Math.max(1, Math.floor(step.order)) : 1;
    lines.push(`## Step ${n}`);
    lines.push("");
    lines.push(step.description.trim());
    lines.push("");
  }
  lines.push("## Final Answer");
  lines.push("");
  lines.push(trace.finalAnswer.trim());
  lines.push("");
  if (trace.observedOutcome && trace.observedOutcome.trim().length > 0) {
    lines.push("## Observed Outcome");
    lines.push("");
    lines.push(trace.observedOutcome.trim());
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Combine a short title with the structured trace body. The title becomes the
 * one-line content of the stored memory, and the full body is appended below.
 */
export function buildReasoningTracePersistBody(
  title: string,
  trace: ReasoningTraceStructuredData,
): string {
  const head = typeof title === "string" ? title.trim() : "";
  const body = buildReasoningTraceMarkdownBody(trace);
  if (!head) return body;
  return `${head}\n\n${body}`.trimEnd() + "\n";
}

const STEP_HEADER_RE = /^##\s+Step\s+(\d+)\s*$/im;
const FINAL_HEADER_RE = /^##\s+Final Answer\s*$/im;
const OBSERVED_HEADER_RE = /^##\s+Observed Outcome\s*$/im;

/**
 * Best-effort parse of a reasoning-trace markdown body back into structured
 * data. Returns null when the document does not look like a reasoning trace.
 */
export function parseReasoningTraceFromBody(content: string): ReasoningTraceStructuredData | null {
  const text = content.replace(/\r\n/g, "\n").trim();
  if (!text) return null;
  const stepMatches = [...text.matchAll(new RegExp(STEP_HEADER_RE.source, "gim"))];
  const finalMatch = FINAL_HEADER_RE.exec(text);
  if (stepMatches.length === 0 || !finalMatch) return null;

  const observedMatch = OBSERVED_HEADER_RE.exec(text);

  const steps: ReasoningTraceStep[] = [];
  for (let i = 0; i < stepMatches.length; i++) {
    const m = stepMatches[i];
    const order = Number.parseInt(m[1] ?? String(i + 1), 10);
    const start = (m.index ?? 0) + m[0].length;
    const nextStepStart =
      i + 1 < stepMatches.length ? stepMatches[i + 1].index ?? text.length : text.length;
    const end = Math.min(nextStepStart, finalMatch.index ?? text.length);
    const block = text.slice(start, end).trim();
    const description = block.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).join(" ");
    if (!description) continue;
    steps.push({
      order: Number.isFinite(order) ? order : i + 1,
      description,
    });
  }

  // Honor the >=2 ordered-steps invariant enforced everywhere else in the
  // pipeline (prompts, normalizer, schema). A single-step manually-edited
  // or corrupt file should not round-trip back in as a reasoning_trace.
  if (steps.length < 2) return null;

  const finalStart = (finalMatch.index ?? 0) + finalMatch[0].length;
  const finalEnd = observedMatch?.index ?? text.length;
  const finalAnswer = text
    .slice(finalStart, finalEnd)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(" ")
    .trim();
  if (!finalAnswer) return null;

  let observedOutcome: string | undefined;
  if (observedMatch) {
    const obsStart = (observedMatch.index ?? 0) + observedMatch[0].length;
    const raw = text
      .slice(obsStart)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join(" ")
      .trim();
    if (raw) observedOutcome = raw;
  }

  return { steps, finalAnswer, observedOutcome };
}

/**
 * Heuristic detector for whether a user message contains a chain-of-thought /
 * solution trace that should be extracted. This is intentionally conservative:
 * we require at least two explicitly-ordered steps and some form of final
 * answer / resolution. Used by the extraction pipeline to decide whether to
 * even consider emitting a reasoning_trace fact, so false positives are more
 * costly than false negatives.
 */
export function looksLikeReasoningTrace(message: string): boolean {
  if (typeof message !== "string") return false;
  const text = message.trim();
  if (text.length < 80) return false;

  // Count lines that carry at least one step marker, not the total number of
  // marker matches. Summing across multiple regexes can let a single line
  // contribute two "steps" (e.g. "Step 1: First,…" matches both patterns),
  // which weakens the "false positives > false negatives" bias. Per-line
  // counting keeps the gate symmetric with real step structure.
  const stepMarkerRes = [
    /\bstep\s+\d+\s*[:.\-]/i,
    /^\s*\d+[.)]\s+\S/,
    /^\s*(first|second|third|fourth|finally|then|next)\b[,:]/i,
  ];
  const lines = text.split(/\r?\n/);
  let stepCount = 0;
  for (const line of lines) {
    if (stepMarkerRes.some((re) => re.test(line))) {
      stepCount += 1;
      if (stepCount >= 2) break;
    }
  }
  if (stepCount < 2) return false;

  // Final-answer / resolution marker. Split into two checks so the trailing
  // `\b` on the word-final alternatives doesn't accidentally require a word
  // character after `answer:` / `result:` (both end in a non-word `:`).
  const wordFinalMarker =
    /\b(final answer|so the answer|therefore|conclusion|in the end|ended up|picked|chose)\b/i;
  const colonMarker = /\b(answer:|result:)/i;
  if (!wordFinalMarker.test(text) && !colonMarker.test(text)) return false;

  return true;
}
