import assert from "node:assert/strict";
import test from "node:test";
import type { EngramAccessService } from "../access-service.js";
import { createChatExecutor } from "./chat-executor.js";

interface PlanRecord {
  planId: string;
  diff: string;
  namespace?: string;
}

/** Minimal correction surface: records the request/opts the executor sends. */
function fakeCorrectionService(calls: {
  planArgs: unknown[];
  applyArgs: unknown[];
  listArgs: unknown[];
  pending: PlanRecord[];
}) {
  return {
    correctionPlan: async (request: unknown, opts?: unknown) => {
      calls.planArgs.push(request, opts);
      return {
        planId: "corr-real-1",
        request,
        namespace: "ns",
        affected: [],
        classification: "wrong",
        actions: [],
        diff: "DIFF: rewrite fact",
        confidence: 0.9,
        warnings: [],
        createdAt: "t",
        expiresAt: "t+1h",
      };
    },
    correctionApply: async (planId: string, opts: unknown) => {
      calls.applyArgs.push(planId, opts);
      return {
        planId,
        status: "applied",
        results: [],
        auditMemoryId: "audit-1",
        appliedAt: "t",
      };
    },
    correctionListPending: async (opts: unknown) => {
      calls.listArgs.push(opts);
      return calls.pending;
    },
  } as unknown as EngramAccessService;
}

test("correctionPlan delegates to the access-service plan path", async () => {
  const calls = { planArgs: [] as unknown[], applyArgs: [] as unknown[], listArgs: [] as unknown[], pending: [] as PlanRecord[] };
  const executor = createChatExecutor({
    service: fakeCorrectionService(calls),
    principal: "reader",
    namespace: "team",
    sessionKey: "sess-1",
  });
  const plan = await executor.correctionPlan("the deploy day is wrong");
  assert.equal(plan.planId, "corr-real-1");
  assert.equal(plan.preview, "DIFF: rewrite fact");
  const request = calls.planArgs[0] as Record<string, unknown>;
  assert.equal(request.text, "the deploy day is wrong");
  assert.equal(request.sessionKey, "sess-1");
  assert.equal(request.principal, "reader");
  assert.equal(request.namespace, "team");
  // The stub marker must be gone.
  assert.ok(!plan.planId.startsWith("stub-"));
  assert.ok(!plan.preview.includes("not yet available"));
});

test("correctionPlan retrieves a pending plan preview for the engine sentinel", async () => {
  const calls = {
    planArgs: [] as unknown[],
    applyArgs: [] as unknown[],
    listArgs: [] as unknown[],
    pending: [{ planId: "corr-9", diff: "DIFF: pending preview" }],
  };
  const executor = createChatExecutor({
    service: fakeCorrectionService(calls),
    sessionKey: "sess-1",
  });
  const plan = await executor.correctionPlan("retrieve plan corr-9");
  assert.equal(plan.planId, "corr-9");
  assert.equal(plan.preview, "DIFF: pending preview");
  assert.equal(calls.planArgs.length, 0, "sentinel must not mint a new plan");
  assert.equal(calls.listArgs.length, 1);
  await assert.rejects(
    () => executor.correctionPlan("retrieve plan corr-missing"),
    /not found|expired/i,
  );
});

test("correctionApply delegates with confirm and the bound identity", async () => {
  const calls = { planArgs: [] as unknown[], applyArgs: [] as unknown[], listArgs: [] as unknown[], pending: [] as PlanRecord[] };
  const executor = createChatExecutor({
    service: fakeCorrectionService(calls),
    principal: "writer",
    namespace: "team",
    sessionKey: "sess-2",
  });
  const out = JSON.parse(await executor.correctionApply("corr-real-1"));
  assert.equal(out.status, "applied");
  assert.equal(out.auditMemoryId, "audit-1");
  assert.equal(calls.applyArgs[0], "corr-real-1");
  const opts = calls.applyArgs[1] as Record<string, unknown>;
  assert.equal(opts.confirm, true);
  assert.equal(opts.sessionKey, "sess-2");
  assert.equal(opts.principal, "writer");
  assert.equal(opts.namespace, "team");
});
