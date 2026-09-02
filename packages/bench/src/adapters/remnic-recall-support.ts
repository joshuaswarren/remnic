import { renderAuthorityFence, screenCandidateFact } from "@remnic/core";
import type { BenchRecallSupportAssessment, BenchRecallSupportRequest } from "./types.js";

export const DEFAULT_ANSWER_SUPPORT_MIN_COVERAGE = 0.34;

const ANSWER_SUPPORT_STOP_WORDS = new Set([
  "about", "after", "again", "also", "answer", "before", "being", "could",
  "does", "from", "have", "information", "into", "just", "know", "memory",
  "might", "please", "question", "recall", "remember", "should", "that", "their",
  "there", "these", "they", "this", "those", "user", "using", "what", "when",
  "where", "which", "while", "with", "would", "your",
]);

export function resolveAnswerSupportMinCoverage(config: Record<string, unknown> | undefined): number {
  const raw = config?.answerSupportMinCoverage;
  if (raw === undefined) return DEFAULT_ANSWER_SUPPORT_MIN_COVERAGE;
  if (typeof raw !== "number" && typeof raw !== "string") {
    throw new Error("answerSupportMinCoverage must be a finite number greater than 0 and at most 1.");
  }
  const parsed = typeof raw === "number" ? raw : Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error("answerSupportMinCoverage must be a finite number greater than 0 and at most 1.");
  }
  return parsed;
}

export function resolveSkipExtractionLcmFirst(config: Record<string, unknown> | undefined): boolean {
  const raw = config?.skipExtractionLcmFirst;
  if (raw === undefined) return true;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  throw new Error(
    "skipExtractionLcmFirst must be a boolean or one of true/false, 1/0, yes/no, on/off.",
  );
}

export function shouldIncludeCoreRecallForReplay(options: {
  useCoreMemoryPipeline: boolean;
  replayExtractionMode: "await" | "background" | "skip";
  skipExtractionLcmFirst: boolean;
}): boolean {
  return options.useCoreMemoryPipeline &&
    (options.replayExtractionMode !== "skip" || !options.skipExtractionLcmFirst);
}

/**
 * Recall section ids the harness authors as responder guidance (they are
 * instruction-shaped by design and may quote short evidence snippets the
 * harness already selected). They are trusted like core memory: never
 * screened, never fenced. Every other section quotes raw conversation or
 * derived content and goes through the configured defenses. The security
 * suite's rows recall only core sections, so this list does not touch them.
 */
export const HARNESS_AUTHORED_RECALL_SECTIONS: ReadonlySet<string> = new Set([
  "core",
  "contradiction-guidance",
  "dependency-version",
  "implementation-targets",
  "historical-empty",
  "personal-history-empty",
]);

export function secureBenchRecallSection(
  content: string,
  security: { originAuthorityEnabled: boolean; injectionScreenEnabled: boolean },
  trustedSection: boolean,
): string {
  if (trustedSection) return content;
  if (security.injectionScreenEnabled && screenCandidateFact(content, "hardened").quarantine) return "";
  return security.originAuthorityEnabled ? renderAuthorityFence(content, "unknown") : content;
}

function normalizeSupportToken(value: string): string {
  if (value.length > 5 && value.endsWith("ing")) return value.slice(0, -3);
  if (value.length > 4 && value.endsWith("ed")) {
    const base = value.slice(0, -2);
    return /[vs]$/.test(base) ? `${base}e` : base;
  }
  if (value.length > 4 && value.endsWith("es")) return value.slice(0, -2);
  if (value.length > 3 && value.endsWith("s")) return value.slice(0, -1);
  return value;
}

function supportTerms(value: string): string[] {
  return [...new Set(
    (value.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu) ?? [])
      .filter((term) => !ANSWER_SUPPORT_STOP_WORDS.has(term))
      .map(normalizeSupportToken)
      .filter((term) => !ANSWER_SUPPORT_STOP_WORDS.has(term) && !/^\d+$/.test(term)),
  )];
}

function exactContextEvidenceLines(recalledText: string): string[] {
  return recalledText.split(/\r?\n/).map((line) => line.trim()).filter((line) => {
    if (!line || /^#{1,6}\s/.test(line)) return false;
    return !/^(?:answer guidance:|distinct user-stated targets found:|no (?:direct|historically valid)|these direct temporal statements|this is the most recent|use this list|when answering)/i.test(line);
  });
}

/**
 * Classify support from the exact final context supplied to the responder.
 * This intentionally avoids auxiliary zero-hit searches: a different recall
 * tier may have contributed strong verbatim evidence to this context.
 */
export function assessRemnicRecallSupport(
  request: BenchRecallSupportRequest,
  supportThreshold = DEFAULT_ANSWER_SUPPORT_MIN_COVERAGE,
): BenchRecallSupportAssessment {
  if (request.recalledText.trim().length === 0) {
    return {
      status: "empty",
      reason: "exact responder context is empty",
      evidenceCount: 0,
      maxScore: 0,
      supportThreshold,
    };
  }
  const queryTerms = supportTerms(request.query);
  if (queryTerms.length < 2) {
    return {
      status: "unavailable",
      reason: "query has fewer than two distinctive terms for conservative support scoring",
    };
  }
  const evidenceLines = exactContextEvidenceLines(request.recalledText);
  const evidenceTermSets = evidenceLines.map((line) => new Set(supportTerms(line)));
  const matchedTerms = queryTerms.filter((term) =>
    evidenceTermSets.some((terms) => terms.has(term)),
  );
  const evidenceCount = evidenceTermSets.filter((terms) =>
    matchedTerms.some((term) => terms.has(term)),
  ).length;
  const coverage = matchedTerms.length / queryTerms.length;
  if (evidenceCount === 0) {
    return {
      status: "empty",
      reason: "exact responder context contains no matching evidence terms",
      evidenceCount: 0,
      maxScore: 0,
      supportThreshold,
    };
  }
  if (coverage < supportThreshold) {
    return {
      status: "weak",
      reason: "exact responder context has only weak lexical support",
      evidenceCount,
      maxScore: coverage,
      supportThreshold,
    };
  }
  return {
    status: "supported",
    reason: "exact responder context has sufficient lexical support",
    evidenceCount,
    maxScore: coverage,
    supportThreshold,
  };
}
