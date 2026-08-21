import type { FallbackLlmClient, FallbackLlmOptions } from "@remnic/core";
import { normalizeChallenge, normalizeClaimDraft, normalizeJudgeResult, normalizePredictionGrade } from "./schema.js";
import type {
  LedgerChallenge,
  LedgerClaim,
  LedgerClaimDraft,
  LedgerJudgeResult,
  LedgerLlmAdapter,
  LedgerPredictionGrade,
} from "./types.js";

export interface FallbackLlmLedgerAdapterOptions extends FallbackLlmOptions {
  agentId?: string;
}

export function createFallbackLlmLedgerAdapter(
  client: FallbackLlmClient,
  options: FallbackLlmLedgerAdapterOptions = {}
): LedgerLlmAdapter {
  const baseOptions = { ...options };
  return {
    async extractClaim(request): Promise<LedgerClaimDraft> {
      const parsed = await client.parseWithSchema(
        [
          { role: "system", content: EXTRACT_PROMPT },
          {
            role: "user",
            content: [
              `Current time: ${request.now}`,
              request.sessionKey ? `Session: ${request.sessionKey}` : "",
              "User text:",
              request.text,
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
        {
          parse: (data: unknown) => normalizeExtractedDraft(data, request.now, request.text),
        },
        { ...baseOptions, temperature: baseOptions.temperature ?? 0.1, maxTokens: baseOptions.maxTokens ?? 1_200 }
      );
      if (!parsed) {
        throw new Error("belief-ledger extraction LLM did not return a valid claim");
      }
      return parsed;
    },

    async judgeClaimPair(request): Promise<LedgerJudgeResult> {
      const parsed = await client.parseWithSchema(
        [
          { role: "system", content: JUDGE_PROMPT },
          { role: "user", content: formatJudgeInput(request.current, request.prior) },
        ],
        {
          parse: (data: unknown) => normalizeJudgeResult(data, request.prior.id),
        },
        { ...baseOptions, temperature: baseOptions.temperature ?? 0.1, maxTokens: baseOptions.maxTokens ?? 800 }
      );
      if (!parsed) {
        throw new Error("belief-ledger judge LLM did not return a valid verdict");
      }
      return parsed;
    },

    async draftSocraticChallenge(request): Promise<LedgerChallenge> {
      const priorClaimIds = request.contradictions.map((item) => item.claim.id);
      const parsed = await client.parseWithSchema(
        [
          { role: "system", content: CHALLENGE_PROMPT },
          {
            role: "user",
            content: [
              "Current claim:",
              formatClaim(request.current),
              "",
              "Contradicting prior claims:",
              ...request.contradictions.map(
                (item) => `${formatClaim(item.claim)}\nJudge rationale: ${item.judgment.rationale}`
              ),
            ].join("\n"),
          },
        ],
        {
          parse: (data: unknown) => normalizeChallenge(data, priorClaimIds),
        },
        { ...baseOptions, temperature: baseOptions.temperature ?? 0.2, maxTokens: baseOptions.maxTokens ?? 800 }
      );
      if (!parsed) {
        throw new Error("belief-ledger challenge LLM did not return a valid prompt");
      }
      return parsed;
    },

    async gradePrediction(request): Promise<LedgerPredictionGrade | null> {
      if (!request.verdictSource?.trim()) return null;
      const parsed = await client.parseWithSchema(
        [
          { role: "system", content: GRADE_PROMPT },
          {
            role: "user",
            content: [
              `Current time: ${request.now}`,
              "Prediction:",
              formatClaim(request.claim),
              "",
              "Verdict source:",
              request.verdictSource,
            ].join("\n"),
          },
        ],
        {
          parse: (data: unknown) => normalizePredictionGrade(data),
        },
        { ...baseOptions, temperature: baseOptions.temperature ?? 0.1, maxTokens: baseOptions.maxTokens ?? 800 }
      );
      return parsed;
    },
  };
}

const EXTRACT_PROMPT = `Extract one belief-ledger claim from the user's text.

Return JSON only:
{
  "statement": "single clear claim or prediction",
  "kind": "claim" | "prediction" | "opinion",
  "stance": "for" | "against" | "uncertain" | "neutral",
  "confidence": 0.0,
  "scope": {
    "entities": ["entity names"],
    "domain": "optional topic",
    "timeWindow": { "start": "optional ISO", "end": "optional ISO" }
  },
  "deadline": "optional ISO timestamp for predictions",
  "evidenceLinks": ["optional source URLs or identifiers"]
}

Use the user's stated confidence when present. If no confidence is stated, estimate conservatively.`;

const JUDGE_PROMPT = `Classify how the current claim relates to the prior claim.

Return JSON only:
{
  "classification": "contradiction" | "evolution" | "refinement" | "unrelated",
  "confidence": 0.0,
  "rationale": "brief reason"
}

Use "contradiction" only when both claims cannot comfortably be true at the same time under their stated scope.`;

const CHALLENGE_PROMPT = `Draft one concise Socratic challenge for the user.

Return JSON only:
{
  "question": "one question asking the user to reconcile the conflict",
  "priorClaimIds": ["ids involved"],
  "suggestedActions": ["supersede", "split", "resolve", "ignore"]
}

Do not agree with the user by default. Ask for a reconciliation decision.`;

const GRADE_PROMPT = `Grade whether the prediction came true from the supplied verdict source.

Return JSON only:
{
  "verdict": "true" | "false" | "mixed" | "unknown",
  "actualConfidence": 0.0,
  "rationale": "brief reason",
  "source": "short source label"
}

Use actualConfidence 1 for true, 0 for false, a fractional value for mixed, and 0.5 for unknown.`;

function normalizeExtractedDraft(data: unknown, now: string, sourceText: string): LedgerClaimDraft {
  if (!isRecord(data)) {
    throw new Error("claim extraction result must be an object");
  }
  const scope = isRecord(data.scope) ? data.scope : {};
  const rawTimeWindow = isRecord(scope.timeWindow)
    ? scope.timeWindow
    : isRecord(scope.time_window)
      ? scope.time_window
      : undefined;
  const draft: LedgerClaimDraft = {
    statement: asString(data.statement),
    kind: optionalString(data.kind) as LedgerClaimDraft["kind"],
    stance: asString(data.stance) as LedgerClaimDraft["stance"],
    confidence: asNumber(data.confidence),
    scope: {
      entities: Array.isArray(scope.entities)
        ? scope.entities.filter((value): value is string => typeof value === "string")
        : [],
      ...(typeof scope.domain === "string" ? { domain: scope.domain } : {}),
      ...(rawTimeWindow
        ? {
            timeWindow: {
              ...(typeof rawTimeWindow.start === "string" ? { start: rawTimeWindow.start } : {}),
              ...(typeof rawTimeWindow.end === "string" ? { end: rawTimeWindow.end } : {}),
            },
          }
        : {}),
    },
    ...(typeof data.deadline === "string" && data.deadline.trim() ? { deadline: data.deadline } : {}),
    evidenceLinks: Array.isArray(data.evidenceLinks)
      ? data.evidenceLinks.filter((value): value is string => typeof value === "string")
      : Array.isArray(data.evidence_links)
        ? data.evidence_links.filter((value): value is string => typeof value === "string")
        : [],
  };
  const normalized = normalizeClaimDraft(draft, { now, sourceText });
  return {
    statement: normalized.statement,
    kind: normalized.kind,
    stance: normalized.stance,
    confidence: normalized.confidence,
    scope: normalized.scope,
    ...(normalized.deadline ? { deadline: normalized.deadline } : {}),
    evidenceLinks: normalized.evidenceLinks,
  };
}

function formatJudgeInput(current: LedgerClaim, prior: LedgerClaim): string {
  return ["Current claim:", formatClaim(current), "", "Prior claim:", formatClaim(prior)].join("\n");
}

function formatClaim(claim: LedgerClaim): string {
  return [
    `id: ${claim.id}`,
    `created: ${claim.createdAt}`,
    `statement: ${claim.statement}`,
    `kind: ${claim.kind}`,
    `stance: ${claim.stance}`,
    `confidence: ${claim.confidence}`,
    `domain: ${claim.scope.domain ?? ""}`,
    `entities: ${claim.scope.entities.join(", ")}`,
    `timeWindow.start: ${claim.scope.timeWindow?.start ?? ""}`,
    `timeWindow.end: ${claim.scope.timeWindow?.end ?? ""}`,
    `deadline: ${claim.deadline ?? ""}`,
    `status: ${claim.status}`,
  ].join("\n");
}

function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("expected string");
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  throw new Error("expected number");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
