import test from "node:test";
import assert from "node:assert/strict";
import {
  buildActionConfidenceInputFromOptions,
  evaluateActionConfidence,
  renderActionConfidenceText,
} from "./action-confidence.js";

test("evaluateActionConfidence acts for sufficient low-risk context", () => {
  const result = evaluateActionConfidence({
    intendedAction: "update local config",
    risk: "low",
    contextReadiness: "sufficient",
    retrievedMemories: [
      {
        source: "manual",
        created: "2026-05-01T00:00:00.000Z",
        scope: "namespace:repo",
        confidence: 0.92,
        safeToUse: true,
      },
    ],
  });

  assert.equal(result.decision, "act");
  assert.equal(result.safeToAct, true);
  assert.equal(result.usableMemoryCount, 1);
  assert.equal(result.attentionPolicy, "interruption_budgeting");
});

test("evaluateActionConfidence asks when an ask-before rule matches", () => {
  const result = evaluateActionConfidence({
    risk: "low",
    contextReadiness: "sufficient",
    confidence: 0.97,
    userRules: [
      {
        kind: "ask-before",
        description: "Ask me before changing a public API.",
      },
    ],
  });

  assert.equal(result.decision, "ask");
  assert.equal(result.safeToAct, false);
  assert.match(result.reasons.join("\n"), /Ask me before changing a public API/);
});

test("evaluateActionConfidence refuses blocked provenance", () => {
  const result = evaluateActionConfidence({
    risk: "low",
    contextReadiness: "sufficient",
    retrievedMemories: [
      {
        source: "conversation",
        created: "2026-05-01T00:00:00.000Z",
        confidence: 0.91,
        safety: "blocked",
        safeToUse: false,
        safetyReasons: ["do-not-use-outside-this-context"],
      },
    ],
  });

  assert.equal(result.decision, "refuse");
  assert.equal(result.blockers.length, 1);
  assert.equal(result.usableMemoryCount, 0);
});

test("evaluateActionConfidence excludes blocked memory from stale and corrected penalties", () => {
  const result = evaluateActionConfidence({
    risk: "low",
    contextReadiness: "sufficient",
    retrievedMemories: [
      {
        source: "conversation",
        confidence: 0.9,
        safeToUse: true,
      },
      {
        source: "conversation",
        confidence: 0.9,
        stale: true,
        corrected: true,
        safety: "blocked",
        safeToUse: false,
      },
    ],
  });

  assert.equal(result.decision, "refuse");
  assert.equal(result.confidence, 0.98);
  assert.equal(result.staleMemoryCount, 0);
  assert.equal(result.correctedMemoryCount, 0);
});

test("evaluateActionConfidence does not refuse for requires-review memory", () => {
  const result = evaluateActionConfidence({
    risk: "medium",
    contextReadiness: "partial",
    confidence: 0.7,
    retrievedMemories: [
      {
        source: "conversation",
        confidence: 0.9,
        safety: "requires-review",
        safeToUse: false,
      },
    ],
  });

  assert.equal(result.decision, "draft");
  assert.equal(result.blockers.length, 0);
  assert.equal(result.safeToAct, false);
  assert.equal(result.usableMemoryCount, 0);
});

test("evaluateActionConfidence drafts when memory is useful but stale or corrected", () => {
  const result = evaluateActionConfidence({
    risk: "medium",
    contextReadiness: "sufficient",
    retrievedMemories: [
      {
        source: "conversation",
        created: "2026-01-01T00:00:00.000Z",
        confidence: 0.88,
        stale: true,
        corrected: true,
        correctionState: "superseded",
        safeToUse: true,
      },
    ],
  });

  assert.equal(result.decision, "draft");
  assert.equal(result.staleMemoryCount, 1);
  assert.equal(result.correctedMemoryCount, 1);
  assert.equal(result.safeToAct, false);
});

test("evaluateActionConfidence escalates restricted risk", () => {
  const result = evaluateActionConfidence({
    risk: "restricted",
    contextReadiness: "sufficient",
    confidence: 0.99,
  });

  assert.equal(result.decision, "escalate");
  assert.equal(result.safeToAct, false);
});

test("evaluateActionConfidence rejects invalid confidence values", () => {
  assert.throws(
    () => evaluateActionConfidence({ confidence: 2 }),
    /confidence must be a finite number between 0 and 1/,
  );
  assert.throws(
    () => evaluateActionConfidence({
      retrievedMemories: [{ confidence: -0.1 }],
    }),
    /retrievedMemories\[\]\.confidence must be a finite number between 0 and 1/,
  );
});

test("renderActionConfidenceText includes interruption budgeting", () => {
  const text = renderActionConfidenceText(
    evaluateActionConfidence({
      risk: "low",
      contextReadiness: "partial",
      confidence: 0.62,
    }),
  );

  assert.match(text, /Action confidence: draft/);
  assert.match(text, /interruption_budgeting/);
  assert.match(text, /A good agent should spend the user's attention carefully/);
});

test("buildActionConfidenceInputFromOptions validates and builds CLI input", () => {
  const input = buildActionConfidenceInputFromOptions({
    action: "ship the change",
    confidence: "0.81",
    risk: "medium",
    context: "sufficient",
    rule: "ask-before",
    currentScope: "repo,tool",
    memoryScope: "repo",
    stale: true,
  });

  assert.deepEqual(input, {
    intendedAction: "ship the change",
    confidence: 0.81,
    risk: "medium",
    contextReadiness: "sufficient",
    currentContextScopes: ["repo", "tool"],
    userRules: [{ kind: "ask-before" }],
    retrievedMemories: [
      {
        confidence: 0.81,
        userContextScopes: ["repo"],
        stale: true,
      },
    ],
  });
});
