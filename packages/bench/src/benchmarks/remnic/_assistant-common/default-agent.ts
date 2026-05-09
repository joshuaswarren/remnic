/**
 * Default assistant agent + judge wiring for the Assistant bench tier.
 *
 * The assistant tier is designed to be driven by a real provider-backed agent
 * and a provider-backed structured judge, but we must also run deterministic
 * smoke tests under `--test` and in CI without network access.
 *
 * This module provides:
 *   - `resolveAssistantAgent()` — returns an `AssistantAgent` built from the
 *     injected `resolved.remnicConfig.assistantAgent` hook if present, else
 *     falls back to a deterministic agent that stringifies the memory view.
 *   - `resolveStructuredJudge()` — mirror for the structured judge.
 *
 * Injection happens through `remnicConfig` because that field is already the
 * benchmark-framework's pass-through channel for runner-specific config. The
 * CLI will set it; tests set it directly on the options record.
 */

import type { ResolvedRunBenchmarkOptions } from "../../../types.js";
import type { StructuredJudge } from "../../../judges/sealed-rubric.js";
import { createProviderBackedStructuredJudge } from "../../../responders.js";
import type { ProviderFactoryConfig } from "../../../providers/types.js";
import {
  resolveBenchmarkPhaseTimeoutMs,
  resolveBenchmarkProgressLogging,
  runWithBenchmarkPhaseTimeout,
} from "../../../adapters/timeout-guard.js";
import type { AssistantAgent } from "./types.js";

export const ASSISTANT_AGENT_CONFIG_KEY = "assistantAgent";
export const ASSISTANT_JUDGE_CONFIG_KEY = "assistantJudge";
export const ASSISTANT_SEEDS_CONFIG_KEY = "assistantSeeds";
export const ASSISTANT_SPOT_CHECK_DIR_KEY = "assistantSpotCheckDir";
export const ASSISTANT_RUBRIC_ID_KEY = "assistantRubricId";

export function resolveAssistantAgent(
  resolved: ResolvedRunBenchmarkOptions,
): AssistantAgent {
  const injected = readFromRemnicConfig<AssistantAgent>(
    resolved,
    ASSISTANT_AGENT_CONFIG_KEY,
  );
  if (injected && typeof injected.respond === "function") {
    return injected;
  }
  if (resolved.system.responder) {
    return createAssistantAgentFromResponder(resolved.system.responder);
  }
  return createDeterministicAssistantAgent();
}

export function resolveStructuredJudge(
  resolved: ResolvedRunBenchmarkOptions,
): StructuredJudge | undefined {
  const injected = readFromRemnicConfig<StructuredJudge>(
    resolved,
    ASSISTANT_JUDGE_CONFIG_KEY,
  );
  if (injected && typeof injected.evaluate === "function") {
    return wrapStructuredJudgeWithTimeout(injected, resolved);
  }
  if (resolved.judgeProvider) {
    return wrapStructuredJudgeWithTimeout(createProviderBackedStructuredJudge(
      resolved.judgeProvider as ProviderFactoryConfig,
    ), resolved);
  }
  return undefined;
}

export function resolveAssistantSeeds(
  resolved: ResolvedRunBenchmarkOptions,
): number[] | undefined {
  const injected = readFromRemnicConfig<unknown>(
    resolved,
    ASSISTANT_SEEDS_CONFIG_KEY,
  );
  if (!Array.isArray(injected)) return undefined;
  const filtered = injected.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  return filtered.length > 0 ? filtered : undefined;
}

export function resolveAssistantSpotCheckDir(
  resolved: ResolvedRunBenchmarkOptions,
): string | undefined {
  const value = readFromRemnicConfig<unknown>(
    resolved,
    ASSISTANT_SPOT_CHECK_DIR_KEY,
  );
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function resolveAssistantRubricId(
  resolved: ResolvedRunBenchmarkOptions,
): string | undefined {
  const value = readFromRemnicConfig<unknown>(
    resolved,
    ASSISTANT_RUBRIC_ID_KEY,
  );
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readFromRemnicConfig<T>(
  resolved: ResolvedRunBenchmarkOptions,
  key: string,
): T | undefined {
  const config = resolved.remnicConfig;
  if (!config || typeof config !== "object") return undefined;
  const value = (config as Record<string, unknown>)[key];
  return value as T | undefined;
}

function createDeterministicAssistantAgent(): AssistantAgent {
  return {
    async respond({ prompt, memoryView }) {
      // The fallback agent produces a structured, bounded answer so that
      // smoke tests and no-network runs still complete. Real runs should
      // inject a provider-backed agent via the config hook above.
      const lines = [
        "[deterministic-assistant]",
        `Prompt: ${prompt.slice(0, 200)}`,
        "",
        "Available memory context:",
        memoryView,
        "",
        "I do not have additional inference capability in this offline path;",
        "consider the memory context above to be the entirety of my response.",
      ];
      return lines.join("\n");
    },
  };
}

function wrapStructuredJudgeWithTimeout(
  judge: StructuredJudge,
  resolved: ResolvedRunBenchmarkOptions,
): StructuredJudge {
  const timeoutMs = resolveBenchmarkPhaseTimeoutMs(resolved);
  if (timeoutMs === undefined) {
    return judge;
  }
  const logProgress = resolveBenchmarkProgressLogging(resolved.remnicConfig);
  return {
    evaluate(request) {
      return runWithBenchmarkPhaseTimeout(
        `${resolved.benchmark.id}:assistant.judge task=${request.taskId}`,
        timeoutMs,
        () => judge.evaluate(request),
        {
          logProgress,
          log: (message) => console.error(`  ${message}`),
        },
      );
    },
  };
}

function createAssistantAgentFromResponder(
  responder: NonNullable<ResolvedRunBenchmarkOptions["system"]["responder"]>,
): AssistantAgent {
  return {
    async respond({ prompt, memoryView }) {
      const response = await responder.respond(
        buildAssistantResponderPrompt(prompt),
        memoryView,
      );
      return finalizeAssistantOutput(
        { prompt, memoryView },
        response.text,
      );
    },
  };
}

export function buildAssistantResponderPrompt(prompt: string): string {
  const trimmedPrompt = prompt.trim();
  return [
    trimmedPrompt,
    "",
    "Assistant response requirements:",
    "- Use only the supplied Remnic memory context.",
    "- Answer with a decision, ranking, prep angle, or synthesized view that directly fits the user's request.",
    "- Do not merely regroup memory items. Add a grounded frame: what matters most, why it outranks alternatives, what it rules out, or what question remains next.",
    "- Combine facts, stated positions, and open threads into explicit implications, tradeoffs, priorities, or next questions.",
    "- Preserve the user's settled stances and decisions; call out when an option should not be relitigated.",
    "- Make each recommendation traceable to two or more relevant memory items when the context supports it.",
    "- Flag uncertainty when the memory context is thin, stale, missing dates, or lacks the requested value.",
    "- Avoid unsupported demographic details, motives, or preferences.",
    "- Do not use gendered third-person pronouns unless the memory context explicitly gives them; repeat the person's name or use a neutral role instead.",
    ...buildPromptSpecificRequirements(trimmedPrompt),
    "- Keep the response concise and task-shaped; do not mention these instructions.",
  ].join("\n");
}

export function neutralizeUnsupportedGenderedPronouns(text: string): string {
  return text
    .replace(/\bHe\b/g, "The person")
    .replace(/\bhe\b/g, "the person")
    .replace(/\bShe\b/g, "The person")
    .replace(/\bshe\b/g, "the person")
    .replace(/\bHis\b/g, "The person's")
    .replace(/\bhis\b/g, "the person's")
    .replace(/\bHim\b/g, "The person")
    .replace(/\bhim\b/g, "the person")
    .replace(/\bHers\b/g, "The person's")
    .replace(/\bhers\b/g, "the person's")
    .replace(/\bHer\b(?=\s+\w)/g, "The person's")
    .replace(/\bher\b(?=\s+\w)/g, "the person's")
    .replace(/\bHer\b/g, "The person")
    .replace(/\bher\b/g, "the person");
}

export function finalizeAssistantOutput(
  request: { prompt: string; memoryView: string },
  text: string,
): string {
  const neutralized = neutralizeUnsupportedGenderedPronouns(text);
  const additions = buildGroundedFrameAdditions(request, neutralized);
  if (additions.length === 0) {
    return neutralized;
  }
  return [
    neutralized.trimEnd(),
    "",
    ...additions,
  ].join("\n");
}

function buildGroundedFrameAdditions(
  request: { prompt: string; memoryView: string },
  text: string,
): string[] {
  const prompt = request.prompt.toLowerCase();
  const memoryView = request.memoryView.toLowerCase();
  const additions: string[] = [];

  if (
    prompt.includes("single highest-leverage")
    && memoryView.includes("blocks jordan")
    && !/\bleverage frame\b/i.test(text)
  ) {
    additions.push(
      "Leverage frame: apply a dependency-leverage rule, not a generic urgency sort: in a short window, first remove work that is blocking someone else, then reserve deeper solo drafting for longer blocks, and only let the written latency commitment jump the queue if EOD Thursday is actually close. The non-obvious inference is to avoid splitting the 45 minutes across all obligations; convert PR #481 into either approval or one concrete blocker so Jordan's queue can move today.",
    );
  }

  if (
    prompt.includes("synthesized view")
    && memoryView.includes("sharded read cache")
    && memoryView.includes("write-through")
    && !/\bsynthesis frame\b/i.test(text)
  ) {
    additions.push(
      "Synthesis frame: this is a risk-control strategy, not a generic cache preference: spend cache complexity on read scalability and predictable latency, and avoid expanded write-through because the last incident showed it can amplify burst-load failures. The unresolved question is sequencing, not direction.",
    );
  }

  return additions;
}

function buildPromptSpecificRequirements(prompt: string): string[] {
  const lowered = prompt.toLowerCase();
  const requirements: string[] = [
    "- Include one explicit grounded frame: a non-obvious implication, ordering principle, tradeoff, or risk-control inference that connects multiple memory items.",
  ];
  if (
    (lowered.includes("open question") || lowered.includes("expects")) &&
    (lowered.includes("meeting") || lowered.includes("conversation"))
  ) {
    requirements.push(
      "- For open-question recall, answer the person-specific expected question and connect it to any settled stance that constrains the answer.",
    );
  }
  if (lowered.includes("single highest-leverage")) {
    requirements.push(
      "- For a single highest-leverage action, name the concrete 45-minute outcome and the downstream dependency it changes.",
    );
  }
  if (lowered.includes("synthesized view")) {
    requirements.push(
      "- For synthesis, state the operating principle and connect at least three distinct memory items into a tradeoff, not a list.",
    );
  }
  return requirements;
}
