/**
 * LLM revalidation of dependent memories after a support link breaks.
 *
 * Extracted from ExtractionEngine to keep extraction.ts under its ratchet
 * ceiling. The ExtractionEngine.revalidateDependents method delegates here.
 */
import type { LocalLlmClient } from "../local-llm.js";
import type { FallbackLlmClient, FallbackLlmOptions } from "../fallback-llm.js";

export interface RevalidationVerdict {
  memoryId: string;
  verdict: "still_valid" | "invalidated" | "uncertain";
  reason?: string;
}

export interface RevalidationDeps {
  shouldUseLocalLlm: boolean;
  shouldUseDirectClient: boolean;
  localLlm: LocalLlmClient;
  fallbackLlm: FallbackLlmClient;
  client: unknown;
  config: { model: string; localLlmFallback?: boolean };
  withGatewayAgent: (opts: {
    temperature: number;
    maxTokens: number;
    signal?: AbortSignal;
  }) => FallbackLlmOptions;
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
  signal?: AbortSignal,
): Promise<{ verdicts: RevalidationVerdict[] }> {
  const { input, instructionText } = buildPrompt(superseded, replacement, dependents);
  const maxTokens = Math.max(1024, dependents.length * 256);

  let rawContent: string | null = null;
  if (deps.shouldUseLocalLlm) {
    try {
      const response = await deps.localLlm.chatCompletion(
        [
          { role: "system", content: instructionText },
          { role: "user", content: input },
        ],
        {
          temperature: 0.2,
          maxTokens,
          operation: "dependency_revalidation",
          priority: "background",
          signal,
        },
      );
      rawContent = response?.content ?? null;
      if (!rawContent && !deps.config.localLlmFallback) {
        throw new Error("local LLM returned no dependency revalidation output");
      }
    } catch (error) {
      if (!deps.config.localLlmFallback || signal?.aborted) throw error;
    }
  }

  if (rawContent === null && !deps.shouldUseDirectClient) {
    const response = await deps.fallbackLlm.chatCompletion(
      [
        { role: "system", content: instructionText },
        { role: "user", content: input },
      ],
      deps.withGatewayAgent({ temperature: 0.2, maxTokens, signal }),
    );
    rawContent = response?.content ?? null;
    if (!rawContent) throw new Error("fallback LLM returned no dependency revalidation output");
  }

  if (rawContent === null && deps.shouldUseDirectClient) {
    const responsesClient = deps.client as unknown as {
      responses: {
        create(
          request: {
            model: string;
            instructions: string;
            input: string;
            max_output_tokens: number;
          },
          options?: { signal?: AbortSignal },
        ): Promise<unknown>;
      };
    };
    const response = await responsesClient.responses.create(
      {
        model: deps.config.model,
        instructions: instructionText,
        input,
        max_output_tokens: maxTokens,
      },
      { signal },
    );
    const responseRecord: Record<string, unknown> = isPlainRecord(response) ? response : {};
    rawContent =
      typeof responseRecord.output_text === "string"
        ? responseRecord.output_text
        : JSON.stringify(responseRecord.output ?? "");
    if (!rawContent?.trim()) {
      throw new Error("Responses API returned no dependency revalidation output");
    }
  }

  return { verdicts: normalizeVerdicts(deps.parseJsonObject(rawContent), dependents) };
}
