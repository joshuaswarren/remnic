import type { RelayMissionEventInput } from "./mission.js";

export const RELAY_DEMO_MISSION_ID = "checkout-token-recovery";
export const RELAY_DEMO_NAMESPACE = "relay-build-week";

const sourceEvidence = {
  kind: "source" as const,
  id: "source-checkout-contract",
  label: "Checkout token contract",
  locator: "fixture://checkout-service/src/token-policy.ts",
  capture: "fixture" as const,
};

const testEvidence = {
  kind: "test" as const,
  id: "test-checkout-contract",
  label: "Checkout integration contract",
  locator: "fixture://checkout-service/test/token-policy.test.ts",
  capture: "fixture" as const,
};

const approvalEvidence = {
  kind: "approval" as const,
  id: "approval-build-week-operator",
  label: "Human approval receipt",
  locator: "fixture://relay/approvals/correction-token-refresh.json",
  capture: "fixture" as const,
};

const correctionEvidence = {
  kind: "correction" as const,
  id: "correction-token-refresh",
  label: "Applied Remnic correction",
  locator: "fixture://remnic/corrections/correction-token-refresh.json",
  capture: "fixture" as const,
};

function at(second: number): string {
  return `2026-07-17T18:00:${String(second).padStart(2, "0")}.000Z`;
}

/**
 * Deterministic evidence stream shared by contract tests, replay, and the
 * judge-facing fixture mode. Every event has a stable idempotency key and
 * source reference so the resulting receipt is complete without fabricated
 * runtime evidence.
 */
export function createRelayMissionFixture(): RelayMissionEventInput[] {
  return [
    {
      occurredAt: at(0),
      idempotencyKey: "fixture-001",
      payload: {
        kind: "mission_started",
        title: "The checkout token split",
        objective: "Resolve a conflicting token refresh policy and prove a cold agent acts on it.",
        runMode: "fixture",
        evidence: [sourceEvidence],
      },
    },
    {
      occurredAt: at(2),
      idempotencyKey: "fixture-002",
      payload: {
        kind: "agent_status",
        agentId: "agent-atlas",
        sessionId: "session-atlas",
        label: "Atlas",
        role: "Checkout implementation",
        status: "working",
        evidence: [sourceEvidence],
      },
    },
    {
      occurredAt: at(3),
      idempotencyKey: "fixture-003",
      payload: {
        kind: "agent_status",
        agentId: "agent-nova",
        sessionId: "session-nova",
        label: "Nova",
        role: "Integration verification",
        status: "working",
        evidence: [testEvidence],
      },
    },
    {
      occurredAt: at(6),
      idempotencyKey: "fixture-004",
      payload: {
        kind: "agent_output",
        agentId: "agent-atlas",
        sessionId: "session-atlas",
        outputId: "output-atlas-policy",
        summary: "Implemented a new token for every checkout retry.",
        evidence: [
          {
            kind: "agent_output",
            id: "output-atlas-policy",
            label: "Atlas one-shot output",
            locator: "fixture://codex/atlas/final-output.txt",
            capture: "fixture",
          },
        ],
      },
    },
    {
      occurredAt: at(7),
      idempotencyKey: "fixture-005",
      payload: {
        kind: "belief_observed",
        agentId: "agent-atlas",
        sessionId: "session-atlas",
        beliefId: "belief-new-token-every-request",
        decisionId: "decision-new-token-every-request",
        statement: "Mint a new checkout token for every request and retry.",
        confidence: 0.91,
        evidence: [
          {
            kind: "memory",
            id: "memory-stale-token-policy",
            label: "Stale project decision",
            locator: "fixture://remnic/memories/memory-stale-token-policy.md",
            capture: "fixture",
          },
        ],
      },
    },
    {
      occurredAt: at(9),
      idempotencyKey: "fixture-006",
      payload: {
        kind: "agent_output",
        agentId: "agent-nova",
        sessionId: "session-nova",
        outputId: "output-nova-policy",
        summary: "The contract requires one token per checkout session, refreshed only after expiry.",
        evidence: [
          {
            kind: "agent_output",
            id: "output-nova-policy",
            label: "Nova one-shot output",
            locator: "fixture://codex/nova/final-output.txt",
            capture: "fixture",
          },
          sourceEvidence,
        ],
      },
    },
    {
      occurredAt: at(10),
      idempotencyKey: "fixture-007",
      payload: {
        kind: "belief_observed",
        agentId: "agent-nova",
        sessionId: "session-nova",
        beliefId: "belief-refresh-after-expiry",
        decisionId: "decision-refresh-after-expiry",
        statement: "Reuse the checkout-session token and refresh it only after expiry.",
        confidence: 0.98,
        evidence: [sourceEvidence],
      },
    },
    {
      occurredAt: at(12),
      idempotencyKey: "fixture-008",
      payload: {
        kind: "conflict_detected",
        conflictId: "conflict-token-lifecycle",
        decisionIds: ["decision-refresh-after-expiry", "decision-new-token-every-request"],
        agentIds: ["agent-nova", "agent-atlas"],
        summary: "The agents disagree on whether retries reuse or rotate the checkout token.",
        evidence: [sourceEvidence, testEvidence],
      },
    },
    {
      occurredAt: at(14),
      idempotencyKey: "fixture-009",
      payload: {
        kind: "test_result",
        testId: "test-before-correction",
        decisionId: "decision-new-token-every-request",
        command: "npm test -- token-policy.test.ts",
        status: "failed",
        summary: "Retry minted a second token instead of reusing the session token.",
        durationMs: 418,
        evidence: [testEvidence],
      },
    },
    {
      occurredAt: at(18),
      idempotencyKey: "fixture-010",
      payload: {
        kind: "correction_proposed",
        correctionId: "correction-token-refresh",
        conflictId: "conflict-token-lifecycle",
        proposedDecisionId: "decision-refresh-after-expiry",
        supersedesDecisionIds: ["decision-new-token-every-request"],
        statement: "Reuse the checkout-session token and refresh it only after expiry.",
        rationale: "The implementation contract and failing integration test agree on session reuse.",
        proposedBy: "agent-resolver",
        evidence: [sourceEvidence, testEvidence],
      },
    },
    {
      occurredAt: at(21),
      idempotencyKey: "fixture-011",
      payload: {
        kind: "correction_approved",
        correctionId: "correction-token-refresh",
        approvedBy: {
          kind: "human",
          id: "operator-build-week",
          label: "Build Week operator",
        },
        note: "Approve the source-grounded policy and retire the stale decision.",
        evidence: [approvalEvidence],
      },
    },
    {
      occurredAt: at(23),
      idempotencyKey: "fixture-012",
      payload: {
        kind: "decision_superseded",
        decisionId: "decision-new-token-every-request",
        replacementDecisionId: "decision-refresh-after-expiry",
        correctionId: "correction-token-refresh",
        evidence: [correctionEvidence],
      },
    },
    {
      occurredAt: at(27),
      idempotencyKey: "fixture-013",
      payload: {
        kind: "recall_observed",
        agentId: "agent-orbit",
        sessionId: "session-orbit-cold",
        recallReceiptId: "recall-orbit-cold",
        decisionId: "decision-refresh-after-expiry",
        query: "What token lifecycle must checkout retries follow?",
        capturedAtAction: true,
        evidence: [
          {
            kind: "recall_audit",
            id: "recall-orbit-cold",
            label: "Cold-start recall audit",
            locator: "fixture://remnic/recall-audit/recall-orbit-cold.json",
            capture: "fixture",
          },
        ],
      },
    },
    {
      occurredAt: at(29),
      idempotencyKey: "fixture-014",
      payload: {
        kind: "propagation_verified",
        agentId: "agent-orbit",
        sessionId: "session-orbit-cold",
        correctionId: "correction-token-refresh",
        decisionId: "decision-refresh-after-expiry",
        recallReceiptId: "recall-orbit-cold",
        staleDecisionAbsent: true,
        evidence: [
          {
            kind: "recall_audit",
            id: "recall-orbit-cold",
            label: "Cold-start recall audit",
            locator: "fixture://remnic/recall-audit/recall-orbit-cold.json",
            capture: "fixture",
          },
        ],
      },
    },
    {
      occurredAt: at(34),
      idempotencyKey: "fixture-015",
      payload: {
        kind: "test_result",
        testId: "test-after-correction",
        decisionId: "decision-refresh-after-expiry",
        correctionId: "correction-token-refresh",
        command: "npm test -- token-policy.test.ts",
        status: "passed",
        summary: "The cold agent reused the session token and the integration contract passed.",
        durationMs: 391,
        evidence: [testEvidence, correctionEvidence],
      },
    },
    {
      occurredAt: at(36),
      idempotencyKey: "fixture-016",
      payload: {
        kind: "mission_completed",
        outcome: "recovered",
        summary: "One approved correction reached a cold agent and changed the observable outcome.",
        evidence: [testEvidence, approvalEvidence],
      },
    },
  ];
}
