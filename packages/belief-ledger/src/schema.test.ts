import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { MemoryFile } from "@remnic/core";

import {
  computeBrierScore,
  claimFromMemory,
  claimTags,
  mergeClaimPatch,
  normalizeChallenge,
  normalizeClaimDraft,
  normalizePredictionGrade,
} from "./schema.js";

describe("belief ledger schema validation", () => {
  it("normalizes a valid claim draft", () => {
    const claim = normalizeClaimDraft(
      {
        statement: "Local-first memory tools will beat cloud-only tools.",
        kind: "prediction",
        stance: "for",
        confidence: 0.75,
        scope: {
          entities: ["Local-first memory", "Cloud memory"],
          domain: "ai memory",
        },
        deadline: "2027-01-01",
        evidenceLinks: ["https://example.test/source"],
      },
      { now: "2026-06-03T12:00:00Z" }
    );

    assert.equal(claim.kind, "prediction");
    assert.equal(claim.deadline, "2027-01-01T00:00:00.000Z");
    assert.deepEqual(claim.scope.entities, ["Local-first memory", "Cloud memory"]);
  });

  it("rejects invalid confidence instead of silently clamping", () => {
    assert.throws(
      () =>
        normalizeClaimDraft(
          {
            statement: "This should fail.",
            stance: "for",
            confidence: 1.2,
          },
          { now: "2026-06-03T12:00:00Z" }
        ),
      /confidence must be in \[0, 1\]/
    );
  });

  it("rejects invalid timestamps", () => {
    assert.throws(
      () =>
        normalizeClaimDraft(
          {
            statement: "This should fail.",
            stance: "for",
            confidence: 0.5,
            deadline: "not-a-date",
          },
          { now: "2026-06-03T12:00:00Z" }
        ),
      /deadline must be a valid ISO timestamp/
    );
  });

  it("rejects calendar-overflow timestamps", () => {
    assert.throws(
      () =>
        normalizeClaimDraft(
          {
            statement: "Impossible calendar dates should fail.",
            stance: "for",
            confidence: 0.5,
            deadline: "2026-04-31T00:00:00Z",
          },
          { now: "2026-06-03T12:00:00Z" }
        ),
      /deadline must be a valid ISO timestamp/
    );
    assert.throws(
      () =>
        normalizeClaimDraft(
          {
            statement: "Impossible date-only timestamps should fail.",
            stance: "for",
            confidence: 0.5,
            deadline: "2026-02-31",
          },
          { now: "2026-06-03T12:00:00Z" }
        ),
      /deadline must be a valid ISO timestamp/
    );
  });

  it("rejects date-time timestamps without an explicit offset", () => {
    assert.throws(
      () =>
        normalizeClaimDraft(
          {
            statement: "Local date-times should not depend on process timezone.",
            stance: "for",
            confidence: 0.5,
            deadline: "2026-06-01T09:00:00",
          },
          { now: "2026-06-03T12:00:00Z" }
        ),
      /deadline must be a valid ISO timestamp/
    );
  });

  it("computes Brier score from predicted and actual confidence", () => {
    assert.equal(computeBrierScore(0.75, 0), 0.5625);
    assert.equal(computeBrierScore(0.8, 1), 0.04);
  });

  it("normalizes resolution patches before persistence", () => {
    const claim = {
      ...normalizeClaimDraft(
        {
          statement: "The belief ledger test release will pass.",
          kind: "prediction",
          stance: "for",
          confidence: 0.75,
        },
        { now: "2026-06-03T12:00:00Z" }
      ),
      id: "claim-1",
      memoryId: "claim-1",
    };

    const updated = mergeClaimPatch(
      claim,
      {
        status: "resolved",
        resolution: {
          verdict: "mixed",
          actualConfidence: "0.25" as unknown as number,
          resolvedAt: "2026-06-04T12:00:00-05:00",
          source: "test source",
        },
      },
      "2026-06-04T12:00:00.000Z"
    );

    assert.equal(updated.resolution?.actualConfidence, 0.25);
    assert.equal(updated.resolution?.resolvedAt, "2026-06-04T17:00:00.000Z");
    assert.equal(updated.resolution?.brierScore, 0.25);
  });

  it("rejects invalid resolution patches before persistence", () => {
    const claim = {
      ...normalizeClaimDraft(
        {
          statement: "The belief ledger bad resolution patch should fail.",
          kind: "prediction",
          stance: "for",
          confidence: 0.75,
        },
        { now: "2026-06-03T12:00:00Z" }
      ),
      id: "claim-1",
      memoryId: "claim-1",
    };

    assert.throws(
      () =>
        mergeClaimPatch(
          claim,
          {
            resolution: {
              verdict: "true",
              actualConfidence: 2,
              resolvedAt: "2026-06-04T12:00:00.000Z",
            },
          },
          "2026-06-04T12:00:00.000Z"
        ),
      /actualConfidence must be in \[0, 1\]/
    );
    assert.throws(
      () =>
        mergeClaimPatch(
          claim,
          {
            resolution: {
              verdict: "false",
              actualConfidence: 0,
              resolvedAt: "2026-06-04T12:00:00",
            },
          },
          "2026-06-04T12:00:00.000Z"
        ),
      /resolvedAt must be a valid ISO timestamp/
    );
  });

  it("normalizes createdAt patches before persistence", () => {
    const claim = {
      ...normalizeClaimDraft(
        {
          statement: "The belief ledger createdAt patch should normalize.",
          kind: "claim",
          stance: "for",
          confidence: 0.75,
        },
        { now: "2026-06-03T12:00:00Z" }
      ),
      id: "claim-1",
      memoryId: "claim-1",
    };

    const updated = mergeClaimPatch(
      claim,
      { createdAt: "2026-06-03T07:00:00-05:00" },
      "2026-06-04T12:00:00.000Z"
    );

    assert.equal(updated.createdAt, "2026-06-03T12:00:00.000Z");
  });

  it("rejects invalid createdAt patches before persistence", () => {
    const claim = {
      ...normalizeClaimDraft(
        {
          statement: "The belief ledger bad createdAt patch should fail.",
          kind: "claim",
          stance: "for",
          confidence: 0.75,
        },
        { now: "2026-06-03T12:00:00Z" }
      ),
      id: "claim-1",
      memoryId: "claim-1",
    };

    assert.throws(
      () =>
        mergeClaimPatch(
          claim,
          { createdAt: "2026-06-03T12:00:00" },
          "2026-06-04T12:00:00.000Z"
        ),
      /createdAt must be a valid ISO timestamp/
    );
  });

  it("validates prediction grades from host LLMs", () => {
    const grade = normalizePredictionGrade({
      verdict: "mixed",
      actualConfidence: "0.25",
      rationale: "Partially happened.",
    });

    assert.equal(grade.verdict, "mixed");
    assert.equal(grade.actualConfidence, 0.25);
  });

  it("drops hallucinated challenge claim IDs from host LLMs", () => {
    const challenge = normalizeChallenge(
      {
        question: "Which version should stand?",
        priorClaimIds: ["claim-2", "hallucinated", "claim-3"],
        suggestedActions: ["supersede"],
      },
      ["claim-1", "claim-2"]
    );
    const fallback = normalizeChallenge(
      {
        question: "Which version should stand?",
        priorClaimIds: ["hallucinated"],
        suggestedActions: ["supersede"],
      },
      ["claim-1", "claim-2"]
    );

    assert.deepEqual(challenge.priorClaimIds, ["claim-2"]);
    assert.deepEqual(fallback.priorClaimIds, ["claim-1", "claim-2"]);
  });

  it("builds safe domain tags for hyphen-heavy domains", () => {
    const claim = normalizeClaimDraft(
      {
        statement: "Hyphen-only domains should not trigger slow regex paths.",
        stance: "neutral",
        confidence: 0.5,
        scope: {
          domain: "-----AI---Memory-----",
        },
      },
      { now: "2026-06-03T12:00:00Z" }
    );

    assert.ok(claimTags({ ...claim, id: "claim-1", memoryId: "claim-1" }).includes("belief-ledger:domain:ai-memory"));
  });

  it("falls back to Remnic valid_at for legacy claim timestamps", () => {
    const memory: MemoryFile = {
      path: "/tmp/claim.md",
      content: "# Belief Ledger Claim\n\nBackfilled belief.\n\nKind: claim\nStatus: active\n",
      frontmatter: {
        id: "claim-1",
        category: "fact",
        created: "2026-06-03T12:00:00.000Z",
        updated: "2026-06-04T12:00:00.000Z",
        source: "belief-ledger",
        confidence: 0.5,
        confidenceTier: "explicit",
        tags: ["belief-ledger"],
        valid_at: "2020-01-01T00:00:00.000Z",
        structuredAttributes: {
          "ledger.schemaVersion": "1",
          "ledger.kind": "claim",
          "ledger.stance": "neutral",
          "ledger.confidence": "0.5",
          "ledger.entities": "[]",
          "ledger.status": "active",
          "ledger.parentIds": "[]",
        },
      },
    };

    const claim = claimFromMemory(memory);

    assert.equal(claim?.createdAt, "2020-01-01T00:00:00.000Z");
    assert.equal(claim?.updatedAt, "2026-06-04T12:00:00.000Z");
  });

  it("rejects corrupt stored ledger array attributes instead of dropping them", () => {
    const baseMemory: MemoryFile = {
      path: "/tmp/claim.md",
      content: "# Belief Ledger Claim\n\nStored belief.\n\nKind: claim\nStatus: active\n",
      frontmatter: {
        id: "claim-1",
        category: "fact",
        created: "2026-06-03T12:00:00.000Z",
        updated: "2026-06-04T12:00:00.000Z",
        source: "belief-ledger",
        confidence: 0.5,
        confidenceTier: "explicit",
        tags: ["belief-ledger"],
        structuredAttributes: {
          "ledger.schemaVersion": "1",
          "ledger.kind": "claim",
          "ledger.stance": "neutral",
          "ledger.confidence": "0.5",
          "ledger.entities": "[]",
          "ledger.status": "active",
          "ledger.parentIds": "[]",
          "ledger.evidenceLinks": "[]",
        },
      },
    };

    for (const [field, value] of [
      ["ledger.entities", "null"],
      ["ledger.parentIds", '"claim-0"'],
      ["ledger.evidenceLinks", "[123]"],
    ] as const) {
      const memory: MemoryFile = {
        ...baseMemory,
        frontmatter: {
          ...baseMemory.frontmatter,
          id: `claim-${field}`,
          structuredAttributes: {
            ...baseMemory.frontmatter.structuredAttributes,
            [field]: value,
          },
        },
      };

      assert.throws(
        () => claimFromMemory(memory),
        (error) => error instanceof Error && error.message.includes(field) && error.message.includes("must")
      );
    }
  });

  it("does not read hidden Remnic memory statuses as ledger claims", () => {
    const baseMemory: MemoryFile = {
      path: "/tmp/claim.md",
      content: "# Belief Ledger Claim\n\nForgotten belief.\n\nKind: claim\nStatus: active\n",
      frontmatter: {
        id: "claim-1",
        category: "fact",
        created: "2026-06-03T12:00:00.000Z",
        updated: "2026-06-04T12:00:00.000Z",
        source: "belief-ledger",
        confidence: 0.5,
        confidenceTier: "explicit",
        tags: ["belief-ledger"],
        structuredAttributes: {
          "ledger.schemaVersion": "1",
          "ledger.kind": "claim",
          "ledger.stance": "neutral",
          "ledger.confidence": "0.5",
          "ledger.entities": "[]",
          "ledger.status": "active",
          "ledger.parentIds": "[]",
        },
      },
    };

    for (const status of ["forgotten", "pending_review", "quarantined", "rejected"] as const) {
      assert.equal(
        claimFromMemory({
          ...baseMemory,
          frontmatter: {
            ...baseMemory.frontmatter,
            status,
          },
        }),
        null
      );
    }
  });

  it("does not read Remnic-archived active claims but preserves ledger-owned archived statuses", () => {
    const baseMemory: MemoryFile = {
      path: "/tmp/claim.md",
      content: "# Belief Ledger Claim\n\nArchived belief.\n\nKind: claim\nStatus: active\n",
      frontmatter: {
        id: "claim-1",
        category: "fact",
        created: "2026-06-03T12:00:00.000Z",
        updated: "2026-06-04T12:00:00.000Z",
        source: "belief-ledger",
        confidence: 0.5,
        confidenceTier: "explicit",
        tags: ["belief-ledger"],
        status: "archived",
        structuredAttributes: {
          "ledger.schemaVersion": "1",
          "ledger.kind": "claim",
          "ledger.stance": "neutral",
          "ledger.confidence": "0.5",
          "ledger.entities": "[]",
          "ledger.status": "active",
          "ledger.parentIds": "[]",
        },
      },
    };

    assert.equal(claimFromMemory(baseMemory), null);

    for (const status of ["ignored", "resolved", "snoozed"] as const) {
      const claim = claimFromMemory({
        ...baseMemory,
        frontmatter: {
          ...baseMemory.frontmatter,
          structuredAttributes: {
            ...baseMemory.frontmatter.structuredAttributes,
            "ledger.status": status,
          },
        },
      });

      assert.equal(claim?.status, status);
    }
  });
});
