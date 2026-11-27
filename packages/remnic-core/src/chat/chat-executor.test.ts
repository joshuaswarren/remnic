import assert from "node:assert/strict";
import test from "node:test";
import { EngramAccessService } from "../access-service.js";
import type {
  CorrectionOutcome,
  CorrectionPlan,
  CorrectionRequest,
} from "../correction/index.js";
import { createChatExecutor } from "./chat-executor.js";

interface ApplyOpts {
  confirm?: boolean;
  namespace?: string;
  sessionKey?: string;
  principal?: string;
  abortSignal?: AbortSignal;
}

interface ListPendingOpts {
  namespace?: string;
  sessionKey?: string;
  principal?: string;
}

interface CapturedCalls {
  planRequests: CorrectionRequest[];
  applyPlanIds: string[];
  applyOpts: ApplyOpts[];
  listOpts: ListPendingOpts[];
}

/** Minimal correction surface; captures the args the executor sends. */
function fakeCorrectionService(calls: CapturedCalls, pending: CorrectionPlan[]): EngramAccessService {
  // SAFETY: the double implements only the three correction methods the
  // executor calls; no other EngramAccessService member is reached here.
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  service.correctionPlan = async (request: CorrectionRequest): Promise<CorrectionPlan> => {
    calls.planRequests.push(request);
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
  };
  service.correctionApply = async (planId: string, opts: ApplyOpts): Promise<CorrectionOutcome> => {
    calls.applyPlanIds.push(planId);
    calls.applyOpts.push(opts);
    return {
      planId,
      status: "applied",
      results: [],
      auditMemoryId: "audit-1",
      appliedAt: "t",
    };
  };
  service.correctionListPending = async (opts: ListPendingOpts): Promise<CorrectionPlan[]> => {
    calls.listOpts.push(opts);
    return pending;
  };
  return service;
}

function emptyCalls(): CapturedCalls {
  return { planRequests: [], applyPlanIds: [], applyOpts: [], listOpts: [] };
}

test("correctionPlan delegates to the access-service plan path", async () => {
  const calls = emptyCalls();
  const executor = createChatExecutor({
    service: fakeCorrectionService(calls, []),
    principal: "reader",
    namespace: "team",
    sessionKey: "sess-1",
  });
  const plan = await executor.correctionPlan("the deploy day is wrong");
  assert.equal(plan.planId, "corr-real-1");
  assert.equal(plan.preview, "DIFF: rewrite fact");
  const request = calls.planRequests[0];
  assert.equal(request?.text, "the deploy day is wrong");
  assert.equal(request?.sessionKey, "sess-1");
  assert.equal(request?.principal, "reader");
  assert.equal(request?.namespace, "team");
  // The stub marker must be gone.
  assert.ok(!plan.planId.startsWith("stub-"));
  assert.ok(!plan.preview.includes("not yet available"));
});

test("correctionPlan retrieves a pending plan preview for the engine sentinel", async () => {
  const calls = emptyCalls();
  const pending: CorrectionPlan[] = [
    {
      planId: "corr-9",
      request: { text: "prior request" },
      namespace: "ns",
      affected: [],
      classification: "outdated",
      actions: [],
      diff: "DIFF: pending preview",
      confidence: 0.8,
      warnings: [],
      createdAt: "t",
      expiresAt: "t+1h",
    },
  ];
  const executor = createChatExecutor({
    service: fakeCorrectionService(calls, pending),
    sessionKey: "sess-1",
  });
  const plan = await executor.correctionPlan("retrieve plan corr-9");
  assert.equal(plan.planId, "corr-9");
  assert.equal(plan.preview, "DIFF: pending preview");
  assert.equal(calls.planRequests.length, 0, "sentinel must not mint a new plan");
  assert.equal(calls.listOpts.length, 1);
  await assert.rejects(
    () => executor.correctionPlan("retrieve plan corr-missing"),
    /not found|expired/i,
  );
});

test("correctionApply delegates with confirm and the bound identity", async () => {
  const calls = emptyCalls();
  const executor = createChatExecutor({
    service: fakeCorrectionService(calls, []),
    principal: "writer",
    namespace: "team",
    sessionKey: "sess-2",
  });
  // SAFETY: correctionApply JSON.stringify's the service outcome, so the
  // parsed shape is the CorrectionOutcome the fake returned.
  const out = JSON.parse(await executor.correctionApply("corr-real-1")) as {
    status: string;
    auditMemoryId: string;
  };
  assert.equal(out.status, "applied");
  assert.equal(out.auditMemoryId, "audit-1");
  assert.equal(calls.applyPlanIds[0], "corr-real-1");
  const opts = calls.applyOpts[0];
  assert.equal(opts?.confirm, true);
  assert.equal(opts?.sessionKey, "sess-2");
  assert.equal(opts?.principal, "writer");
  assert.equal(opts?.namespace, "team");
});
