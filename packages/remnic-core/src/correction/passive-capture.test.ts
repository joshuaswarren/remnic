/**
 * passive-capture.test.ts — pipeline tests for passive correction capture
 * (issue #1581 PR 2–3).
 *
 * Tests: queue mode, auto mode + all guards, dedup, notifications, telemetry.
 * Uses mock deps — no real CorrectionService or storage.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  capturePassiveCorrections,
  evaluateAutoApplyGuards,
  emptyTelemetry,
  type PassiveCaptureConfig,
  type PassiveCaptureContext,
  type PassiveCaptureDeps,
} from "./passive-capture.js";
import type { PassiveCorrection } from "./passive-correction-detector.js";
import type {
  CorrectionAction,
  CorrectionClassification,
  CorrectionOutcome,
  CorrectionPlan,
} from "./correction-contract.js";
import {
  enqueuePassiveCorrectionNotification,
  drainPassiveCorrectionNotifications,
} from "./passive-correction-notifications.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCorrection(overrides: Partial<PassiveCorrection> = {}): PassiveCorrection {
  return {
    targetHint: "Redis usage",
    correctedAssertion: "we don't use Redis anymore",
    polarity: "retract",
    handles: [],
    confidence: 0.9,
    sourceExcerpt: "we don't use Redis anymore",
    turnIndex: 0,
    ...overrides,
  };
}

function makePlan(overrides: Partial<CorrectionPlan> = {}): CorrectionPlan {
  return {
    planId: "corr-test-001",
    request: { text: "we don't use Redis anymore", namespace: "default" },
    namespace: "default",
    affected: [{ memoryId: "mem-001", path: "facts/redis.md", excerpt: "Uses Redis for caching", why: "matches correction" }],
    classification: "outdated",
    actions: [{ kind: "retract", memoryId: "mem-001" }],
    diff: "- Uses Redis for caching",
    confidence: 0.9,
    warnings: [],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    status: "pending",
    ...overrides,
  };
}

function mockDeps(
  plan: CorrectionPlan,
  opts: { applyOutcome?: CorrectionOutcome; appliedPlans: string[] } = { appliedPlans: [] },
): PassiveCaptureDeps {
  return {
    planCorrection: async () => plan,
    applyCorrection: async (planId) => {
      opts.appliedPlans.push(planId);
      return (
        opts.applyOutcome ?? {
          planId,
          status: "applied" as const,
          results: [{ action: plan.actions[0], status: "applied" as const }],
          auditMemoryId: "audit-001",
          appliedAt: new Date().toISOString(),
        }
      );
    },
    storageDir: async () => "/tmp/test-passive-capture",
  };
}

const QUEUE_CONFIG: PassiveCaptureConfig = {
  mode: "queue",
  confidenceFloor: 0.85,
  autoApplyMaxAffected: 2,
};

const AUTO_CONFIG: PassiveCaptureConfig = {
  mode: "auto",
  confidenceFloor: 0.85,
  autoApplyMaxAffected: 2,
};

const LIVE_CTX: PassiveCaptureContext = {
  correctionEnabled: true,
  isLiveSession: true,
  bufferKey: "session-1",
  namespace: "default",
};

// ---------------------------------------------------------------------------
// Queue mode
// ---------------------------------------------------------------------------

test("queue mode: plans corrections and leaves them pending", async () => {
  const plan = makePlan();
  const deps = mockDeps(plan);
  const dedup = new Set<string>();

  const result = await capturePassiveCorrections([makeCorrection()], LIVE_CTX, QUEUE_CONFIG, deps, dedup);

  assert.strictEqual(result.telemetry.detected, 1);
  assert.strictEqual(result.telemetry.queued, 1);
  assert.strictEqual(result.telemetry.autoApplied, 0);
  assert.strictEqual(result.plans.length, 1);
});

test("queue mode: does not auto-apply", async () => {
  const appliedPlans: string[] = [];
  const plan = makePlan();
  const deps = mockDeps(plan, { appliedPlans });
  const dedup = new Set<string>();

  await capturePassiveCorrections([makeCorrection()], LIVE_CTX, QUEUE_CONFIG, deps, dedup);

  assert.strictEqual(appliedPlans.length, 0);
});

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

test("dedup: same correction, two flushes → one plan", async () => {
  const plan = makePlan();
  const deps = mockDeps(plan);
  const dedup = new Set<string>();

  const correction = makeCorrection();
  const r1 = await capturePassiveCorrections([correction], LIVE_CTX, QUEUE_CONFIG, deps, dedup);
  const r2 = await capturePassiveCorrections([correction], LIVE_CTX, QUEUE_CONFIG, deps, dedup);

  assert.strictEqual(r1.telemetry.queued, 1);
  assert.strictEqual(r2.telemetry.queued, 0);
  assert.strictEqual(r2.telemetry.detected, 1);
});

test("dedup: different bufferKey → both processed", async () => {
  const plan = makePlan();
  const deps = mockDeps(plan);
  const dedup = new Set<string>();

  const correction = makeCorrection();
  await capturePassiveCorrections([correction], { ...LIVE_CTX, bufferKey: "session-A" }, QUEUE_CONFIG, deps, dedup);
  await capturePassiveCorrections([correction], { ...LIVE_CTX, bufferKey: "session-B" }, QUEUE_CONFIG, deps, dedup);

  assert.strictEqual(dedup.size, 2);
});

// ---------------------------------------------------------------------------
// Auto mode + guards
// ---------------------------------------------------------------------------

test("auto mode: applies when all guards pass", async () => {
  const appliedPlans: string[] = [];
  const plan = makePlan({ confidence: 0.9, classification: "outdated" });
  const deps = mockDeps(plan, { appliedPlans });
  const dedup = new Set<string>();

  const result = await capturePassiveCorrections([makeCorrection()], LIVE_CTX, AUTO_CONFIG, deps, dedup);

  assert.strictEqual(result.telemetry.autoApplied, 1);
  assert.deepStrictEqual(appliedPlans, ["corr-test-001"]);
});

test("passive capture forwards its cancellation signal to plan and apply", async () => {
  const abortController = new AbortController();
  const plan = makePlan({ confidence: 0.9, classification: "outdated" });
  let plannedSignal: AbortSignal | undefined;
  let appliedSignal: AbortSignal | undefined;
  const deps: PassiveCaptureDeps = {
    planCorrection: async (_request, opts) => {
      plannedSignal = opts?.abortSignal;
      return plan;
    },
    applyCorrection: async (_planId, opts) => {
      appliedSignal = opts.abortSignal;
      return {
        planId: plan.planId,
        status: "applied",
        results: [{ action: plan.actions[0]!, status: "applied" }],
        auditMemoryId: "audit-001",
        appliedAt: new Date().toISOString(),
      };
    },
    storageDir: async () => "/tmp/test-passive-capture",
  };

  await capturePassiveCorrections(
    [makeCorrection()],
    { ...LIVE_CTX, abortSignal: abortController.signal },
    AUTO_CONFIG,
    deps,
    new Set<string>(),
  );

  assert.equal(plannedSignal, abortController.signal);
  assert.equal(appliedSignal, abortController.signal);
});

test("auto mode: suppressed — confidence below floor → queued", async () => {
  const appliedPlans: string[] = [];
  const plan = makePlan({ confidence: 0.5 });
  const deps = mockDeps(plan, { appliedPlans });
  const dedup = new Set<string>();

  const result = await capturePassiveCorrections([makeCorrection()], LIVE_CTX, AUTO_CONFIG, deps, dedup);

  assert.strictEqual(result.telemetry.autoApplied, 0);
  assert.strictEqual(result.telemetry.queued, 1);
  assert.strictEqual(result.telemetry.suppressedReasons.confidence_below_floor, 1);
  assert.strictEqual(appliedPlans.length, 0);
});

test("auto mode: suppressed — affected too large → queued", async () => {
  const appliedPlans: string[] = [];
  const plan = makePlan({
    affected: [
      { memoryId: "m1", path: "a.md", excerpt: "x", why: "y" },
      { memoryId: "m2", path: "b.md", excerpt: "x", why: "y" },
      { memoryId: "m3", path: "c.md", excerpt: "x", why: "y" },
    ],
  });
  const deps = mockDeps(plan, { appliedPlans });
  const dedup = new Set<string>();

  const result = await capturePassiveCorrections([makeCorrection()], LIVE_CTX, AUTO_CONFIG, deps, dedup);

  assert.strictEqual(result.telemetry.autoApplied, 0);
  assert.strictEqual(result.telemetry.suppressedReasons.affected_too_large, 1);
});

test("auto mode: suppressed — disallowed classification → queued", async () => {
  const appliedPlans: string[] = [];
  const plan = makePlan({ classification: "wrong_scope" as CorrectionClassification });
  const deps = mockDeps(plan, { appliedPlans });
  const dedup = new Set<string>();

  const result = await capturePassiveCorrections([makeCorrection()], LIVE_CTX, AUTO_CONFIG, deps, dedup);

  assert.strictEqual(result.telemetry.autoApplied, 0);
  assert.strictEqual(result.telemetry.suppressedReasons.classification_not_allowed, 1);
});

test("auto mode: suppressed — disallowed action kind (rescope) → queued", async () => {
  const appliedPlans: string[] = [];
  const plan = makePlan({
    actions: [{ kind: "rescope", memoryId: "m1", toNamespace: "other" } as CorrectionAction],
  });
  const deps = mockDeps(plan, { appliedPlans });
  const dedup = new Set<string>();

  const result = await capturePassiveCorrections([makeCorrection()], LIVE_CTX, AUTO_CONFIG, deps, dedup);

  assert.strictEqual(result.telemetry.autoApplied, 0);
  assert.strictEqual(result.telemetry.suppressedReasons.disallowed_action_kind, 1);
});

test("auto mode: suppressed — empty action list (no-op plan) → queued (review: empty-plan guard)", async () => {
  const appliedPlans: string[] = [];
  const plan = makePlan({ actions: [], confidence: 0.9 });
  const deps = mockDeps(plan, { appliedPlans });
  const dedup = new Set<string>();

  const result = await capturePassiveCorrections([makeCorrection()], LIVE_CTX, AUTO_CONFIG, deps, dedup);

  assert.strictEqual(result.telemetry.autoApplied, 0);
  assert.strictEqual(result.telemetry.suppressedReasons.empty_plan, 1);
  assert.strictEqual(appliedPlans.length, 0, "empty plan must not be auto-applied");
});

test("auto mode: suppressed — non-live session (replay) → queued", async () => {
  const appliedPlans: string[] = [];
  const plan = makePlan();
  const deps = mockDeps(plan, { appliedPlans });
  const dedup = new Set<string>();

  const result = await capturePassiveCorrections(
    [makeCorrection()],
    { ...LIVE_CTX, isLiveSession: false },
    AUTO_CONFIG,
    deps,
    dedup,
  );

  assert.strictEqual(result.telemetry.autoApplied, 0);
  assert.strictEqual(result.telemetry.suppressedReasons.non_live_session, 1);
});

test("auto mode: auto-applied correction enqueues notification", async () => {
  const plan = makePlan({ confidence: 0.9 });
  const tmpDir = path.join(os.tmpdir(), `test-passive-notify-${Date.now()}`);
  const deps: PassiveCaptureDeps = {
    planCorrection: async () => plan,
    applyCorrection: async (planId) => ({
      planId,
      status: "applied",
      results: [],
      auditMemoryId: "audit",
      appliedAt: new Date().toISOString(),
    }),
    storageDir: async () => tmpDir,
  };
  const dedup = new Set<string>();

  await capturePassiveCorrections([makeCorrection()], LIVE_CTX, AUTO_CONFIG, deps, dedup);

  const notifications = await drainPassiveCorrectionNotifications(tmpDir);
  assert.strictEqual(notifications.length, 1);
  assert.strictEqual(notifications[0].planId, "corr-test-001");
  assert.ok(notifications[0].undoCommand.includes("auto-applied"));
  assert.ok(notifications[0].undoCommand.includes("corr-test-001"));

  await rm(tmpDir, { recursive: true, force: true });
});

test("auto mode: partial outcome queues instead of counting as applied (review: partial outcomes)", async () => {
  const plan = makePlan({ confidence: 0.9 });
  const deps: PassiveCaptureDeps = {
    planCorrection: async () => plan,
    applyCorrection: async (planId) => ({
      planId,
      status: "partial" as const,
      results: [{ action: plan.actions[0], status: "failed" as const }],
      auditMemoryId: "audit",
      appliedAt: new Date().toISOString(),
    }),
    storageDir: async () => "/tmp/test-passive-capture",
  };
  const dedup = new Set<string>();

  const result = await capturePassiveCorrections([makeCorrection()], LIVE_CTX, AUTO_CONFIG, deps, dedup);

  assert.strictEqual(result.telemetry.autoApplied, 0, "partial outcome must not count as auto-applied");
  assert.strictEqual(result.telemetry.queued, 0, "partial outcome does not re-queue (plan is consumed)");
});

// ---------------------------------------------------------------------------
// evaluateAutoApplyGuards — direct unit tests
// ---------------------------------------------------------------------------

test("guards: returns null when all pass", () => {
  const config: PassiveCaptureConfig = { mode: "auto", confidenceFloor: 0.85, autoApplyMaxAffected: 2 };
  const plan = makePlan({ confidence: 0.9 });
  assert.strictEqual(evaluateAutoApplyGuards(plan, config, true), null);
});

test("guards: non_live_session for replay", () => {
  const config: PassiveCaptureConfig = { mode: "auto", confidenceFloor: 0.85, autoApplyMaxAffected: 2 };
  assert.strictEqual(evaluateAutoApplyGuards(makePlan(), config, false), "non_live_session");
});

test("guards: confidence_below_floor", () => {
  const config: PassiveCaptureConfig = { mode: "auto", confidenceFloor: 0.85, autoApplyMaxAffected: 2 };
  assert.strictEqual(evaluateAutoApplyGuards(makePlan({ confidence: 0.5 }), config, true), "confidence_below_floor");
});

test("guards: classification_not_allowed for wrong_scope", () => {
  const config: PassiveCaptureConfig = { mode: "auto", confidenceFloor: 0.85, autoApplyMaxAffected: 2 };
  assert.strictEqual(evaluateAutoApplyGuards(makePlan({ classification: "wrong_scope" }), config, true), "classification_not_allowed");
});

test("guards: affected_too_large", () => {
  const config: PassiveCaptureConfig = { mode: "auto", confidenceFloor: 0.85, autoApplyMaxAffected: 2 };
  const plan = makePlan({
    affected: [
      { memoryId: "m1", path: "a", excerpt: "x", why: "y" },
      { memoryId: "m2", path: "b", excerpt: "x", why: "y" },
      { memoryId: "m3", path: "c", excerpt: "x", why: "y" },
    ],
  });
  assert.strictEqual(evaluateAutoApplyGuards(plan, config, true), "affected_too_large");
});

test("guards: disallowed_action_kind for redaction_rule", () => {
  const config: PassiveCaptureConfig = { mode: "auto", confidenceFloor: 0.85, autoApplyMaxAffected: 2 };
  const plan = makePlan({ actions: [{ kind: "redaction_rule", pattern: "secret" }] });
  assert.strictEqual(evaluateAutoApplyGuards(plan, config, true), "disallowed_action_kind");
});

// ---------------------------------------------------------------------------
// Notifications — drain-once semantics
// ---------------------------------------------------------------------------

test("notifications: drains once then returns empty", async () => {
  const tmpDir = path.join(os.tmpdir(), `test-passive-notify-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });

  await enqueuePassiveCorrectionNotification(tmpDir, {
    planId: "p1", summary: "test", undoCommand: "auto-applied (plan p1)", createdAt: new Date().toISOString(),
  });

  const first = await drainPassiveCorrectionNotifications(tmpDir);
  const second = await drainPassiveCorrectionNotifications(tmpDir);

  assert.strictEqual(first.length, 1);
  assert.strictEqual(second.length, 0);

  await rm(tmpDir, { recursive: true, force: true });
});

test("notifications: accumulates multiple", async () => {
  const tmpDir = path.join(os.tmpdir(), `test-passive-notify-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });

  await enqueuePassiveCorrectionNotification(tmpDir, {
    planId: "p1", summary: "first", undoCommand: "auto-applied (plan p1)", createdAt: new Date().toISOString(),
  });
  await enqueuePassiveCorrectionNotification(tmpDir, {
    planId: "p2", summary: "second", undoCommand: "auto-applied (plan p2)", createdAt: new Date().toISOString(),
  });

  const drained = await drainPassiveCorrectionNotifications(tmpDir);
  assert.strictEqual(drained.length, 2);
  assert.deepStrictEqual(drained.map((n) => n.planId), ["p1", "p2"]);

  await rm(tmpDir, { recursive: true, force: true });
});

test("notifications: returns empty when no file exists", async () => {
  const tmpDir = path.join(os.tmpdir(), `test-passive-notify-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const drained = await drainPassiveCorrectionNotifications(tmpDir);
  assert.deepStrictEqual(drained, []);
});

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

test("telemetry: emptyTelemetry returns zeroed counters", () => {
  const t = emptyTelemetry();
  assert.strictEqual(t.detected, 0);
  assert.strictEqual(t.queued, 0);
  assert.strictEqual(t.autoApplied, 0);
  assert.strictEqual(Object.keys(t.suppressedReasons).length, 0);
});

// ---------------------------------------------------------------------------
// Review fixes (cursor threads)
// ---------------------------------------------------------------------------

test("handle resolution: resolveHandle dep converts [m:xxxx] to memory ids (review)", async () => {
  // The planner resolveTargetMemories expects concrete memory ids, not raw
  // [m:xxxx] tokens. The capture loop must resolve handles via the resolveHandle
  // dep before building the CorrectionRequest; unresolvable handles are dropped
  // so the planner falls back to text search.
  let capturedTargetIds: string[] | undefined;
  const deps: PassiveCaptureDeps = {
    ...mockDeps(makePlan()),
    resolveHandle: (ref) => (ref === "[m:4f2a]" ? "fact-1700000000-abcd" : null),
    planCorrection: async (req) => {
      capturedTargetIds = req.targetIds as string[] | undefined;
      return makePlan();
    },
  };
  const correction = makeCorrection({
    handles: ["[m:4f2a]"],
    correctedAssertion: "[m:4f2a] is wrong",
    polarity: "retract",
  });
  await capturePassiveCorrections(
    [correction],
    { ...LIVE_CTX, sessionKey: "sess-1" },
    QUEUE_CONFIG,
    deps,
    new Set(),
  );
  assert.deepStrictEqual(
    capturedTargetIds,
    ["fact-1700000000-abcd"],
    "handle must be resolved to a concrete memory id before planning",
  );
});

test("handle resolution: unresolvable handle is dropped (planner falls back to text)", async () => {
  let capturedTargetIds: string[] | undefined;
  const deps: PassiveCaptureDeps = {
    ...mockDeps(makePlan()),
    resolveHandle: () => null,
    planCorrection: async (req) => {
      capturedTargetIds = req.targetIds as string[] | undefined;
      return makePlan();
    },
  };
  const correction = makeCorrection({ handles: ["[m:dead]"] });
  await capturePassiveCorrections(
    [correction],
    { ...LIVE_CTX, sessionKey: "sess-1" },
    QUEUE_CONFIG,
    deps,
    new Set(),
  );
  assert.strictEqual(capturedTargetIds, undefined, "unresolvable handle must not reach the planner");
});

test("dedup: failed plan can be retried on a later flush (review)", async () => {
  // The fingerprint is recorded only AFTER a successful plan, so a transient
  // planning failure does not permanently block the correction.
  let attempts = 0;
  const deps: PassiveCaptureDeps = {
    ...mockDeps(makePlan()),
    planCorrection: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient planning failure");
      return makePlan();
    },
  };
  const dedup = new Set<string>();
  const correction = makeCorrection();
  // First flush: planning throws — fingerprint NOT recorded.
  const r1 = await capturePassiveCorrections([correction], LIVE_CTX, QUEUE_CONFIG, deps, dedup);
  assert.strictEqual(r1.telemetry.queued, 0, "failed plan must not count as queued");
  // Second flush: same correction, retry succeeds.
  const r2 = await capturePassiveCorrections([correction], LIVE_CTX, QUEUE_CONFIG, deps, dedup);
  assert.strictEqual(r2.telemetry.queued, 1, "failed plan must be retriable");
  assert.strictEqual(attempts, 2);
});
