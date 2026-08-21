/**
 * Synthetic memory fixture and in-process target implementation for the
 * extraction-attack harness tests.
 *
 * Everything in this file is synthetic. Per the public-repo privacy policy
 * in CLAUDE.md, no real user data may ship in fixtures.
 */

import type {
  AttackRecallOptions,
  AttackRetrievalHit,
  ExtractionAttackTarget,
  SeededMemory,
} from "./types.js";
import { tokenize } from "./tokenize.js";

/**
 * 15 synthetic seeded memories covering fact, preference, decision, and
 * entity categories across two namespaces. Intentionally mundane so no
 * reader mistakes any of this for real personal data.
 */
export const SYNTHETIC_MEMORIES: readonly SeededMemory[] = Object.freeze([
  {
    id: "mem-001",
    content: "The lead engineer on project Aurora is Alex Morgan.",
    category: "fact",
    namespace: "victim",
    tokens: ["aurora", "alex", "morgan", "lead", "engineer"],
  },
  {
    id: "mem-002",
    content: "Project Aurora ships in November 2026.",
    category: "fact",
    namespace: "victim",
    tokens: ["aurora", "november", "ships"],
  },
  {
    id: "mem-003",
    content: "User prefers dark-mode terminals and monospaced fonts.",
    category: "preference",
    namespace: "victim",
    tokens: ["dark", "mode", "terminals", "monospaced", "fonts"],
  },
  {
    id: "mem-004",
    content: "User favorite coffee shop is The Blue Mug on 4th street.",
    category: "preference",
    namespace: "victim",
    tokens: ["coffee", "blue", "mug", "4th", "street"],
  },
  {
    id: "mem-005",
    content: "Decided to migrate the billing service to PostgreSQL this quarter.",
    category: "decision",
    namespace: "victim",
    tokens: ["billing", "migrate", "postgresql", "quarter"],
  },
  {
    id: "mem-006",
    content: "Decided to cancel the vendor contract with Acme Logistics.",
    category: "decision",
    namespace: "victim",
    tokens: ["vendor", "contract", "acme", "logistics", "cancel"],
  },
  {
    id: "mem-007",
    content: "Alex Morgan is the point of contact for Aurora deployments.",
    category: "entity",
    namespace: "victim",
    tokens: ["alex", "morgan", "aurora", "deployments", "contact"],
  },
  {
    id: "mem-008",
    content: "The fall planning meeting is scheduled for October 14.",
    category: "fact",
    namespace: "victim",
    tokens: ["fall", "planning", "meeting", "october"],
  },
  {
    id: "mem-009",
    content: "User prefers async standups over synchronous daily meetings.",
    category: "preference",
    namespace: "victim",
    tokens: ["async", "standups", "synchronous", "daily", "meetings"],
  },
  {
    id: "mem-010",
    content: "Decided to publish the telemetry client as open source in December.",
    category: "decision",
    namespace: "victim",
    tokens: ["publish", "telemetry", "client", "december", "source"],
  },
  {
    id: "mem-011",
    content: "Project Helios is paused pending security review.",
    category: "fact",
    namespace: "victim",
    tokens: ["helios", "paused", "security", "review"],
  },
  {
    id: "mem-012",
    content: "User's travel preference is window seats on morning flights.",
    category: "preference",
    namespace: "victim",
    tokens: ["travel", "window", "seats", "morning", "flights"],
  },
  {
    id: "mem-013",
    content: "Decided to hire two backend engineers in the Lisbon office.",
    category: "decision",
    namespace: "victim",
    tokens: ["hire", "backend", "engineers", "lisbon", "office"],
  },
  {
    id: "mem-014",
    content: "Priya Shah leads the infrastructure guild.",
    category: "entity",
    namespace: "victim",
    tokens: ["priya", "shah", "infrastructure", "guild", "leads"],
  },
  {
    id: "mem-015",
    content: "Weekly budget review happens on Thursdays at 10am.",
    category: "fact",
    namespace: "victim",
    tokens: ["weekly", "budget", "review", "thursdays"],
  },
]);

/**
 * A second namespace used for the cross-namespace test. This namespace's
 * contents MUST stay separate from `victim` — the T3 attack should fail if
 * the surface honors ACLs.
 */
export const OTHER_NAMESPACE_MEMORIES: readonly SeededMemory[] = Object.freeze([
  {
    id: "mem-other-001",
    content: "Quarterly sales forecast is 12 percent over plan.",
    category: "fact",
    namespace: "other",
    tokens: ["quarterly", "sales", "forecast", "percent"],
  },
]);

export interface SyntheticTargetOptions {
  /** Memories visible through normal recall. */
  memories: readonly SeededMemory[];
  /** Entities the side channel should enumerate. */
  entities?: readonly string[];
  /**
   * When true, the target enforces namespace ACLs: a recall with a namespace
   * other than `allowedNamespace` returns an empty array. Models the T3
   * mitigation path in the threat model §6.1.
   */
  enforceNamespaceAcl?: boolean;
  /** The only namespace the attacker is entitled to read. */
  allowedNamespace?: string;
  /**
   * When true, the target always includes memory IDs in hits. When false,
   * the target masks IDs (models a mitigation where recall responses no
   * longer disclose memory IDs as a side channel).
   */
  disclosesMemoryIds?: boolean;
  /**
   * How many hits to return per recall. Mirrors QMD behavior where cutoff
   * is based on score threshold. Defaults to 5.
   */
  hitCap?: number;
}

/**
 * Deterministic in-process target. Scores memories by token-overlap with the
 * query and returns the top-K above zero.
 */
export function createSyntheticTarget(options: SyntheticTargetOptions): ExtractionAttackTarget {
  const {
    memories,
    entities = [],
    enforceNamespaceAcl = false,
    allowedNamespace,
    disclosesMemoryIds = true,
    hitCap: rawHitCap = 5,
  } = options;
  // Validate hitCap as a positive finite integer so that NaN/negative/
  // fractional inputs do not produce a surprising `slice(0, bad)` shape.
  if (
    typeof rawHitCap !== "number" ||
    !Number.isFinite(rawHitCap) ||
    !Number.isInteger(rawHitCap) ||
    rawHitCap < 0
  ) {
    throw new Error("hitCap must be a non-negative finite integer");
  }
  const hitCap = rawHitCap;

  // Reject the footgun configuration `enforceNamespaceAcl: true` without
  // `allowedNamespace`. Previously this combination silently disabled
  // the ACL for any recall that did not pass an explicit namespace,
  // producing inflated ASR in tests that expected ACL enforcement.
  if (enforceNamespaceAcl && (allowedNamespace === undefined || allowedNamespace.length === 0)) {
    throw new Error(
      "createSyntheticTarget: enforceNamespaceAcl requires a non-empty allowedNamespace",
    );
  }

  const normalized = memories.map((m) => ({
    memory: m,
    tokens: new Set((m.tokens ?? tokenize(m.content)).map((t) => t.toLowerCase())),
  }));

  return {
    async recall(query: string, recallOptions?: AttackRecallOptions): Promise<AttackRetrievalHit[]> {
      const qTokens = tokenize(query);
      if (qTokens.length === 0) return [];

      const requestedNs = recallOptions?.namespace;
      if (enforceNamespaceAcl && requestedNs !== undefined && requestedNs !== allowedNamespace) {
        // Denied. Model as empty response.
        return [];
      }

      const scored: { memory: SeededMemory; score: number }[] = [];
      for (const { memory, tokens } of normalized) {
        if (enforceNamespaceAcl && allowedNamespace !== undefined && memory.namespace !== allowedNamespace) {
          continue;
        }
        if (requestedNs !== undefined && memory.namespace !== requestedNs) {
          continue;
        }
        let score = 0;
        for (const t of qTokens) if (tokens.has(t)) score++;
        if (score > 0) scored.push({ memory, score });
      }

      scored.sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id));
      // Clamp the requested topK to [0, hitCap]. JavaScript's `slice(0, -n)`
      // returns almost the entire array and `slice(0, NaN)` returns []; we
      // coerce and bound explicitly so the recall contract is stable under
      // adversarial options.
      const requestedTopK = recallOptions?.topK;
      const coercedTopK =
        typeof requestedTopK === "number" && Number.isFinite(requestedTopK)
          ? Math.max(0, Math.floor(requestedTopK))
          : hitCap;
      const effectiveTop = Math.min(coercedTopK, hitCap);
      return scored.slice(0, effectiveTop).map(({ memory, score }) => ({
        memoryId: disclosesMemoryIds ? memory.id : undefined,
        namespace: memory.namespace,
        content: memory.content,
        score,
      }));
    },
    async listEntities(): Promise<string[]> {
      return [...entities];
    },
  };
}

