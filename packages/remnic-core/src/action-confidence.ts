import {
  normalizeRetrievedMemoryProvenance,
  type RetrievedMemoryCorrectionState,
  type RetrievedMemoryProvenance,
  type RetrievedMemorySafety,
} from "./memory-provenance.js";

export const ACTION_CONFIDENCE_DECISIONS = [
  "ask",
  "draft",
  "act",
  "refuse",
  "escalate",
] as const;

export type ActionConfidenceDecision = typeof ACTION_CONFIDENCE_DECISIONS[number];

export const ACTION_CONFIDENCE_RISK_CATEGORIES = [
  "low",
  "medium",
  "high",
  "irreversible",
  "restricted",
] as const;

export type ActionConfidenceRiskCategory = typeof ACTION_CONFIDENCE_RISK_CATEGORIES[number];

export const ACTION_CONFIDENCE_CONTEXT_READINESS = [
  "none",
  "partial",
  "sufficient",
] as const;

export type ActionConfidenceContextReadiness =
  typeof ACTION_CONFIDENCE_CONTEXT_READINESS[number];

export const ACTION_CONFIDENCE_RULE_KINDS = [
  "ask-before",
  "do-not-use-outside-this-context",
  "never",
  "requires-escalation",
] as const;

export type ActionConfidenceRuleKind = typeof ACTION_CONFIDENCE_RULE_KINDS[number];

export interface ActionConfidenceRule {
  kind: ActionConfidenceRuleKind;
  description?: string;
  matched?: boolean;
}

export interface ActionConfidenceMemoryInput {
  source?: string;
  created?: string;
  updated?: string;
  scope?: string;
  userContextScopes?: string[];
  retrievalReason?: string;
  confidence?: number;
  stale?: boolean;
  corrected?: boolean;
  correctionState?: RetrievedMemoryCorrectionState;
  safeToUse?: boolean;
  safety?: RetrievedMemorySafety;
  safetyReasons?: string[];
}

export interface ActionConfidenceInput {
  intendedAction?: string;
  confidence?: number;
  risk?: ActionConfidenceRiskCategory;
  contextReadiness?: ActionConfidenceContextReadiness;
  currentContextScopes?: string[];
  userRules?: ActionConfidenceRule[];
  retrievedMemories?: ActionConfidenceMemoryInput[];
}

export interface ActionConfidenceOptionInput {
  action?: unknown;
  confidence?: unknown;
  risk?: unknown;
  context?: unknown;
  rule?: unknown;
  currentScope?: unknown;
  memoryScope?: unknown;
  stale?: unknown;
  corrected?: unknown;
  unsafe?: unknown;
}

export interface ActionConfidenceFactor {
  name: string;
  status: "positive" | "negative" | "neutral";
  message: string;
}

export interface ActionConfidenceResult {
  schemaVersion: 1;
  decision: ActionConfidenceDecision;
  confidence: number;
  risk: ActionConfidenceRiskCategory;
  contextReadiness: ActionConfidenceContextReadiness;
  intendedAction?: string;
  attentionPolicy: "interruption_budgeting";
  principle: string;
  reasons: string[];
  blockers: string[];
  factors: ActionConfidenceFactor[];
  retrievedMemoryCount: number;
  usableMemoryCount: number;
  staleMemoryCount: number;
  correctedMemoryCount: number;
  scopeMismatchCount: number;
  safeToAct: boolean;
}

const ATTENTION_PRINCIPLE =
  "A good agent should spend the user's attention carefully.";

function assertConfidence(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} must be a finite number between 0 and 1`);
  }
  return value;
}

function roundConfidence(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}

function normalizeMemory(input: ActionConfidenceMemoryInput): RetrievedMemoryProvenance {
  const normalized = normalizeRetrievedMemoryProvenance({
    source: input.source,
    created: input.created,
    updated: input.updated,
    scope: input.scope,
    userContextScopes: input.userContextScopes,
    retrievalReason: input.retrievalReason,
    confidence: assertConfidence(input.confidence, "retrievedMemories[].confidence"),
    stale: input.stale,
    corrected: input.corrected,
    correctionState: input.correctionState,
    safeToUse: input.safeToUse,
    safety: input.safety,
    safetyReasons: input.safetyReasons,
  });
  if (!normalized) {
    throw new TypeError("retrievedMemories[] must be an object");
  }
  return normalized;
}

function inferContextReadiness(input: ActionConfidenceInput, memories: RetrievedMemoryProvenance[]): ActionConfidenceContextReadiness {
  if (input.contextReadiness) return input.contextReadiness;
  if (memories.some((memory) => memory.safeToUse && !memory.stale)) {
    return "partial";
  }
  return "none";
}

function hasScopeMismatch(memory: RetrievedMemoryProvenance, currentContextScopes: Set<string>): boolean {
  if (memory.userContextScopes.length === 0 || currentContextScopes.size === 0) {
    return false;
  }
  return !memory.userContextScopes.some((scope) => currentContextScopes.has(scope));
}

function matchedRules(input: ActionConfidenceInput): ActionConfidenceRule[] {
  return (input.userRules ?? []).filter((rule) => rule.matched !== false);
}

function ruleLabel(rule: ActionConfidenceRule): string {
  return rule.description?.trim() || rule.kind;
}

function splitActionConfidenceList(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

export function buildActionConfidenceInputFromOptions(
  options: ActionConfidenceOptionInput,
): ActionConfidenceInput {
  let confidence: number | undefined;
  if (options.confidence !== undefined) {
    if (typeof options.confidence !== "string") {
      throw new Error("--confidence requires a value between 0 and 1");
    }
    confidence = Number(options.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error(`--confidence must be a finite number between 0 and 1 (got ${JSON.stringify(options.confidence)})`);
    }
  }

  let risk: ActionConfidenceRiskCategory | undefined;
  if (options.risk !== undefined) {
    if (
      typeof options.risk !== "string" ||
      !ACTION_CONFIDENCE_RISK_CATEGORIES.includes(options.risk as ActionConfidenceRiskCategory)
    ) {
      throw new Error(`--risk must be one of: ${ACTION_CONFIDENCE_RISK_CATEGORIES.join(", ")}`);
    }
    risk = options.risk as ActionConfidenceRiskCategory;
  }

  let contextReadiness: ActionConfidenceContextReadiness | undefined;
  if (options.context !== undefined) {
    if (
      typeof options.context !== "string" ||
      !ACTION_CONFIDENCE_CONTEXT_READINESS.includes(options.context as ActionConfidenceContextReadiness)
    ) {
      throw new Error(`--context must be one of: ${ACTION_CONFIDENCE_CONTEXT_READINESS.join(", ")}`);
    }
    contextReadiness = options.context as ActionConfidenceContextReadiness;
  }

  const ruleKinds = splitActionConfidenceList(options.rule);
  const userRules = ruleKinds?.map((kind) => {
    if (!ACTION_CONFIDENCE_RULE_KINDS.includes(kind as ActionConfidenceRuleKind)) {
      throw new Error(`--rule entries must be one of: ${ACTION_CONFIDENCE_RULE_KINDS.join(", ")}`);
    }
    return { kind: kind as ActionConfidenceRuleKind };
  });
  const currentContextScopes = splitActionConfidenceList(options.currentScope);
  const memoryScopes = splitActionConfidenceList(options.memoryScope);
  const hasMemoryFlags =
    memoryScopes !== undefined ||
    options.stale === true ||
    options.corrected === true ||
    options.unsafe === true;

  return {
    ...(typeof options.action === "string" && options.action.trim().length > 0
      ? { intendedAction: options.action.trim() }
      : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(risk ? { risk } : {}),
    ...(contextReadiness ? { contextReadiness } : {}),
    ...(currentContextScopes ? { currentContextScopes } : {}),
    ...(userRules ? { userRules } : {}),
    ...(hasMemoryFlags
      ? {
          retrievedMemories: [
            {
              ...(confidence !== undefined ? { confidence } : {}),
              ...(memoryScopes ? { userContextScopes: memoryScopes } : {}),
              ...(options.stale === true ? { stale: true } : {}),
              ...(options.corrected === true ? { corrected: true } : {}),
              ...(options.unsafe === true
                ? { safeToUse: false, safety: "blocked" as const }
                : {}),
            },
          ],
        }
      : {}),
  };
}

export function evaluateActionConfidence(input: ActionConfidenceInput = {}): ActionConfidenceResult {
  const memories = (input.retrievedMemories ?? []).map(normalizeMemory);
  const currentContextScopes = new Set(
    (input.currentContextScopes ?? [])
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0),
  );
  const rules = matchedRules(input);
  const risk = input.risk ?? "medium";
  const contextReadiness = inferContextReadiness(input, memories);

  const blockedMemories = memories.filter((memory) => memory.safety === "blocked");
  const usableMemories = memories.filter(
    (memory) => memory.safeToUse && memory.safety !== "blocked",
  );
  const staleMemoryCount = usableMemories.filter((memory) => memory.stale).length;
  const correctedMemoryCount = usableMemories.filter((memory) => memory.corrected).length;
  const scopeMismatchCount = memories.filter((memory) =>
    hasScopeMismatch(memory, currentContextScopes),
  ).length;

  const explicitConfidence = assertConfidence(input.confidence, "confidence");
  const provenanceConfidence =
    usableMemories.length > 0
      ? usableMemories.reduce((sum, memory) => sum + memory.confidence, 0) / usableMemories.length
      : undefined;
  let confidence = explicitConfidence ?? provenanceConfidence ?? 0.5;

  const factors: ActionConfidenceFactor[] = [];
  const reasons: string[] = [];
  const blockers: string[] = [];

  if (usableMemories.length > 0) {
    factors.push({
      name: "provenance",
      status: "positive",
      message: `${usableMemories.length} usable retrieved memory source${usableMemories.length === 1 ? "" : "s"}`,
    });
    reasons.push("Retrieved memory has usable provenance.");
  } else if (memories.length > 0) {
    factors.push({
      name: "provenance",
      status: "negative",
      message: "Retrieved memory exists, but none is safe and usable.",
    });
  } else {
    factors.push({
      name: "provenance",
      status: "neutral",
      message: "No retrieved memories were supplied.",
    });
  }

  if (contextReadiness === "none") {
    confidence -= 0.25;
    factors.push({
      name: "context",
      status: "negative",
      message: "No usable context was supplied.",
    });
  } else if (contextReadiness === "sufficient") {
    confidence += 0.08;
    factors.push({
      name: "context",
      status: "positive",
      message: "Caller marked the context as sufficient.",
    });
  } else {
    factors.push({
      name: "context",
      status: "neutral",
      message: "Caller supplied partial context.",
    });
  }

  if (staleMemoryCount > 0) {
    confidence -= Math.min(0.25, staleMemoryCount * 0.08);
    factors.push({
      name: "staleness",
      status: "negative",
      message: `${staleMemoryCount} retrieved memory source${staleMemoryCount === 1 ? " is" : "s are"} stale.`,
    });
  }

  if (correctedMemoryCount > 0) {
    confidence -= Math.min(0.2, correctedMemoryCount * 0.07);
    factors.push({
      name: "correction",
      status: "negative",
      message: `${correctedMemoryCount} retrieved memory source${correctedMemoryCount === 1 ? " has" : "s have"} correction history.`,
    });
  }

  if (scopeMismatchCount > 0) {
    confidence -= Math.min(0.35, scopeMismatchCount * 0.12);
    factors.push({
      name: "scope",
      status: "negative",
      message: `${scopeMismatchCount} retrieved memory source${scopeMismatchCount === 1 ? " does" : "s do"} not match the current context scope.`,
    });
  }

  if (blockedMemories.length > 0) {
    blockers.push(`${blockedMemories.length} retrieved memory source${blockedMemories.length === 1 ? " is" : "s are"} blocked by safety or boundary metadata.`);
  }

  for (const rule of rules) {
    if (rule.kind === "never") {
      blockers.push(`User rule forbids this action: ${ruleLabel(rule)}.`);
    } else if (rule.kind === "do-not-use-outside-this-context") {
      blockers.push(`User boundary rule blocks this context: ${ruleLabel(rule)}.`);
    } else if (rule.kind === "ask-before") {
      reasons.push(`Matched ask-before rule: ${ruleLabel(rule)}.`);
    } else if (rule.kind === "requires-escalation") {
      reasons.push(`Matched escalation rule: ${ruleLabel(rule)}.`);
    }
  }

  confidence = roundConfidence(confidence);

  let decision: ActionConfidenceDecision;
  if (blockers.length > 0) {
    decision = "refuse";
  } else if (rules.some((rule) => rule.kind === "requires-escalation") || risk === "restricted") {
    decision = "escalate";
  } else if (contextReadiness === "none") {
    decision = "ask";
  } else if (rules.some((rule) => rule.kind === "ask-before") || risk === "irreversible") {
    decision = "ask";
  } else if (risk === "high") {
    decision = confidence >= 0.85 && contextReadiness === "sufficient" ? "draft" : "ask";
  } else if (risk === "medium") {
    if (confidence >= 0.85 && contextReadiness === "sufficient") {
      decision = "act";
    } else if (confidence >= 0.55) {
      decision = "draft";
    } else {
      decision = "ask";
    }
  } else {
    if (confidence >= 0.7 && contextReadiness === "sufficient") {
      decision = "act";
    } else if (confidence >= 0.45) {
      decision = "draft";
    } else {
      decision = "ask";
    }
  }

  if (decision === "act") {
    reasons.push("Confidence, context readiness, scope, and risk allow acting without another interruption.");
  } else if (decision === "draft") {
    reasons.push("Drafting preserves momentum while avoiding an externally visible action.");
  } else if (decision === "ask") {
    reasons.push("Asking is the lowest-cost way to resolve missing or risky context.");
  } else if (decision === "escalate") {
    reasons.push("The request is outside the normal action-confidence envelope.");
  } else {
    reasons.push("The action should not proceed with the supplied memory context.");
  }

  return {
    schemaVersion: 1,
    decision,
    confidence,
    risk,
    contextReadiness,
    ...(input.intendedAction ? { intendedAction: input.intendedAction } : {}),
    attentionPolicy: "interruption_budgeting",
    principle: ATTENTION_PRINCIPLE,
    reasons,
    blockers,
    factors,
    retrievedMemoryCount: memories.length,
    usableMemoryCount: usableMemories.length,
    staleMemoryCount,
    correctedMemoryCount,
    scopeMismatchCount,
    safeToAct: decision === "act",
  };
}

export function renderActionConfidenceText(result: ActionConfidenceResult): string {
  const lines = [
    `Action confidence: ${result.decision} (${result.confidence.toFixed(2)})`,
    `Risk: ${result.risk}`,
    `Context: ${result.contextReadiness}`,
    `Policy: interruption_budgeting - ${result.principle}`,
    `Memories: ${result.usableMemoryCount}/${result.retrievedMemoryCount} usable`,
  ];
  if (result.intendedAction) {
    lines.splice(1, 0, `Action: ${result.intendedAction}`);
  }
  if (result.blockers.length > 0) {
    lines.push("", "Blockers:");
    for (const blocker of result.blockers) lines.push(`- ${blocker}`);
  }
  if (result.reasons.length > 0) {
    lines.push("", "Reasons:");
    for (const reason of result.reasons) lines.push(`- ${reason}`);
  }
  return `${lines.join("\n")}\n`;
}
