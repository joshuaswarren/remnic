/**
 * passive-capture.test.ts — pipeline tests for passive correction capture
 * (issue #1581 PR 2–3).
 *
 * Tests: queue mode, auto mode + all guards, dedup, notifications, telemetry.
 * Uses mock deps — no real CorrectionService or storage.
 */

import { describe, it, expect, beforeEach } from "vitest";
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
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

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

describe("capturePassiveCorrections — queue mode", () => {
  it("plans corrections and leaves them pending", async () => {
    const plan = makePlan();
    const deps = mockDeps(plan);
    const dedup = new Set<string>();

    const result = await capturePassiveCorrections(
      [makeCorrection()],
      LIVE_CTX,
      QUEUE_CONFIG,
      deps,
      dedup,
    );

    expect(result.telemetry.detected).toBe(1);
    expect(result.telemetry.queued).toBe(1);
    expect(result.telemetry.autoApplied).toBe(0);
    expect(result.plans).toHaveLength(1);
  });

  it("does not auto-apply in queue mode", async () => {
    const appliedPlans: string[] = [];
    const plan = makePlan();
    const deps = mockDeps(plan, { appliedPlans });
    const dedup = new Set<string>();

    await capturePassiveCorrections(
      [makeCorrection()],
      LIVE_CTX,
      QUEUE_CONFIG,
      deps,
      dedup,
    );

    expect(appliedPlans).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

describe("capturePassiveCorrections — dedup", () => {
  it("same correction, two flushes → one plan", async () => {
    const plan = makePlan();
    const deps = mockDeps(plan);
    const dedup = new Set<string>();

    const correction = makeCorrection();
    const r1 = await capturePassiveCorrections([correction], LIVE_CTX, QUEUE_CONFIG, deps, dedup);
    const r2 = await capturePassiveCorrections([correction], LIVE_CTX, QUEUE_CONFIG, deps, dedup);

    expect(r1.telemetry.queued).toBe(1);
    expect(r2.telemetry.queued).toBe(0);
    expect(r2.telemetry.detected).toBe(1);
  });

  it("different bufferKey → both processed", async () => {
    const plan = makePlan();
    const deps = mockDeps(plan);
    const dedup = new Set<string>();

    const correction = makeCorrection();
    await capturePassiveCorrections(
      [correction],
      { ...LIVE_CTX, bufferKey: "session-A" },
      QUEUE_CONFIG,
      deps,
      dedup,
    );
    await capturePassiveCorrections(
      [correction],
      { ...LIVE_CTX, bufferKey: "session-B" },
      QUEUE_CONFIG,
      deps,
      dedup,
    );

    expect(dedup.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Auto mode + guards
// ---------------------------------------------------------------------------

describe("capturePassiveCorrections — auto mode", () => {
  it("auto-applies when all guards pass", async () => {
    const appliedPlans: string[] = [];
    const plan = makePlan({ confidence: 0.9, classification: "outdated" });
    const deps = mockDeps(plan, { appliedPlans });
    const dedup = new Set<string>();

    const result = await capturePassiveCorrections(
      [makeCorrection()],
      LIVE_CTX,
      AUTO_CONFIG,
      deps,
      dedup,
    );

    expect(result.telemetry.autoApplied).toBe(1);
    expect(appliedPlans).toEqual(["corr-test-001"]);
  });

  it("suppressed: confidence below floor → queued", async () => {
    const appliedPlans: string[] = [];
    const plan = makePlan({ confidence: 0.5 });
    const deps = mockDeps(plan, { appliedPlans });
    const dedup = new Set<string>();

    const result = await capturePassiveCorrections(
      [makeCorrection()],
      LIVE_CTX,
      AUTO_CONFIG,
      deps,
      dedup,
    );

    expect(result.telemetry.autoApplied).toBe(0);
    expect(result.telemetry.queued).toBe(1);
    expect(result.telemetry.suppressedReasons.confidence_below_floor).toBe(1);
    expect(appliedPlans).toHaveLength(0);
  });

  it("suppressed: affected too large → queued", async () => {
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

    const result = await capturePassiveCorrections(
      [makeCorrection()],
      LIVE_CTX,
      AUTO_CONFIG,
      deps,
      dedup,
    );

    expect(result.telemetry.autoApplied).toBe(0);
    expect(result.telemetry.suppressedReasons.affected_too_large).toBe(1);
  });

  it("suppressed: disallowed classification → queued", async () => {
    const appliedPlans: string[] = [];
    const plan = makePlan({ classification: "wrong_scope" as CorrectionClassification });
    const deps = mockDeps(plan, { appliedPlans });
    const dedup = new Set<string>();

    const result = await capturePassiveCorrections(
      [makeCorrection()],
      LIVE_CTX,
      AUTO_CONFIG,
      deps,
      dedup,
    );

    expect(result.telemetry.autoApplied).toBe(0);
    expect(result.telemetry.suppressedReasons.classification_not_allowed).toBe(1);
  });

  it("suppressed: disallowed action kind (rescope) → queued", async () => {
    const appliedPlans: string[] = [];
    const plan = makePlan({
      actions: [{ kind: "rescope", memoryId: "m1", toNamespace: "other" } as CorrectionAction],
    });
    const deps = mockDeps(plan, { appliedPlans });
    const dedup = new Set<string>();

    const result = await capturePassiveCorrections(
      [makeCorrection()],
      LIVE_CTX,
      AUTO_CONFIG,
      deps,
      dedup,
    );

    expect(result.telemetry.autoApplied).toBe(0);
    expect(result.telemetry.suppressedReasons.disallowed_action_kind).toBe(1);
  });

  it("suppressed: non-live session (replay) → queued", async () => {
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

    expect(result.telemetry.autoApplied).toBe(0);
    expect(result.telemetry.suppressedReasons.non_live_session).toBe(1);
  });

  it("auto-applied correction enqueues notification", async () => {
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

    await capturePassiveCorrections(
      [makeCorrection()],
      LIVE_CTX,
      AUTO_CONFIG,
      deps,
      dedup,
    );

    const notifications = await drainPassiveCorrectionNotifications(tmpDir);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].planId).toBe("corr-test-001");
    expect(notifications[0].undoCommand).toContain("remnic correct --revert");

    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// evaluateAutoApplyGuards — direct unit tests
// ---------------------------------------------------------------------------

describe("evaluateAutoApplyGuards", () => {
  const config: PassiveCaptureConfig = {
    mode: "auto",
    confidenceFloor: 0.85,
    autoApplyMaxAffected: 2,
  };

  it("returns null when all guards pass", () => {
    const plan = makePlan({ confidence: 0.9 });
    expect(evaluateAutoApplyGuards(plan, config, true)).toBeNull();
  });

  it("returns non_live_session for replay", () => {
    const plan = makePlan();
    expect(evaluateAutoApplyGuards(plan, config, false)).toBe("non_live_session");
  });

  it("returns confidence_below_floor", () => {
    const plan = makePlan({ confidence: 0.5 });
    expect(evaluateAutoApplyGuards(plan, config, true)).toBe("confidence_below_floor");
  });

  it("returns classification_not_allowed for wrong_scope", () => {
    const plan = makePlan({ classification: "wrong_scope" });
    expect(evaluateAutoApplyGuards(plan, config, true)).toBe("classification_not_allowed");
  });

  it("returns affected_too_large", () => {
    const plan = makePlan({
      affected: [
        { memoryId: "m1", path: "a", excerpt: "x", why: "y" },
        { memoryId: "m2", path: "b", excerpt: "x", why: "y" },
        { memoryId: "m3", path: "c", excerpt: "x", why: "y" },
      ],
    });
    expect(evaluateAutoApplyGuards(plan, config, true)).toBe("affected_too_large");
  });

  it("returns disallowed_action_kind for redaction_rule", () => {
    const plan = makePlan({
      actions: [{ kind: "redaction_rule", pattern: "secret" }],
    });
    expect(evaluateAutoApplyGuards(plan, config, true)).toBe("disallowed_action_kind");
  });
});

// ---------------------------------------------------------------------------
// Notifications — drain-once semantics
// ---------------------------------------------------------------------------

describe("passive-correction-notifications — drain-once", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `test-passive-notify-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
  });

  it("drains once then returns empty", async () => {
    await enqueuePassiveCorrectionNotification(tmpDir, {
      planId: "p1",
      summary: "test",
      undoCommand: "remnic correct --revert p1",
      createdAt: new Date().toISOString(),
    });

    const first = await drainPassiveCorrectionNotifications(tmpDir);
    const second = await drainPassiveCorrectionNotifications(tmpDir);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("accumulates multiple notifications", async () => {
    await enqueuePassiveCorrectionNotification(tmpDir, {
      planId: "p1",
      summary: "first",
      undoCommand: "remnic correct --revert p1",
      createdAt: new Date().toISOString(),
    });
    await enqueuePassiveCorrectionNotification(tmpDir, {
      planId: "p2",
      summary: "second",
      undoCommand: "remnic correct --revert p2",
      createdAt: new Date().toISOString(),
    });

    const drained = await drainPassiveCorrectionNotifications(tmpDir);
    expect(drained).toHaveLength(2);
    expect(drained.map((n) => n.planId)).toEqual(["p1", "p2"]);
  });

  it("returns empty when no file exists", async () => {
    const drained = await drainPassiveCorrectionNotifications(tmpDir);
    expect(drained).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

describe("telemetry", () => {
  it("emptyTelemetry returns zeroed counters", () => {
    const t = emptyTelemetry();
    expect(t.detected).toBe(0);
    expect(t.queued).toBe(0);
    expect(t.autoApplied).toBe(0);
    expect(Object.keys(t.suppressedReasons)).toHaveLength(0);
  });
});
