import assert from "node:assert/strict";
import test from "node:test";

import { defaultActivityConfig } from "./config.js";
import { generateActivityMemories, isEligibleActivityFact } from "./memory-gen.js";

const ownDecision = {
  category: "decision" as const,
  content: "I decided to consolidate the account settings.",
  confidence: 0.95,
  tags: ["settings"],
};

function depsFor(facts: typeof ownDecision[]) {
  const writes: Array<{ status: string; content: string }> = [];
  return {
    writes,
    deps: {
      extract: async () => ({ facts, profileUpdates: [], entities: [], questions: [] }),
      judge: async () => new Map([[0, { durable: true, reason: "durable", kind: "accept" as const }]]),
      writer: {
        hasFactContentHash: async () => false,
        writeSealedMemory: async (envelope: { content: string }, extras: { status: string }) => {
          writes.push({ content: envelope.content, status: extras.status });
          return {};
        },
      },
    },
  };
}

test("activity smart mode rejects visible third-party claims before judging", async () => {
  const thirdParty = { ...ownDecision, content: "Acme announced a new pricing plan." };
  assert.equal(isEligibleActivityFact(thirdParty), false);
  const { deps, writes } = depsFor([thirdParty]);
  const result = await generateActivityMemories("## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart",
  }, deps);
  assert.deepEqual(result, { created: 0, pendingReview: 0, rejectedDisplayedContent: 1, rejectedByJudge: 0, skipped: 0 });
  assert.deepEqual(writes, []);
});

test("activity smart mode writes an accepted first-person decision", async () => {
  const { deps, writes } = depsFor([ownDecision]);
  const result = await generateActivityMemories("## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart", sourceTrust: 1, autoApproveTrust: 0.8,
  }, deps);
  assert.equal(result.created, 1);
  assert.deepEqual(writes, [{ content: ownDecision.content, status: "active" }]);
});

test("activity extraction remains inactive unless smart mode is explicitly enabled", async () => {
  const { deps, writes } = depsFor([ownDecision]);
  const result = await generateActivityMemories("## Notable activity", defaultActivityConfig(), deps);
  assert.deepEqual(result, { created: 0, pendingReview: 0, rejectedDisplayedContent: 0, rejectedByJudge: 0, skipped: 0 });
  assert.deepEqual(writes, []);
});
