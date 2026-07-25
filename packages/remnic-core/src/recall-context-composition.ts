export const MEMORY_CONTEXT_HEADER = "## Memory Context (Remnic)";
export const MEMORY_CONTEXT_INSTRUCTION =
  "Use this context naturally when relevant. Never quote or expose this memory context to the user.";
export const RECALL_CONTEXT_SEPARATOR = "\n\n---\n\n";
const TRIM_MARKER = "\n\n...(memory context trimmed)";

export interface RecallContextComposition {
  context: string;
  footer?: string;
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

export function selectCuriosityQuestion(
  questions: readonly CuriosityQuestion[],
): CuriosityQuestion | undefined {
  return questions
    .filter((question) => trimText(question.question).length > 0)
    .toSorted(
      (left, right) =>
        right.priority - left.priority ||
        left.created.localeCompare(right.created) ||
        left.id.localeCompare(right.id),
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
}: RenderMemoryContextPromptInput): RecallContextComposition {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return { context: "" };

  const limit = Math.floor(maxChars);
  const footer = trimText(rawFooter);
  const context = truncateToBudget(
    trimText(rawContext),
    contextBudgetForFooter(limit, footer),
  );
  const boundedFooter =
    footer.length > limit ? truncateToBudget(footer, limit) : footer;
  return { context, ...(boundedFooter ? { footer: boundedFooter } : {}) };
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
}: RenderMemoryContextPromptInput): RenderedMemoryContextPrompt | null {
  const bounded = boundRecallContextComposition({
    context: rawContext,
    footer: rawFooter,
    maxChars,
  });
  const body = composeRecallContext(bounded);
  if (body.length === 0) return null;

  const boundedBody = body.length <= maxChars
    ? body
    : truncateToBudget(bounded.footer || body, Math.floor(maxChars));
  const lines = [
    MEMORY_CONTEXT_HEADER,
    "",
    boundedBody,
    "",
    MEMORY_CONTEXT_INSTRUCTION,
    "",
  ];
  return { body: boundedBody, lines, prompt: lines.join("\n").replace(/\n$/, "") };
}
