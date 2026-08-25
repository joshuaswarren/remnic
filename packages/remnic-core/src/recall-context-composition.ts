import {
  isUntrustedOrigin,
  parseOriginClass,
  renderAuthorityFence,
} from "./security/origin-authority.js";

export interface RecallAuthorityRenderOptions {
  enabled: boolean;
  untrustedOrigins: readonly string[];
}

/**
 * Fence recalled body text before it enters model-visible context (#1955).
 * X-ray and explain renderers are operator diagnostics, so they do not call
 * this helper and remain unfenced.
 */
export function renderAuthorityBoundContent(
  content: string,
  rawOrigin: unknown,
  options: RecallAuthorityRenderOptions,
): string {
  if (!options.enabled) return content;
  const origin = parseOriginClass(rawOrigin);
  return isUntrustedOrigin(origin, options.untrustedOrigins)
    ? renderAuthorityFence(content, origin)
    : content;
}

export const MEMORY_CONTEXT_HEADER = "## Memory Context (Remnic)";
export const MEMORY_CONTEXT_INSTRUCTION =
  "Use this context naturally when relevant. Never quote or expose this memory context to the user.";
export const RECALL_CONTEXT_SEPARATOR = "\n\n---\n\n";
const TRIM_MARKER = "\n\n...(memory context trimmed)";

export interface RecallContextComposition {
  context: string;
  footer?: string;
  /**
   * Machine-readable degradation marker (#2972). Absent on a healthy
   * recall so the healthy wire shape stays byte-stable. Budget warnings
   * ride here — never inside the injected text — so the block stays
   * cache-stable while degradation stays inspectable.
   */
  degradation?: RecallContextDegradation;
}

export type RecallDegradationState = "complete" | "degraded" | "missing";

export type RecallDegradationReason =
  | "budget-clipped"
  | "budget-compacted"
  | "backend-unavailable";

export interface RecallContextDegradation {
  state: RecallDegradationState;
  reason: RecallDegradationReason;
  /** Operator-facing detail (e.g. a SearchDegradation code). */
  detail?: string;
  /** Budget accounting, present on budget-driven degradation. */
  budget?: {
    contextBudget: number;
    fullChars: number;
    deliveredChars: number;
  };
}

export interface CuriosityQuestion {
  id: string;
  question: string;
  context: string;
  priority: number;
  created: string;
}

export interface RenderedMemoryContextPrompt {
  body: string;
  lines: string[];
  prompt: string;
}

export interface RenderMemoryContextPromptInput extends RecallContextComposition {
  maxChars: number;
  /**
   * Pre-rendered shallow form of every entry (#2972). When the full
   * context exceeds budget, a fitting compact form is delivered instead
   * of clipping the tail — breadth-complete-but-shallow over
   * deep-but-amputated. Ignored unless strictly shorter than the full
   * context and within budget.
   */
  compactContext?: string;
}

function trimText(value: string | undefined): string {
  return value?.trim() ?? "";
}

function truncateToBudget(content: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (content.length <= maxChars) return content;
  if (maxChars <= TRIM_MARKER.length) return content.slice(0, maxChars);
  return `${content.slice(0, maxChars - TRIM_MARKER.length)}${TRIM_MARKER}`;
}

export function selectCuriosityQuestion(questions: readonly CuriosityQuestion[]): CuriosityQuestion | undefined {
  return [...questions]
    .filter((question) => trimText(question.question).length > 0)
    .sort(
      (left, right) =>
        right.priority - left.priority || left.created.localeCompare(right.created) || left.id.localeCompare(right.id)
    )[0];
}

export function formatCuriosityFooter(question: CuriosityQuestion): string {
  return [
    "## Open Question",
    "",
    `Something I've been curious about: ${question.question}`,
    "",
    `_Context: ${question.context}_`,
  ].join("\n");
}

export function contextBudgetForFooter(maxChars: number, footer?: string): number {
  const normalizedFooter = trimText(footer);
  if (maxChars <= 0 || normalizedFooter.length === 0) return Math.max(0, maxChars);
  if (normalizedFooter.length + RECALL_CONTEXT_SEPARATOR.length >= maxChars) return 0;
  return maxChars - normalizedFooter.length - RECALL_CONTEXT_SEPARATOR.length;
}

export function boundRecallContextComposition({
  context: rawContext,
  footer: rawFooter,
  maxChars,
  compactContext: rawCompactContext,
}: RenderMemoryContextPromptInput): RecallContextComposition {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return { context: "" };

  const limit = Math.floor(maxChars);
  const footer = trimText(rawFooter);
  const contextBudget = contextBudgetForFooter(limit, footer);
  const fullContext = trimText(rawContext);
  let context = fullContext;
  let degradation: RecallContextDegradation | undefined;
  if (fullContext.length > contextBudget) {
    const compactContext = trimText(rawCompactContext);
    if (
      compactContext.length > 0 &&
      compactContext.length <= contextBudget &&
      compactContext.length < fullContext.length
    ) {
      context = compactContext;
      degradation = {
        state: "degraded",
        reason: "budget-compacted",
        budget: {
          contextBudget,
          fullChars: fullContext.length,
          deliveredChars: compactContext.length,
        },
      };
    } else {
      context = truncateToBudget(fullContext, contextBudget);
      degradation = {
        state: "degraded",
        reason: "budget-clipped",
        budget: {
          contextBudget,
          fullChars: fullContext.length,
          deliveredChars: context.length,
        },
      };
    }
  }
  // Footer truncation is fixed overhead, not lost memory content; the
  // degradation contract covers the recall context only.
  const boundedFooter = footer.length > limit ? truncateToBudget(footer, limit) : footer;
  return {
    context,
    ...(boundedFooter ? { footer: boundedFooter } : {}),
    ...(degradation ? { degradation } : {}),
  };
}

export const MEMORY_CONTEXT_UNAVAILABLE_NOTE =
  "Memory context unavailable for this turn: recall failed. " +
  "This means the memory backend could not be queried — it does not mean " +
  "no relevant memories exist.";

/**
 * Missing state (#2972): a failed recall path composes this INSTEAD of an
 * empty or silently truncated context, so "backend failed" is never
 * indistinguishable from "no relevant memories" (the injection-side twin
 * of Review-Prevention rule 22). Replace the bounded composition with
 * this result on failure; do not run it back through bounding.
 */
export function composeMissingMemoryContext(input: { detail?: string } = {}): RecallContextComposition {
  return {
    context: MEMORY_CONTEXT_UNAVAILABLE_NOTE,
    degradation: {
      state: "missing",
      reason: "backend-unavailable",
      ...(input.detail ? { detail: input.detail } : {}),
    },
  };
}
export function composeRecallContext(composition: RecallContextComposition): string {
  const context = trimText(composition.context);
  const footer = trimText(composition.footer);
  if (context.length === 0) return footer;
  if (footer.length === 0) return context;
  return `${context}${RECALL_CONTEXT_SEPARATOR}${footer}`;
}

export function renderMemoryContextPrompt({
  context: rawContext,
  footer: rawFooter,
  maxChars,
  compactContext: rawCompactContext,
}: RenderMemoryContextPromptInput): RenderedMemoryContextPrompt | null {
  const bounded = boundRecallContextComposition({
    context: rawContext,
    footer: rawFooter,
    maxChars,
    compactContext: rawCompactContext,
  });
  const body = composeRecallContext(bounded);
  if (body.length === 0) return null;

  const boundedBody = body.length <= maxChars ? body : truncateToBudget(bounded.footer || body, Math.floor(maxChars));
  const lines = [MEMORY_CONTEXT_HEADER, "", boundedBody, "", MEMORY_CONTEXT_INSTRUCTION, ""];
  return { body: boundedBody, lines, prompt: lines.join("\n").replace(/\n$/, "") };
}
