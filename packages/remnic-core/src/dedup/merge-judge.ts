/**
 * LLM merge judge for create-or-update merge-on-write (issue #2330, step 2).
 *
 * One structured-output call deciding whether a NEW memory describes the
 * same underlying concept as one of a handful of EXISTING in-band
 * candidates. Routing mirrors `extraction-judge.ts`: local LLM first
 * (unless `modelSource` is "gateway"), then the shared fallback client
 * with the gateway task-chain options. No raw OpenAI client here.
 *
 * The verdict is returned UNVALIDATED; `decideSemanticMerge` in
 * `dedup/merge.ts` hard-validates targetId and mergedContent before any
 * caller acts on them. A null return (no backend answered) is a
 * `judge_error` → create.
 */

import { extractJsonCandidates } from "../json-extract.js";
import { z } from "zod";
import type { LocalLlmClient } from "../local-llm.js";
import {
  FallbackLlmClient,
  gatewayTaskChainOptions,
} from "../fallback-llm.js";
import { log } from "../logger.js";
import type { PluginConfig } from "../types.js";
import type { MergeCandidate, MergeJudgeRawVerdict } from "./merge.js";

const MERGE_JUDGE_SYSTEM_PROMPT = `You maintain a long-term memory store. Given a NEW memory and up to N EXISTING
memories about a similar topic, decide:
- "merge": the new memory describes the SAME underlying concept/state as one
  existing memory, and the two can be combined into one entry with no
  information loss. Return targetId (one of the existing ids, verbatim) and
  mergedContent: one entry containing EVERY concrete detail from BOTH texts
  (names, numbers, dates, qualifiers). Do not paraphrase away specifics.
- "contradicts": the new memory conflicts with an existing one (state change,
  correction). Do NOT merge.
- "create": different concept, or you are unsure.
When unsure, choose "create".
Respond with a single JSON object: {"decision": "merge"|"create"|"contradicts", "targetId": string|null, "mergedContent": string|null, "reason": string}`;

const MergeVerdictSchema = z.object({
  decision: z.enum(["merge", "create", "contradicts"]),
  targetId: z.string().optional().nullable(),
  mergedContent: z.string().optional().nullable(),
  reason: z.string(),
});

export interface MergeJudgeCallOptions {
  content: string;
  category: string;
  candidates: readonly MergeCandidate[];
  config: PluginConfig;
  localLlm: LocalLlmClient | null;
  fallbackLlm: FallbackLlmClient | null;
}


function parseVerdict(raw: string): MergeJudgeRawVerdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    for (const candidate of extractJsonCandidates(raw)) {
      try {
        parsed = JSON.parse(candidate);
        break;
      } catch {
        continue;
      }
    }
  }
  const checked = MergeVerdictSchema.safeParse(parsed);
  if (!checked.success) return null;
  return {
    decision: checked.data.decision,
    targetId: checked.data.targetId ?? null,
    mergedContent: checked.data.mergedContent ?? null,
    reason: checked.data.reason,
  };
}

/**
 * Ask the merge judge. Returns the raw verdict, or null when no backend
 * answered or the answer failed schema validation — callers treat null as
 * judge-error and fail closed to create.
 */
export async function callMergeJudge(
  options: MergeJudgeCallOptions,
): Promise<MergeJudgeRawVerdict | null> {
  const userPrompt = JSON.stringify({
    new: { category: options.category, content: options.content },
    existing: options.candidates.map((c) => ({
      id: c.memoryId,
      category: c.category,
      similarity: Number(c.similarity.toFixed(4)),
      content: c.content,
    })),
  });
  const messages: Array<{ role: "system" | "user"; content: string }> = [
    { role: "system", content: MERGE_JUDGE_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];
  const modelOverride = options.config.extractionJudgeModel || undefined;
  const skipLocal = options.config.modelSource === "gateway";
  const gatewayChain = gatewayTaskChainOptions(options.config);
  const sharedCallOptions = {
    temperature: 0.1,
    maxTokens: 2048,
    ...(modelOverride ? { model: modelOverride } : {}),
  };

  if (options.localLlm && !skipLocal) {
    try {
      const result = await options.localLlm.chatCompletion(messages, {
        ...sharedCallOptions,
        timeoutMs: 1500,
        operation: "semantic-merge-judge",
        responseFormat: { type: "json_object" },
      });
      if (result?.content) {
        const verdict = parseVerdict(result.content);
        if (verdict) return verdict;
      }
    } catch (err) {
      log.debug(
        `semantic-merge judge: local LLM failed, trying fallback: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (options.fallbackLlm) {
    try {
      const result = await options.fallbackLlm.chatCompletion(
        messages as Array<{ role: "system" | "user" | "assistant"; content: string }>,
        { ...sharedCallOptions, timeoutMs: 1500, ...gatewayChain },
      );
      if (result?.content) {
        const verdict = parseVerdict(result.content);
        if (verdict) return verdict;
      }
    } catch (err) {
      log.debug(
        `semantic-merge judge: fallback LLM failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return null;
}
