import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeTrustScore,
  decideSmart,
  findCorroboration,
  tokenizeDayBody,
  TRUST_CROSS_SOURCE_BOOST,
  TRUST_JUDGE_ACCEPT_BOOST,
  TRUST_SUPPORTING_MEMORY_BOOST,
} from "./trust.js";

const NO_EVIDENCE = { corroboratedBySources: [] };

test("trust = confidence x sourceTrust, clamped to [0,1]", () => {
  assert.ok(
    Math.abs(
      computeTrustScore({ extractionConfidence: 0.9, sourceTrust: 0.8, evidence: NO_EVIDENCE }) -
        0.72,
    ) < 1e-9,
  );
  // Missing confidence defaults to 0.7.
  assert.equal(
    computeTrustScore({ extractionConfidence: undefined, sourceTrust: 1, evidence: NO_EVIDENCE }),
    0.7,
  );
  // Boosts never push past 1.
  assert.equal(
    computeTrustScore({
      extractionConfidence: 1,
      sourceTrust: 1,
      judgeVerdict: "accept",
      evidence: { corroboratedBySources: ["bee"], supportingMemoryId: "m1" },
    }),
    1,
  );
});

test("judge accept and corroboration boosts stack as documented", () => {
  const base = computeTrustScore({
    extractionConfidence: 0.5,
    sourceTrust: 0.8,
    evidence: NO_EVIDENCE,
  });
  const judged = computeTrustScore({
    extractionConfidence: 0.5,
    sourceTrust: 0.8,
    judgeVerdict: "accept",
    evidence: NO_EVIDENCE,
  });
  const corroborated = computeTrustScore({
    extractionConfidence: 0.5,
    sourceTrust: 0.8,
    judgeVerdict: "accept",
    evidence: { corroboratedBySources: ["omi"], supportingMemoryId: "m1" },
  });
  assert.ok(Math.abs(judged - base - TRUST_JUDGE_ACCEPT_BOOST) < 1e-9);
  assert.ok(
    Math.abs(
      corroborated -
        judged -
        TRUST_CROSS_SOURCE_BOOST -
        TRUST_SUPPORTING_MEMORY_BOOST,
    ) < 1e-9,
  );
});

test("decideSmart: judge verdicts short-circuit; trust bands otherwise", () => {
  const thresholds = { autoApproveTrust: 0.7, reviewTrust: 0.45 };
  assert.equal(decideSmart(0.99, "reject", thresholds).outcome, "drop");
  assert.equal(decideSmart(0.99, "defer", thresholds).outcome, "review");
  assert.equal(decideSmart(0.7, "accept", thresholds).outcome, "active");
  assert.equal(decideSmart(0.7, undefined, thresholds).outcome, "active");
  assert.equal(decideSmart(0.5, undefined, thresholds).outcome, "review");
  assert.equal(decideSmart(0.2, undefined, thresholds).outcome, "drop");
});

test("cross-source corroboration requires high token coverage", () => {
  const beeDay = tokenizeDayBody(
    "We agreed the product launch moves to September twelfth after the vendor call.",
  );
  const context = {
    otherSourceDayTokens: new Map([["bee", beeDay]]),
    existingMemories: [],
  };
  const corroborated = findCorroboration(
    "Launch moved to September twelfth after vendor call.",
    context,
  );
  assert.deepEqual(corroborated.corroboratedBySources, ["bee"]);

  const unrelated = findCorroboration(
    "Dentist appointment is on Thursday afternoon downtown.",
    context,
  );
  assert.deepEqual(unrelated.corroboratedBySources, []);
});

test("existing-memory support sets supportingMemoryId", () => {
  const context = {
    otherSourceDayTokens: new Map<string, Set<string>>(),
    existingMemories: [
      { id: "fact-1", content: "User prefers the aisle seat on long flights." },
      { id: "fact-2", content: "The launch moved to September twelfth, vendor informed." },
    ],
  };
  const supported = findCorroboration(
    "Launch moved to September twelfth and the vendor was informed.",
    context,
  );
  assert.equal(supported.supportingMemoryId, "fact-2");
});

test("very short facts never corroborate (too little signal)", () => {
  const context = {
    otherSourceDayTokens: new Map([["bee", tokenizeDayBody("yes ok sure fine")]]),
    existingMemories: [{ id: "m", content: "yes ok sure fine" }],
  };
  const evidence = findCorroboration("yes ok", context);
  assert.deepEqual(evidence.corroboratedBySources, []);
  assert.equal(evidence.supportingMemoryId, undefined);
});
