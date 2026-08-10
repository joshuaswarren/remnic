/**
 * LLM revalidation of dependent memories after a support link breaks.
 *
 * Extracted from ExtractionEngine to keep extraction.ts under its ratchet
 * ceiling. The ExtractionEngine.revalidateDependents method delegates here.
 */

export interface RevalidationVerdict {
  memoryId: string;
  verdict: "still_valid" | "invalidated" | "uncertain";
  reason?: string;
}

export type RevalidationFastChatCompletion = (
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options: {
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    operation?: string;
    priority?: "background" | "recall-critical";
    signal?: AbortSignal;
  },
) => Promise<{ content: string } | null>;

export interface RevalidationDeps {
  fastChatCompletion: RevalidationFastChatCompletion;
  parseJsonObject: (raw: string | null) => unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildPrompt(
  superseded: { id: string; content: string },
  replacement: { id: string; content: string } | null,
  dependents: Array<{ id: string; category: string; content: string }>,
): { input: string; instructionText: string } {
  const dependentPrompt = dependents
    .map(
      (memory, index) =>
        `[${index + 1}] id: ${memory.id} | category: ${memory.category}\n${memory.content}`,
    )
    .join("\n\n");
  const input = `SUPERSEDED MEMORY (id: ${superseded.id}):
${superseded.content}

REPLACEMENT (id: ${replacement?.id ?? "none"}):
${replacement?.content ?? "none — the memory was removed without replacement"}

DEPENDENTS TO REVALIDATE (return exactly one verdict per id):
${dependentPrompt}`;
  const instructionText = `You revalidate dependent memory claims after a supporting memory changes.
For each requested memory, decide whether its claim still holds.
Return valid JSON only:
{"verdicts":[{"memoryId":"id","verdict":"still_valid|invalidated|uncertain","reason":"brief reason"}]}
Never invent memory IDs. Use "uncertain" when the evidence is insufficient.`;
  return { input, instructionText };
}

function normalizeVerdicts(
  parsed: unknown,
  dependents: Array<{ id: string }>,
): RevalidationVerdict[] {
  const raw: unknown[] = isPlainRecord(parsed) && Array.isArray(parsed.verdicts) ? parsed.verdicts : [];
  const requested = new Set(dependents.map((memory) => memory.id));
  const seen = new Set<string>();
  const normalized: RevalidationVerdict[] = [];
  for (const candidate of raw) {
    if (!isPlainRecord(candidate)) continue;
    const memoryId = typeof candidate.memoryId === "string" ? candidate.memoryId.trim() : "";
    if (!requested.has(memoryId) || seen.has(memoryId)) continue;
    seen.add(memoryId);
    const verdict =
      candidate.verdict === "still_valid" ||
      candidate.verdict === "invalidated" ||
      candidate.verdict === "uncertain"
        ? candidate.verdict
        : "uncertain";
    normalized.push({
      memoryId,
      verdict,
      ...(typeof candidate.reason === "string" ? { reason: candidate.reason } : {}),
    });
  }
  return dependents.map((memory) => {
    const verdict = normalized.find((candidate) => candidate.memoryId === memory.id);
    return verdict ?? { memoryId: memory.id, verdict: "uncertain" as const };
  });
}

export async function revalidateDependentsViaLlm(
  deps: RevalidationDeps,
  superseded: { id: string; content: string },
  replacement: { id: string; content: string } | null,
  dependents: Array<{ id: string; category: string; content: string }>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ verdicts: RevalidationVerdict[] }> {
  const { input, instructionText } = buildPrompt(superseded, replacement, dependents);
  const maxTokens = Math.max(1024, dependents.length * 256);
  const response = await deps.fastChatCompletion(
    [
      { role: "system", content: instructionText },
      { role: "user", content: input },
    ],
    {
      temperature: 0.2,
      maxTokens,
      operation: "dependency_revalidation",
      priority: "background",
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    },
  );
  const rawContent = response?.content ?? null;
  if (!rawContent?.trim()) {
    throw new Error("fast completion returned no dependency revalidation output");
  }

  return { verdicts: normalizeVerdicts(deps.parseJsonObject(rawContent), dependents) };
}
