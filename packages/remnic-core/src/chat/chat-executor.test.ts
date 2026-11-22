import test from "node:test";
import assert from "node:assert/strict";

import { createChatExecutor } from "./chat-executor.js";
import type { EngramAccessService } from "../access-service.js";

type Calls = {
  plan: unknown[];
  apply: unknown[];
  pending: unknown[];
};

interface PlanStub {
  planId: string;
  namespace: string;
  classification: string;
  confidence: number;
  affected: { memoryId: string }[];
  warnings: string[];
  diff: string;
}

function harness(planOut: PlanStub, plans: PlanStub[] = []) {
  const calls: Calls = { plan: [], apply: [], pending: [] };
  const service = {
    correctionPlan: async (req: { text: string; namespace?: string; sessionKey?: string; principal?: string }) => {
      calls.plan.push(req);
      return planOut;
    },
    correctionApply: async (
      planId: string,
      opts: { confirm?: boolean; namespace?: string; sessionKey?: string; principal?: string },
    ) => {
      calls.apply.push([planId, opts]);
      return { status: "applied" };
    },
    correctionListPending: async (opts: { namespace?: string; sessionKey?: string; principal?: string }) => {
      calls.pending.push(opts);
      return plans;
    },
  };
  const executor = createChatExecutor({
    // SAFETY: only the correction methods are exercised.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions
    service: service as unknown as EngramAccessService,
    principal: "p-1",
    namespace: "ns-1",
    sessionKey: "sk-1",
  });
  return { calls, executor };
}

const plan: PlanStub = {
  planId: "plan-real",
  namespace: "ns-1",
  classification: "wrong",
  confidence: 0.9,
  affected: [{ memoryId: "m-1" }],
  warnings: [],
  diff: "diff preview",
};

test("correctionPlan delegates to the real CorrectionService plan — #3553", async () => {
  const { calls, executor } = harness(plan);
  const out = await executor.correctionPlan("that fact is outdated");
  assert.equal(out.planId, "plan-real");
  assert.match(out.preview, /diff preview/);
  assert.deepEqual(calls.plan, [
    { text: "that fact is outdated", sessionKey: "sk-1", principal: "p-1", namespace: "ns-1" },
  ]);
});

test("correctionPlan retrieves a pending plan instead of minting a new one — #3553", async () => {
  const { calls, executor } = harness(plan, [plan]);
  const out = await executor.correctionPlan("retrieve plan plan-real");
  assert.equal(out.planId, "plan-real");
  assert.match(out.preview, /diff preview/);
  assert.equal(calls.plan.length, 0, "must not mint a fresh plan for a retrieval request");
  assert.equal(calls.pending.length, 1);
});

test("correctionApply delegates with confirm and the caller scope — #3553", async () => {
  const { calls, executor } = harness(plan);
  const out = await executor.correctionApply("plan-real");
  assert.match(out, /applied/);
  assert.deepEqual(calls.apply, [
    ["plan-real", { confirm: true, namespace: "ns-1", sessionKey: "sk-1", principal: "p-1" }],
  ]);
});
