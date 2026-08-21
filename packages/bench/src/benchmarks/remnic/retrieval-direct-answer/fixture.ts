/**
 * Synthetic fixture for the direct-answer latency benchmark
 * (issue #518).
 *
 * Each case feeds a hand-crafted candidate set + a query into the
 * eligibility gate.  Cases are split by expected verdict so the
 * scorer can measure precision (positive cases fire Tier 2), recall
 * (negative cases defer to the hybrid path), and gate latency.
 */

import type { MemoryFile } from "@remnic/core";

export interface DirectAnswerCaseCandidate {
  id: string;
  content: string;
  tags: string[];
  category: "decision" | "principle" | "skill" | "rule" | "fact" | "entity";
  trustZone: "trusted" | "working" | "quarantine" | null;
  importanceScore: number;
  verificationState?: "unverified" | "user_confirmed" | "system_inferred" | "disputed";
  status?: "active" | "superseded" | "archived" | "pending_review" | "rejected" | "quarantined";
  entityRef?: string;
  taxonomyBucket?: string;
}

export interface DirectAnswerBenchCase {
  id: string;
  query: string;
  candidates: DirectAnswerCaseCandidate[];
  queryEntityRefs?: string[];
  expected: "eligible" | "defer";
  /** Memory id we expect to win when expected==="eligible". */
  expectedWinnerId?: string;
}

function trustedDecision(overrides: Partial<DirectAnswerCaseCandidate> & Pick<DirectAnswerCaseCandidate, "id" | "content" | "tags">): DirectAnswerCaseCandidate {
  return {
    category: "decision",
    trustZone: "trusted",
    importanceScore: 0.85,
    verificationState: "user_confirmed",
    taxonomyBucket: "decisions",
    ...overrides,
  };
}

function untrustedNote(overrides: Partial<DirectAnswerCaseCandidate> & Pick<DirectAnswerCaseCandidate, "id" | "content" | "tags">): DirectAnswerCaseCandidate {
  return {
    category: "fact",
    trustZone: "working",
    importanceScore: 0.4,
    taxonomyBucket: "facts",
    ...overrides,
  };
}

export const DIRECT_ANSWER_BENCH_FIXTURE: DirectAnswerBenchCase[] = [
  // Positive: a single trusted decision memory answers the query cleanly.
  {
    id: "pos-pkg-manager",
    query: "package manager remnic",
    candidates: [
      trustedDecision({
        id: "pm",
        content: "remnic uses pnpm as its package manager",
        tags: ["package-manager", "remnic"],
        entityRef: "remnic",
      }),
    ],
    expected: "eligible",
    expectedWinnerId: "pm",
  },
  // Positive: winner beats a noisy working-zone distractor.
  {
    id: "pos-beats-distractor",
    query: "package manager remnic",
    candidates: [
      trustedDecision({
        id: "pm",
        content: "remnic uses pnpm as its package manager",
        tags: ["package-manager", "remnic"],
      }),
      untrustedNote({
        id: "noise",
        content: "package manager remnic npm",
        tags: ["package-manager"],
      }),
    ],
    expected: "eligible",
    expectedWinnerId: "pm",
  },
  // Negative: two trusted candidates within ambiguity margin → defer.
  {
    id: "neg-ambiguous",
    query: "package manager remnic",
    candidates: [
      trustedDecision({
        id: "a",
        content: "remnic uses pnpm as its package manager",
        tags: ["package-manager", "remnic"],
      }),
      trustedDecision({
        id: "b",
        content: "remnic switched to pnpm for package manager",
        tags: ["package-manager", "remnic"],
      }),
    ],
    expected: "defer",
  },
  // Negative: the memory is in working zone, must defer.
  {
    id: "neg-not-trusted",
    query: "package manager remnic",
    candidates: [
      untrustedNote({
        id: "working",
        content: "remnic uses pnpm",
        tags: ["package-manager", "remnic"],
      }),
    ],
    expected: "defer",
  },
  // Negative: low-importance unverified memory in eligible bucket, must defer.
  {
    id: "neg-below-importance",
    query: "package manager remnic",
    candidates: [
      {
        id: "weak",
        content: "remnic uses pnpm",
        tags: ["package-manager", "remnic"],
        category: "decision",
        trustZone: "trusted",
        importanceScore: 0.2,
        taxonomyBucket: "decisions",
      },
    ],
    expected: "defer",
  },
  // Negative: eligible memory but token overlap too low to trust.
  {
    id: "neg-low-overlap",
    query: "package manager remnic",
    candidates: [
      trustedDecision({
        id: "off-topic",
        content: "remnic is an agentic memory substrate",
        tags: ["overview"],
      }),
    ],
    expected: "defer",
  },
  // Positive: entity hint routes correctly.
  {
    id: "pos-entity-hint",
    query: "package manager",
    candidates: [
      trustedDecision({
        id: "remnic-pm",
        content: "remnic uses pnpm for package management",
        tags: ["package-manager"],
        entityRef: "remnic",
      }),
      trustedDecision({
        id: "weclone-pm",
        content: "weclone uses npm for package management",
        tags: ["package-manager"],
        entityRef: "weclone",
      }),
    ],
    queryEntityRefs: ["remnic"],
    expected: "eligible",
    expectedWinnerId: "remnic-pm",
  },
  // Negative: superseded memory cannot answer.
  {
    id: "neg-superseded",
    query: "package manager remnic",
    candidates: [
      {
        ...trustedDecision({
          id: "old",
          content: "remnic uses npm",
          tags: ["package-manager", "remnic"],
        }),
        status: "superseded",
      },
    ],
    expected: "defer",
  },
  // Negative: taxonomy bucket not eligible (correction).
  {
    id: "neg-bucket",
    query: "package manager remnic",
    candidates: [
      {
        id: "correction",
        content: "remnic uses pnpm",
        tags: ["package-manager", "remnic"],
        category: "fact",
        trustZone: "trusted",
        importanceScore: 0.9,
        taxonomyBucket: "corrections",
      },
    ],
    expected: "defer",
  },
  // Positive: runbook bucket is eligible.
  {
    id: "pos-runbook",
    query: "ship the branch",
    candidates: [
      {
        id: "ship",
        content: "run tests, rebase, then gh pr merge --squash",
        tags: ["ship", "runbook"],
        category: "skill",
        trustZone: "trusted",
        importanceScore: 0.85,
        verificationState: "user_confirmed",
        taxonomyBucket: "runbooks",
      },
    ],
    expected: "eligible",
    expectedWinnerId: "ship",
  },
];

export function memoryFileFromCase(candidate: DirectAnswerCaseCandidate): MemoryFile {
  return {
    path: `/memory/${candidate.id}.md`,
    frontmatter: {
      id: candidate.id,
      category: candidate.category,
      created: "2026-04-19T00:00:00.000Z",
      updated: "2026-04-19T00:00:00.000Z",
      source: "bench",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: candidate.tags,
      entityRef: candidate.entityRef,
      status: candidate.status,
      verificationState: candidate.verificationState,
    },
    content: candidate.content,
  };
}
