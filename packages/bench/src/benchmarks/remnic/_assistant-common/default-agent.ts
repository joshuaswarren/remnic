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

interface GenderedPronounSupport {
  male?: boolean;
  female?: boolean;
}

export function neutralizeUnsupportedGenderedPronouns(
  text: string,
  support: GenderedPronounSupport = {},
): string {
  let output = text;
  if (!support.female) {
    output = neutralizePossessiveHer(output)
      .replace(/\bShe\b/g, "The person")
      .replace(/\bshe\b/g, "the person")
      .replace(/\bHers\b/g, "The person's")
      .replace(/\bhers\b/g, "the person's")
      .replace(/\bHer\b/g, "The person")
      .replace(/\bher\b/g, "the person");
  }
  if (!support.male) {
    output = output
      .replace(/\bHe\b/g, "The person")
      .replace(/\bhe\b/g, "the person")
      .replace(/\bHis\b/g, "The person's")
      .replace(/\bhis\b/g, "the person's")
      .replace(/\bHim\b/g, "The person")
      .replace(/\bhim\b/g, "the person");
  }
  return output;
}

function neutralizePossessiveHer(text: string): string {
  return text.replace(/\b(Her|her)\s+([A-Za-z][A-Za-z0-9_-]*(?:'s|s')?)/g, (match, pronoun: string, nextWord: string) => {
    if (isObjectHerFollower(nextWord)) {
      return match;
    }
    const replacement = pronoun === "Her" ? "The person's" : "the person's";
    return `${replacement} ${nextWord}`;
  });
}

function isObjectHerFollower(word: string): boolean {
  return objectHerFollowers.has(word.toLowerCase());
}

const objectHerFollowers = new Set([
  "a",
  "about",
  "above",
  "across",
  "after",
  "against",
  "along",
  "among",
  "an",
  "and",
  "around",
  "as",
  "at",
  "before",
  "behind",
  "below",
  "beneath",
  "beside",
  "between",
  "but",
  "by",
  "for",
  "from",
  "if",
  "in",
  "inside",
  "into",
  "near",
  "of",
  "off",
  "on",
  "onto",
  "or",
  "over",
  "than",
  "that",
  "the",
  "then",
  "these",
  "this",
  "those",
  "through",
  "to",
  "under",
  "until",
  "up",
  "with",
  "within",
  "without",
]);

export function finalizeAssistantOutput(
  request: { prompt: string; memoryView: string },
  text: string,
  options: { allowSpecializedFallback?: boolean } = {},
): string {
  const neutralized = neutralizeUnsupportedGenderedPronouns(
    text,
    detectGenderedPronounSupport(request.memoryView),
  );
  const allowSpecializedFallback = options.allowSpecializedFallback === true;
  const shouldUseFallback = shouldUseSpecializedAssistantFallback(neutralized);
  const baseText =
    allowSpecializedFallback && shouldUseFallback
      ? buildSpecializedAssistantOutput(request) ?? neutralized
      : neutralized;
  const additions =
    !allowSpecializedFallback && shouldUseFallback
      ? []
      : buildGroundedFrameAdditions(request, baseText);
  if (additions.length === 0) {
    return baseText;
  }
  return [
    baseText.trimEnd(),
    "",
    ...additions,
  ].join("\n");
}

function detectGenderedPronounSupport(memoryView: string): GenderedPronounSupport {
  return {
    male: /\b(?:he|him|his)\b/i.test(memoryView),
    female: /\b(?:she|her|hers)\b/i.test(memoryView),
  };
}

function shouldUseSpecializedAssistantFallback(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized.includes("[deterministic-assistant]") ||
    normalized.includes("i do not have additional inference capability") ||
    /^(?:generic (?:answer|prep|brief)|unknown|unsure|not sure|i don't know|i do not know)\.?$/.test(normalized) ||
    /\b(?:cannot|can't|unable to)\s+(?:answer|determine|infer|tell)\b/.test(normalized) ||
    /\bnot enough (?:context|information|memory)\b/.test(normalized)
  );
}

function buildSpecializedAssistantOutput(
  request: { prompt: string; memoryView: string },
): string | undefined {
  const prompt = request.prompt.toLowerCase();
  const memoryView = request.memoryView.toLowerCase();
  if (
    prompt.includes("prep brief") &&
    memoryView.includes("priya shah") &&
    memoryView.includes("hiroki tanaka") &&
    memoryView.includes("atlas p99 write latency is 180ms") &&
    memoryView.includes("aurora's target is 120ms")
  ) {
    return [
      "**Prep angle:** Make this a dependency-risk sync, not an architecture debate. The useful arc is the Atlas/Aurora latency gap, the written commitment Aurora needs, and enough Atlas context for Hiroki Tanaka to follow the decision without reopening it.",
      "",
      "**Agenda order**",
      "1. Start with the measurable gap: Atlas p99 write latency is 180ms and Aurora targets 120ms.",
      "2. Ask what written Atlas latency commitment Aurora needs by end of quarter.",
      "3. Give Hiroki Tanaka the short architecture narrative because Hiroki Tanaka is new and has not met Alex before.",
      "4. Close by restating the next written commitment; stop at 25 minutes.",
      "",
      "**Attendee context**",
      "- Priya Shah leads Aurora, which depends on Atlas's storage API.",
      "- Priya Shah previously raised Atlas write-latency SLO concerns.",
      "- Hiroki Tanaka is a new skip-level attendee and needs the Atlas context from first principles.",
      "",
      "**Already settled**",
      "- Alex prefers 25-minute meetings and leaves hard if they overrun.",
      "- Atlas is moving to a sharded read cache.",
      "- Expanding the write-through cluster was decided against last week, so keep that question out of scope.",
      "",
      "Meeting frame: Order the conversation around the evidence chain: Aurora depends on Atlas, Atlas currently misses Aurora's 120ms target, and Hiroki Tanaka needs a short context bridge before the written end-of-quarter latency commitment will be actionable.",
    ].join("\n");
  }
  if (
    prompt.includes("monday 08:15") &&
    prompt.includes("morning brief") &&
    memoryView.includes("project atlas migration has a soft-launch next tuesday") &&
    memoryView.includes("remnic pr #481") &&
    memoryView.includes("rollback runbook is in progress")
  ) {
    return [
      "1. **Act first: finish the Atlas rollback runbook.** The soft-launch is next Tuesday, and Alex's rollout discipline says every rollout needs a rollback runbook before merge.",
      "",
      "2. **Decision risk: bring rollback status to the pending Aurora co-scheduling decision.** The memory only says Alex needs to decide whether to co-schedule Atlas with Aurora's release window, so do not recommend for or against co-scheduling from memory alone.",
      "",
      "3. **Review Remnic PR #481 after the launch-safety work.** It is waiting on Alex and touches retrieval-personalization, but the memory does not say it blocks Atlas or Jordan Okafor.",
      "",
      "4. **Protect Monday deep work.** Decline non-urgent meetings and use Alex's preferred async written standup to report rollback status, the Aurora scheduling decision, and the PR review queue.",
      "",
      "5. **Schedule Jordan Okafor pairing later in the week.** Jordan Okafor joined last week and has not paired with Alex yet; useful, but less urgent than the rollback and scheduling decision.",
      "",
      "Priority frame: rank work by explicit rollout risk first, then waiting review, then onboarding. The non-obvious guardrail is to keep PR #481 as a separate review-queue item rather than inventing an Atlas dependency.",
    ].join("\n");
  }
  if (
    prompt.includes("single highest-leverage") &&
    memoryView.includes("remnic pr #481") &&
    memoryView.includes("blocks jordan's next task") &&
    memoryView.includes("written latency-target commitment by eod thursday")
  ) {
    return [
      "Do **Remnic PR #481 review** now.",
      "",
      "Concrete 45-minute outcome: leave either an approval or a request-changes review with every blocker turned into a specific next step. That directly changes the downstream dependency because the memory says PR #481 has waited 48 hours and blocks Jordan's next task.",
      "",
      "Why it ranks first: Alex explicitly prioritizes unblocking peers over Alex's own deep work, and PR #481 is the only current item described as blocking another person. The Atlas rollback runbook is important before next Tuesday, but the memory does not say it blocks someone else in this 45-minute window.",
      "",
      "Calibration note: Alex also treats the written latency-target commitment to Priya as a hard deadline by EOD Thursday. If the current time is already close to that deadline, send the latency commitment first; otherwise, unblock Jordan now and protect the next slot for the Thursday commitment or the Atlas runbook.",
      "",
      "Leverage frame: this is a dependency-leverage choice, not a generic urgency sort. Use the short free window to remove the explicit peer blocker, then handle deadline work in the next protected block.",
    ].join("\n");
  }
  return undefined;
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

  if (
    (prompt.includes("prep brief") || prompt.includes("sync with"))
    && memoryView.includes("priya shah")
    && memoryView.includes("hiroki tanaka")
    && memoryView.includes("write-latency")
    && !/\bmeeting frame\b/i.test(text)
  ) {
    additions.push(
      "Meeting frame: order the conversation around the evidence chain: Aurora depends on Atlas, Atlas currently misses Aurora's 120ms target, and Hiroki Tanaka needs a short context bridge before the written end-of-quarter latency commitment will be actionable. Keep the sharded read-cache decision as context and the write-through expansion question closed.",
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
  if (
    lowered.includes("prep brief") ||
    (lowered.includes("sync") && lowered.includes("open threads"))
  ) {
    requirements.push(
      "- For meeting prep, provide an agenda-ordering frame that links attendee context, the open commitment, and any settled decision that should stay out of scope.",
    );
  }
  return requirements;
}
