
import {
  PERSONAS,
  SUBJECTS,
  VALUES_A,
  VALUES_B,
} from "./token-pools.js";
import type {
  CorrectionShape,
  FactCategory,
  MemCorrectCorpus,
  MemCorrectScenario,
  ProbePhase,
} from "./types.js";

const ALLOWED_CATEGORIES: readonly FactCategory[] = [
  "fact",
  "preference",
  "decision",
  "commitment",
  "relationship",
];

const ALLOWED_SHAPES: readonly CorrectionShape[] = [
  "explicit-targeted",
  "conversational",
  "scoped",
  "re-assertion",
];

const ALLOWED_PHASES: readonly ProbePhase[] = [
  "baseline",
  "post_correction",
  "post_maintenance",
  "post_reingest",
  "post_reassertion",
];

export interface CorpusValidationError {
  scenarioId: string;
  message: string;
}

export interface CorpusValidationResult {
  ok: boolean;
  errors: CorpusValidationError[];
}

const ALL_TOKENS: ReadonlySet<string> = new Set<string>([
  ...PERSONAS.map((p) => p.toLowerCase()),
  ...SUBJECTS,
  ...VALUES_A,
  ...VALUES_B,
  "correction",
  "update",
  "actually",
  "preference",
  "setting",
  "for",
  "this",
  "project",
  "my",
  "is",
  "now",
  "not",
  "wrong",
  "it",
  "we",
  "switched",
  "from",
  "to",
  "last",
  "month",
  "going",
  "forward",
  "instead",
  "of",
  "the",
  "record",
  "saying",
  "oh",
  "by",
  "way",
  "mentioned",
  "their",
  "set",
  "if",
  "someone",
  "asked",
  "i",
  "might",
  "consider",
  "but",
  "have",
  "decided",
  "said",
  "you",
  "should",
  "change",
  "them",
  "noting",
  "noted",
  "got",
  "it",
  "we",
  "went",
  "back",
  "riley",
  "sage",
  "what",
]);

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((v): v is string => typeof v === "string")
  );
}

function isIso(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

function validateScenario(scenario: MemCorrectScenario): CorpusValidationError[] {
  const errors: CorpusValidationError[] = [];
  const id = scenario.id;

  if (scenario.id.length === 0) {
    errors.push({ scenarioId: id, message: "id must be a non-empty string" });
  }
  if (scenario.namespace.length === 0) {
    errors.push({ scenarioId: id, message: "namespace must be a non-empty string" });
  }
  if (!ALLOWED_CATEGORIES.includes(scenario.category)) {
    errors.push({
      scenarioId: id,
      message: `category must be one of ${ALLOWED_CATEGORIES.join(", ")}`,
    });
  }
  if (scenario.establishingTurns.length === 0) {
    errors.push({
      scenarioId: id,
      message: "establishingTurns must be a non-empty array",
    });
  } else {
    for (const [index, turn] of scenario.establishingTurns.entries()) {
      if (turn.role !== "user" && turn.role !== "assistant") {
        errors.push({
          scenarioId: id,
          message: `establishing turn ${index} role invalid`,
        });
      }
      if (turn.text.length === 0) {
        errors.push({
          scenarioId: id,
          message: `establishing turn ${index} text empty`,
        });
      }
      if (!isIso(turn.at)) {
        errors.push({
          scenarioId: id,
          message: `establishing turn ${index} at not ISO`,
        });
      }
    }
  }
  if (!ALLOWED_SHAPES.includes(scenario.correction.shape)) {
    errors.push({
      scenarioId: id,
      message: `correction.shape must be one of ${ALLOWED_SHAPES.join(", ")}`,
    });
  }
  if (!isStringArray(scenario.correction.retiredContent)) {
    errors.push({ scenarioId: id, message: "retiredContent must be string[]" });
  }
  if (!isStringArray(scenario.correction.correctedContent)) {
    errors.push({ scenarioId: id, message: "correctedContent must be string[]" });
  }
  if (
    scenario.correction.shape === "scoped" &&
    (!scenario.scopedTwin || scenario.scopedTwin.twinContent.length === 0)
  ) {
    errors.push({
      scenarioId: id,
      message: "scoped correction must carry a scopedTwin with non-empty twinContent",
    });
  }
  if (
    scenario.correction.shape === "re-assertion" &&
    (!scenario.reassertion || scenario.reassertion.expectedContent.length === 0)
  ) {
    errors.push({
      scenarioId: id,
      message: "re-assertion correction must carry a reassertion block with expectedContent",
    });
  }
  if (scenario.probe.query.length === 0) {
    errors.push({ scenarioId: id, message: "probe.query empty" });
  }
  if (!isStringArray(scenario.probe.mustContain)) {
    errors.push({ scenarioId: id, message: "probe.mustContain must be string[]" });
  }
  if (!isStringArray(scenario.probe.mustAbsent)) {
    errors.push({ scenarioId: id, message: "probe.mustAbsent must be string[]" });
  }
  if (!Array.isArray(scenario.antiEvents)) {
    errors.push({ scenarioId: id, message: "antiEvents must be an array" });
  }
  if (!Array.isArray(scenario.unrelatedProbes)) {
    errors.push({ scenarioId: id, message: "unrelatedProbes must be an array" });
  }
  return errors;
}

/**
 * Validate the whole corpus and assert the synthetic-token provenance of
 * every fact token (the no-PII-by-construction guarantee).
 */
export function validateCorpus(corpus: MemCorrectCorpus): CorpusValidationResult {
  const errors: CorpusValidationError[] = [];
  if (!Array.isArray(corpus.scenarios)) {
    return {
      ok: false,
      errors: [{ scenarioId: "<root>", message: "scenarios must be an array" }],
    };
  }
  const seenIds = new Set<string>();
  for (const scenario of corpus.scenarios) {
    if (seenIds.has(scenario.id)) {
      errors.push({ scenarioId: scenario.id, message: "duplicate scenario id" });
    }
    seenIds.add(scenario.id);
    errors.push(...validateScenario(scenario));
    const factTokens = [
      ...(scenario.correction?.retiredContent ?? []),
      ...(scenario.correction?.correctedContent ?? []),
      ...(scenario.scopedTwin ? [scenario.scopedTwin.twinContent] : []),
      ...(scenario.reassertion ? [scenario.reassertion.expectedContent] : []),
    ];
    for (const token of factTokens) {
      if (!ALL_TOKENS.has(token.toLowerCase())) {
        errors.push({
          scenarioId: scenario.id,
          message: `fact token "${token}" is outside the synthetic pools (PII guard)`,
        });
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export const MEMCORRECT_PROBE_PHASES = ALLOWED_PHASES;
