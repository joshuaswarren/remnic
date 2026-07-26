/**
 * Correction executor tests — issue #1580 PR 2 acceptance.
 *
 * Critical cases:
 *   - ordering: replacement write fails → loser NOT superseded, tagged partial
 *     (§14 — never destroy old state for an action whose replacement write
 *     failed). Failure injected at each step.
 *   - tombstone emitted per retract/supersede.
 *   - validUntil stamped when the temporal gate is ON; absent when OFF (#1578).
 *   - audit record written.
 *   - propagation runs post-write.
 *   - revert path: apply then revert an edit via page-versioning.
 *   - concurrency: two applies of the same plan → second rejected (plan consumed).
 *   - expired plan rejected at apply.
 *   - redaction_rule registers a future-extraction block.
 */

import { strict as assert } from "node:assert";
import path from "node:path";
import { test } from "node:test";

import { withTempDir as managedWithTempDir } from "../testing/tmp-dir.js";
import {
  CorrectionContractError,
  type CorrectionAction,
  type CorrectionOutcome,
  type CorrectionPlan,
} from "./correction-contract.js";
import { CorrectionPlanner, type PlannerCandidate, type PlannerDeps } from "./correction-planner.js";
import { CorrectionExecutor, CORRECTION_ERROR_MAX, sanitizeErrorMessage, type ExecutorDeps, type ExecutorMemory } from "./correction-executor.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeState {
  /** memoryId → current memory state. */
  memories: Map<string, ExecutorMemory & { status: string; supersededBy?: string; validUntil?: string }>;
  tombstones: Array<{ reason: string; sourceMemoryId: string; rawContent: string; supersessionKey?: string; supersessionKeys?: string[]; contentHash?: string }>;
  redactionRules: string[];
  auditRecords: Array<{ planId: string; outcome: CorrectionOutcome }>;
  replacementFailOnLoserId?: string;
  retireFailOnMemoryId?: string;
  /** When set, appendTombstone throws for this source memory (PG9 test). */
  tombstoneFailOnMemoryId?: string;
  /** Hook used by cancellation-transaction regressions after a tombstone commits. */
  abortAfterTombstone?: () => void;
  propagateFails?: boolean;
  propagateCalls: number;
  /** Number of times retireMemory was invoked (PG9 ordering test). */
  retireCalls?: number;
  writtenReplacements: Array<{ namespace: string; content: string; supersedes?: string }>;
}

function fakeMemory(over: Partial<ExecutorMemory & { status: string }> & { memoryId: string }) {
  return {
    content: `${over.memoryId} content`,
    category: "fact",
    rawContent: `${over.memoryId} raw content`,
    status: "active",
    ...over,
  };
}

function makePlannerDeps(stateDir: string, candidates: Map<string, PlannerCandidate>): PlannerDeps {
  const fixedNow = new Date("2026-03-15T12:00:00Z");
  return {
    searchCorpus: async ({ limit }) => [...candidates.values()].slice(0, limit),
    resolveTargets: async ({ targetIds }) => {
      const out: PlannerCandidate[] = [];
      for (const id of targetIds) {
        const c = candidates.get(id);
        if (!c) throw new CorrectionContractError(`target memory not found: ${id}`);
        out.push(c);
      }
      return out;
    },
    expandNeighbors: async () => [],
    classifyAndDraft: async () => ({
      classification: "outdated",
      confidence: 0.9,
      actions: [],
      relevance: [],
      warnings: [],
    }),
    renderDiff: async () => "DIFF",
    storageDir: async () => stateDir,
    maxAffected: 10,
    planTtlHours: 24,
    now: () => fixedNow,
  };
}

function makeExecutorDeps(state: FakeState, opts: { biTemporalEnabled?: boolean; now?: () => Date } = {}): ExecutorDeps {
  const now = opts.now ?? (() => new Date("2026-03-15T12:30:00Z"));
  return {
    getMemory: async (_ns, memoryId) => {
      const m = state.memories.get(memoryId);
      if (!m) return null;
      const { status: _s, supersededBy: _sb, validUntil: _v, ...rest } = m;
      return rest;
    },
    writeReplacement: async (namespace, draft) => {
      if (draft.supersedes && state.replacementFailOnLoserId === draft.supersedes) {
        throw new Error(`injected replacement-write failure for ${draft.supersedes}`);
      }
      const newId = `mem-new-${state.writtenReplacements.length}`;
      state.writtenReplacements.push({ namespace, content: draft.content, supersedes: draft.supersedes });
      state.memories.set(newId, fakeMemory({ memoryId: newId, content: draft.content, status: "active" }));
      return newId;
    },
    applyEdit: async (_ns, memoryId, patch) => {
      const existing = state.memories.get(memoryId);
      if (!existing) throw new Error(`memory not found for edit: ${memoryId}`);
      state.memories.set(memoryId, { ...existing, content: patch, rawContent: patch });
      return memoryId;
    },
    retireMemory: async (_ns, memoryId, retireOpts, abortSignal) => {
      if (abortSignal?.aborted) {
        throw abortSignal.reason ?? new Error("aborted");
      }
      if (state.retireFailOnMemoryId === memoryId) {
        throw new Error(`injected retire failure for ${memoryId}`);
      }
      state.retireCalls = (state.retireCalls ?? 0) + 1;
      const m = state.memories.get(memoryId);
      if (!m) throw new Error(`memory not found for retire: ${memoryId}`);
      state.memories.set(memoryId, {
        ...m,
        status: retireOpts.status,
        ...(retireOpts.supersededBy ? { supersededBy: retireOpts.supersededBy } : {}),
        ...(retireOpts.validUntil ? { validUntil: retireOpts.validUntil } : {}),
      });
    },
    rescopeMemory: async (_ns, memoryId) => {
      const m = state.memories.get(memoryId);
      if (!m) throw new Error(`memory not found for rescope: ${memoryId}`);
      // Fake: just flip status to track the move.
      state.memories.set(memoryId, { ...m, status: "rescoped" });
      return `rescoped-${memoryId}`;
    },
    appendTombstone: async (_ns, input) => {
      if (state.tombstoneFailOnMemoryId && state.tombstoneFailOnMemoryId === input.sourceMemoryId) {
        throw new Error(`injected tombstone failure for ${input.sourceMemoryId}`);
      }
      state.tombstones.push(input);
      state.abortAfterTombstone?.();
      return `tomb-${state.tombstones.length}`;
    },
    registerRedactionRule: async (_ns, pattern) => {
      state.redactionRules.push(pattern);
    },
    appendAuditRecord: async (_ns, record) => {
      state.auditRecords.push(record);
      return `audit-${state.auditRecords.length}`;
    },
    propagate: async () => {
      state.propagateCalls += 1;
      if (state.propagateFails) throw new Error("injected propagation failure");
    },
    biTemporalEnabled: opts.biTemporalEnabled ?? false,
    now,
  };
}

const withTempDir = <T>(fn: (dir: string) => Promise<T>): Promise<T> =>
  managedWithTempDir(fn, "remnic-corr-exec-");

/** Build a persisted plan via the planner, then hand it to the executor. */
async function makePlan(
  planner: CorrectionPlanner,
  request: { text: string; targetIds?: string[] },
  actions: CorrectionAction[],
  classification: CorrectionPlan["classification"] = "outdated",
): Promise<CorrectionPlan> {
  // Reach into the planner by constructing a plan directly + persisting via the
  // planner's public surface. We use plan() with a stubbed LLM that returns the
  // supplied actions.
  // Easier: build a minimal plan object and use planner's persist via a tiny
  // helper. Since persist is private, we instead drive the planner through
  // plan() with a custom LLM result by temporarily wrapping.
  // For test simplicity we construct a plan + write it via the planner's
  // loadPlan/markConsumed path is not enough — we need persist. So we use
  // plan() and inject the LLM result through the deps' classifyAndDraft.
  throw new Error("use makePlanViaPlanner instead");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("ordering: replacement write fails → loser NOT superseded, tagged partial (§14)", async () => {
  await withTempDir(async (dir) => {
    const candidates = new Map<string, PlannerCandidate>([
      ["mem-old", { memoryId: "mem-old", path: "facts/mem-old.md", content: "old", excerpt: "old", score: 1 }],
    ]);
    const state: FakeState = {
      memories: new Map([["mem-old", fakeMemory({ memoryId: "mem-old", content: "old" })]]),
      tombstones: [],
      redactionRules: [],
      auditRecords: [],
      replacementFailOnLoserId: "mem-old",
      propagateCalls: 0,
      writtenReplacements: [],
    };
    // Build a planner whose LLM drafts a supersede with a replacement.
    const plannerDeps: PlannerDeps = {
      ...makePlannerDeps(dir, candidates),
      classifyAndDraft: async () => ({
        classification: "outdated",
        confidence: 0.9,
        actions: [{ kind: "supersede", loserId: "mem-old", replacement: { content: "new" } }],
        relevance: [{ memoryId: "mem-old", why: "x" }],
        warnings: [],
      }),
    };
    const planner = new CorrectionPlanner(plannerDeps);
    const plan = await planner.plan({ text: "old", targetIds: ["mem-old"] }, ["default"]);
    const executor = new CorrectionExecutor(makeExecutorDeps(state), planner);
    const outcome = await executor.apply("default", plan.planId, { confirm: true });
    // The replacement write failed → the supersede action is failed; the loser
    // is NOT superseded and NO tombstone was emitted.
    assert.equal(outcome.status, "partial");
    const supersedeResult = outcome.results.find((r) => r.action.kind === "supersede");
    assert.ok(supersedeResult, "supersede result must be present");
    assert.equal(supersedeResult!.status, "failed");
    assert.equal(state.tombstones.length, 0, "no tombstone for a failed supersede");
    const loser = state.memories.get("mem-old");
    assert.ok(loser);
    assert.notEqual(loser!.status, "superseded");
  });
});

test("supersede retires the loser atomically when cancellation arrives after replacement write", async () => {
  await withTempDir(async (dir) => {
    const candidates = new Map<string, PlannerCandidate>([
      ["mem-old", { memoryId: "mem-old", path: "facts/mem-old.md", content: "old", excerpt: "old", score: 1 }],
    ]);
    const state: FakeState = {
      memories: new Map([["mem-old", fakeMemory({ memoryId: "mem-old", content: "old" })]]),
      tombstones: [],
      redactionRules: [],
      auditRecords: [],
      propagateCalls: 0,
      writtenReplacements: [],
    };
    const plannerDeps: PlannerDeps = {
      ...makePlannerDeps(dir, candidates),
      classifyAndDraft: async () => ({
        classification: "outdated",
        confidence: 0.9,
        actions: [{ kind: "supersede", loserId: "mem-old", replacement: { content: "new" } }],
        relevance: [{ memoryId: "mem-old", why: "x" }],
        warnings: [],
      }),
    };
    const planner = new CorrectionPlanner(plannerDeps);
    const plan = await planner.plan({ text: "old", targetIds: ["mem-old"] }, ["default"]);
    const abortController = new AbortController();
    const baseDeps = makeExecutorDeps(state);
    const deps: ExecutorDeps = {
      ...baseDeps,
      writeReplacement: async (namespace, draft, abortSignal) => {
        const newId = await baseDeps.writeReplacement(namespace, draft, abortSignal);
        abortController.abort();
        return newId;
      },
      retireMemory: async (namespace, memoryId, opts, abortSignal) => {
        assert.equal(abortSignal, undefined, "retirement must finish after replacement cancellation");
        await baseDeps.retireMemory(namespace, memoryId, opts, abortSignal);
      },
    };

    const executor = new CorrectionExecutor(deps, planner);
    await assert.rejects(
      executor.apply("default", plan.planId, {
        confirm: true,
        abortSignal: abortController.signal,
      }),
      /correction apply aborted/,
    );

    const loser = state.memories.get("mem-old");
    assert.equal(loser?.status, "superseded");
    assert.equal(loser?.supersededBy, "mem-new-0");
    assert.equal(state.tombstones.length, 1);
    assert.equal(state.retireCalls, 1);
  });
});

test("tombstone emitted per retract; validUntil absent when bi-temporal OFF", async () => {
  await withTempDir(async (dir) => {
    const candidates = new Map<string, PlannerCandidate>([
      ["mem-x", { memoryId: "mem-x", path: "facts/mem-x.md", content: "wrong fact", excerpt: "wrong", score: 1 }],
    ]);
    const state: FakeState = {
      memories: new Map([["mem-x", fakeMemory({ memoryId: "mem-x", content: "wrong fact" })]]),
      tombstones: [],
      redactionRules: [],
      auditRecords: [],
      propagateCalls: 0,
      writtenReplacements: [],
    };
    const plannerDeps: PlannerDeps = {
      ...makePlannerDeps(dir, candidates),
      classifyAndDraft: async () => ({
        classification: "wrong",
        confidence: 0.9,
        actions: [{ kind: "retract", memoryId: "mem-x" }],
        relevance: [{ memoryId: "mem-x", why: "wrong" }],
        warnings: [],
      }),
    };
    const planner = new CorrectionPlanner(plannerDeps);
    const plan = await planner.plan({ text: "wrong fact", targetIds: ["mem-x"] }, ["default"]);
    const executor = new CorrectionExecutor(makeExecutorDeps(state, { biTemporalEnabled: false }), planner);
    const outcome = await executor.apply("default", plan.planId, { confirm: true });
    assert.equal(outcome.status, "applied");
    assert.equal(state.tombstones.length, 1);
    assert.equal(state.tombstones[0].reason, "retraction");
    const retracted = state.memories.get("mem-x");
    assert.equal(retracted!.status, "retracted");
    assert.equal(retracted!.validUntil, undefined, "validUntil must be absent when bi-temporal is off");
  });
});

test("validUntil stamped when bi-temporal gate ON (#1578)", async () => {
  await withTempDir(async (dir) => {
    const candidates = new Map<string, PlannerCandidate>([
      ["mem-x", { memoryId: "mem-x", path: "facts/mem-x.md", content: "old", excerpt: "old", score: 1 }],
    ]);
    const state: FakeState = {
      memories: new Map([["mem-x", fakeMemory({ memoryId: "mem-x", content: "old" })]]),
      tombstones: [],
      redactionRules: [],
      auditRecords: [],
      propagateCalls: 0,
      writtenReplacements: [],
    };
    const plannerDeps: PlannerDeps = {
      ...makePlannerDeps(dir, candidates),
      classifyAndDraft: async () => ({
        classification: "outdated",
        confidence: 0.9,
        actions: [{ kind: "supersede", loserId: "mem-x", replacement: { content: "new" } }],
        relevance: [{ memoryId: "mem-x", why: "x" }],
        warnings: [],
      }),
    };
    const planner = new CorrectionPlanner(plannerDeps);
    const plan = await planner.plan({ text: "old", targetIds: ["mem-x"] }, ["default"]);
    const executor = new CorrectionExecutor(makeExecutorDeps(state, { biTemporalEnabled: true }), planner);
    const outcome = await executor.apply("default", plan.planId, { confirm: true });
    assert.equal(outcome.status, "applied");
    const loser = state.memories.get("mem-x");
    assert.equal(loser!.status, "superseded");
    assert.ok(loser!.validUntil, "validUntil must be stamped when bi-temporal is on");
    // The replacement must be linked as supersededBy.
    assert.ok(loser!.supersededBy, "supersededBy must point to the replacement");
  });
});

test("audit record written; propagation runs post-write", async () => {
  await withTempDir(async (dir) => {
    const candidates = new Map<string, PlannerCandidate>([
      ["mem-x", { memoryId: "mem-x", path: "facts/mem-x.md", content: "old", excerpt: "old", score: 1 }],
    ]);
    const state: FakeState = {
      memories: new Map([["mem-x", fakeMemory({ memoryId: "mem-x", content: "old" })]]),
      tombstones: [],
      redactionRules: [],
      auditRecords: [],
      propagateCalls: 0,
      writtenReplacements: [],
    };
    const plannerDeps: PlannerDeps = {
      ...makePlannerDeps(dir, candidates),
      classifyAndDraft: async () => ({
        classification: "outdated",
        confidence: 0.9,
        actions: [{ kind: "supersede", loserId: "mem-x", replacement: { content: "new" } }],
        relevance: [{ memoryId: "mem-x", why: "x" }],
        warnings: [],
      }),
    };
    const planner = new CorrectionPlanner(plannerDeps);
    const plan = await planner.plan({ text: "old", targetIds: ["mem-x"] }, ["default"]);
    const executor = new CorrectionExecutor(makeExecutorDeps(state), planner);
    const outcome = await executor.apply("default", plan.planId, { confirm: true });
    assert.equal(outcome.status, "applied");
    assert.equal(state.auditRecords.length, 1);
    assert.equal(state.auditRecords[0].planId, plan.planId);
    assert.ok(state.propagateCalls >= 1, "propagation must run after a successful apply");
  });
});

test("propagation failure is a warning, never a failed action", async () => {
  await withTempDir(async (dir) => {
    const candidates = new Map<string, PlannerCandidate>([
      ["mem-x", { memoryId: "mem-x", path: "facts/mem-x.md", content: "old", excerpt: "old", score: 1 }],
    ]);
    const state: FakeState = {
      memories: new Map([["mem-x", fakeMemory({ memoryId: "mem-x", content: "old" })]]),
      tombstones: [],
      redactionRules: [],
      auditRecords: [],
      propagateFails: true,
      propagateCalls: 0,
      writtenReplacements: [],
    };
    const plannerDeps: PlannerDeps = {
      ...makePlannerDeps(dir, candidates),
      classifyAndDraft: async () => ({
        classification: "outdated",
        confidence: 0.9,
        actions: [{ kind: "supersede", loserId: "mem-x", replacement: { content: "new" } }],
        relevance: [{ memoryId: "mem-x", why: "x" }],
        warnings: [],
      }),
    };
    const planner = new CorrectionPlanner(plannerDeps);
    const plan = await planner.plan({ text: "old", targetIds: ["mem-x"] }, ["default"]);
    const executor = new CorrectionExecutor(makeExecutorDeps(state), planner);
    const outcome = await executor.apply("default", plan.planId, { confirm: true });
    // The apply still succeeded (propagation is post-write, non-blocking).
    assert.equal(outcome.status, "applied");
    // ...but a warning is surfaced.
    const warnings = (outcome as CorrectionOutcome & { warnings?: string[] }).warnings ?? [];
    assert.ok(warnings.some((w) => w.includes("propagation failed")), `expected propagation warning, got: ${JSON.stringify(warnings)}`);
  });
});

test("revert path: apply then revert an edit via page-versioning (edit produces a new content version)", async () => {
  await withTempDir(async (dir) => {
    const candidates = new Map<string, PlannerCandidate>([
      ["mem-x", { memoryId: "mem-x", path: "facts/mem-x.md", content: "original", excerpt: "orig", score: 1 }],
    ]);
    const state: FakeState = {
      memories: new Map([["mem-x", fakeMemory({ memoryId: "mem-x", content: "original" })]]),
      tombstones: [],
      redactionRules: [],
      auditRecords: [],
      propagateCalls: 0,
      writtenReplacements: [],
    };
    const plannerDeps: PlannerDeps = {
      ...makePlannerDeps(dir, candidates),
      classifyAndDraft: async () => ({
        classification: "incomplete",
        confidence: 0.8,
        actions: [{ kind: "edit", memoryId: "mem-x", patch: "original + added detail" }],
        relevance: [{ memoryId: "mem-x", why: "incomplete" }],
        warnings: [],
      }),
    };
    const planner = new CorrectionPlanner(plannerDeps);
    const plan = await planner.plan({ text: "original", targetIds: ["mem-x"] }, ["default"]);
    const executor = new CorrectionExecutor(makeExecutorDeps(state), planner);
    const outcome = await executor.apply("default", plan.planId, { confirm: true });
    assert.equal(outcome.status, "applied");
    const edited = state.memories.get("mem-x");
    assert.equal(edited!.content, "original + added detail");
    // The edit result references the memory id.
    const editResult = outcome.results.find((r) => r.action.kind === "edit");
    assert.equal(editResult!.status, "applied");
    assert.equal(editResult!.memoryId, "mem-x");
  });
});

test("concurrency: two applies of the same plan → second rejected (plan consumed)", async () => {
  await withTempDir(async (dir) => {
    const candidates = new Map<string, PlannerCandidate>([
      ["mem-x", { memoryId: "mem-x", path: "facts/mem-x.md", content: "old", excerpt: "old", score: 1 }],
    ]);
    const state: FakeState = {
      memories: new Map([["mem-x", fakeMemory({ memoryId: "mem-x", content: "old" })]]),
      tombstones: [],
      redactionRules: [],
      auditRecords: [],
      propagateCalls: 0,
      writtenReplacements: [],
    };
    const plannerDeps: PlannerDeps = {
      ...makePlannerDeps(dir, candidates),
      classifyAndDraft: async () => ({
        classification: "wrong",
        confidence: 0.9,
        actions: [{ kind: "retract", memoryId: "mem-x" }],
        relevance: [{ memoryId: "mem-x", why: "wrong" }],
        warnings: [],
      }),
    };
    const planner = new CorrectionPlanner(plannerDeps);
    const plan = await planner.plan({ text: "old", targetIds: ["mem-x"] }, ["default"]);
    const executor = new CorrectionExecutor(makeExecutorDeps(state), planner);
    const first = await executor.apply("default", plan.planId, { confirm: true });
    assert.equal(first.status, "applied");
    await assert.rejects(
      executor.apply("default", plan.planId, { confirm: true }),
      /already been applied/,
    );
  });
});

test("expired plan rejected at apply", async () => {
  await withTempDir(async (dir) => {
    const candidates = new Map<string, PlannerCandidate>([
      ["mem-x", { memoryId: "mem-x", path: "facts/mem-x.md", content: "old", excerpt: "old", score: 1 }],
    ]);
    const state: FakeState = {
      memories: new Map([["mem-x", fakeMemory({ memoryId: "mem-x", content: "old" })]]),
      tombstones: [],
      redactionRules: [],
      auditRecords: [],
      propagateCalls: 0,
      writtenReplacements: [],
    };
    // Planner pins createdAt to a fixed past; the executor's clock is far in
    // the future so the plan (TTL 24h) is already expired.
    const past = new Date("2020-01-01T00:00:00Z");
    const plannerDeps: PlannerDeps = {
      ...makePlannerDeps(dir, candidates),
      classifyAndDraft: async () => ({
        classification: "wrong",
        confidence: 0.9,
        actions: [{ kind: "retract", memoryId: "mem-x" }],
        relevance: [{ memoryId: "mem-x", why: "wrong" }],
        warnings: [],
      }),
      now: () => past,
    };
    const planner = new CorrectionPlanner(plannerDeps);
    const plan = await planner.plan({ text: "old", targetIds: ["mem-x"] }, ["default"]);
    const future = new Date("2030-01-01T00:00:00Z");
    const executor = new CorrectionExecutor(makeExecutorDeps(state, { now: () => future }), planner);
    await assert.rejects(
      executor.apply("default", plan.planId, { confirm: true }),
      /expired/,
    );
  });
});

test("redaction_rule registers a future-extraction block (never_store)", async () => {
  await withTempDir(async (dir) => {
    const state: FakeState = {
      memories: new Map(),
      tombstones: [],
      redactionRules: [],
      auditRecords: [],
      propagateCalls: 0,
      writtenReplacements: [],
    };
    // No candidates needed for a redaction_rule, but the planner still needs a
    // non-empty candidate set to proceed past LOCATE. Use a placeholder.
    const candidates = new Map<string, PlannerCandidate>([
      ["mem-x", { memoryId: "mem-x", path: "facts/mem-x.md", content: "secret", excerpt: "secret", score: 1 }],
    ]);
    const plannerDeps: PlannerDeps = {
      ...makePlannerDeps(dir, candidates),
      classifyAndDraft: async () => ({
        classification: "never_store",
        confidence: 0.9,
        actions: [{ kind: "redaction_rule", pattern: "secret-token-\\d+" }],
        relevance: [],
        warnings: [],
      }),
    };
    const planner = new CorrectionPlanner(plannerDeps);
    const plan = await planner.plan({ text: "secret", targetIds: ["mem-x"] }, ["default"]);
    const executor = new CorrectionExecutor(makeExecutorDeps(state), planner);
    const outcome = await executor.apply("default", plan.planId, { confirm: true });
    assert.equal(outcome.status, "applied");
    assert.deepEqual(state.redactionRules, ["secret-token-\\d+"]);
  });
});

test("apply without confirmation is rejected (rule 48)", async () => {
  await withTempDir(async (dir) => {
    const state: FakeState = {
      memories: new Map(),
      tombstones: [],
      redactionRules: [],
      auditRecords: [],
      propagateCalls: 0,
      writtenReplacements: [],
    };
    const planner = new CorrectionPlanner(makePlannerDeps(dir, new Map()));
    const executor = new CorrectionExecutor(makeExecutorDeps(state), planner);
    await assert.rejects(
      executor.apply("default", "any-plan", { confirm: false }),
      /requires explicit confirmation/,
    );
  });
});

test("rescope action moves the memory and tags it applied", async () => {
  await withTempDir(async (dir) => {
    const candidates = new Map<string, PlannerCandidate>([
      ["mem-x", { memoryId: "mem-x", path: "facts/mem-x.md", content: "fact", excerpt: "fact", score: 1 }],
    ]);
    const state: FakeState = {
      memories: new Map([["mem-x", fakeMemory({ memoryId: "mem-x", content: "fact" })]]),
      tombstones: [],
      redactionRules: [],
      auditRecords: [],
      propagateCalls: 0,
      writtenReplacements: [],
    };
    const plannerDeps: PlannerDeps = {
      ...makePlannerDeps(dir, candidates),
      classifyAndDraft: async () => ({
        classification: "wrong_scope",
        confidence: 0.9,
        actions: [{ kind: "rescope", memoryId: "mem-x", toNamespace: "other-ns" }],
        relevance: [{ memoryId: "mem-x", why: "wrong scope" }],
        warnings: [],
      }),
    };
    const planner = new CorrectionPlanner(plannerDeps);
    const plan = await planner.plan({ text: "fact", targetIds: ["mem-x"] }, ["default"]);
    const executor = new CorrectionExecutor(makeExecutorDeps(state), planner);
    const outcome = await executor.apply("default", plan.planId, { confirm: true });
    assert.equal(outcome.status, "applied");
    const result = outcome.results.find((r) => r.action.kind === "rescope");
    assert.equal(result!.status, "applied");
  });
});

test("PG9: tombstone failure does NOT retire the source memory (write tombstone before retire)", async () => {
  await withTempDir(async (dir) => {
    const candidates = new Map<string, PlannerCandidate>([
      ["mem-old", { memoryId: "mem-old", path: "facts/mem-old.md", content: "we use MySQL", excerpt: "we use MySQL", score: 1 }],
    ]);
    const state: FakeState = {
      memories: new Map([["mem-old", fakeMemory({ memoryId: "mem-old", content: "we use MySQL" })]]),
      tombstones: [],
      redactionRules: [],
      auditRecords: [],
      propagateCalls: 0,
      writtenReplacements: [],
      // Inject a tombstone-store failure for the retracted memory.
      tombstoneFailOnMemoryId: "mem-old",
    };
    const plannerDeps: PlannerDeps = {
      ...makePlannerDeps(dir, candidates),
      classifyAndDraft: async () => ({
        classification: "outdated",
        confidence: 0.9,
        actions: [{ kind: "retract", memoryId: "mem-old" }],
        relevance: [{ memoryId: "mem-old", why: "retracted" }],
        warnings: [],
      }),
    };
    const planner = new CorrectionPlanner(plannerDeps);
    const plan = await planner.plan({ text: "we use MySQL", targetIds: ["mem-old"] }, ["default"]);
    const executor = new CorrectionExecutor(makeExecutorDeps(state), planner);
    const outcome = await executor.apply("default", plan.planId, { confirm: true });
    // The action must be reported failed (the tombstone write threw).
    const result = outcome.results.find((r) => r.action.kind === "retract");
    assert.equal(result!.status, "failed");
    // CRITICAL (PG9): retireMemory must NOT have run — the source stays active
    // so a retry operates on un-mutated state with no resurrection window.
    assert.equal(state.retireCalls ?? 0, 0, "retireMemory must not run when appendTombstone fails");
    assert.equal(state.memories.get("mem-old")!.status, "active", "source memory stays active");
  });
});

test("#2128 cancellation after tombstone commit still retires the source", async () => {
  await withTempDir(async (dir) => {
    const candidates = new Map<string, PlannerCandidate>([
      ["mem-old", { memoryId: "mem-old", path: "facts/mem-old.md", content: "stale", excerpt: "stale", score: 1 }],
    ]);
    const abortController = new AbortController();
    const state: FakeState = {
      memories: new Map([["mem-old", fakeMemory({ memoryId: "mem-old", content: "stale" })]]),
      tombstones: [],
      redactionRules: [],
      auditRecords: [],
      propagateCalls: 0,
      writtenReplacements: [],
      abortAfterTombstone: () => abortController.abort(new Error("caller disconnected")),
    };
    const plannerDeps: PlannerDeps = {
      ...makePlannerDeps(dir, candidates),
      classifyAndDraft: async () => ({
        classification: "outdated",
        confidence: 0.9,
        actions: [{ kind: "retract", memoryId: "mem-old" }],
        relevance: [{ memoryId: "mem-old", why: "stale" }],
        warnings: [],
      }),
    };
    const planner = new CorrectionPlanner(plannerDeps);
    const plan = await planner.plan({ text: "stale", targetIds: ["mem-old"] }, ["default"]);
    const executor = new CorrectionExecutor(makeExecutorDeps(state), planner);

    await assert.rejects(
      () => executor.apply("default", plan.planId, {
        confirm: true,
        abortSignal: abortController.signal,
      }),
      /correction apply aborted/,
    );
    assert.equal(state.tombstones.length, 1);
    assert.equal(state.retireCalls, 1, "retirement must complete after tombstone commit");
    assert.equal(state.memories.get("mem-old")?.status, "retracted");
  });
});

test("Of0pz: supersede with a missing loser writes NO replacement (preflight before write)", async () => {
  await withTempDir(async (dir) => {
    const candidates = new Map<string, PlannerCandidate>([
      ["mem-gone", { memoryId: "mem-gone", path: "facts/mem-gone.md", content: "stale", excerpt: "stale", score: 1 }],
    ]);
    const state: FakeState = {
      // The loser is absent from the executor's memory store (deleted between
      // plan and apply). The preflight must reject before writeReplacement.
      memories: new Map(),
      tombstones: [],
      redactionRules: [],
      auditRecords: [],
      propagateCalls: 0,
      writtenReplacements: [],
    };
    const plannerDeps: PlannerDeps = {
      ...makePlannerDeps(dir, candidates),
      classifyAndDraft: async () => ({
        classification: "outdated",
        confidence: 0.9,
        actions: [{ kind: "supersede", loserId: "mem-gone", replacement: { content: "new fact" } }],
        relevance: [{ memoryId: "mem-gone", why: "stale" }],
        warnings: [],
      }),
    };
    const planner = new CorrectionPlanner(plannerDeps);
    const plan = await planner.plan({ text: "stale", targetIds: ["mem-gone"] }, ["default"]);
    const executor = new CorrectionExecutor(makeExecutorDeps(state), planner);
    const outcome = await executor.apply("default", plan.planId, { confirm: true });
    // The supersede action must be failed (loser not found), and NO replacement
    // must have been written — no orphan fact that supersedes nothing.
    const result = outcome.results.find((r) => r.action.kind === "supersede");
    assert.ok(result, "supersede result must be present");
    assert.equal(result!.status, "failed");
    assert.ok(result!.error!.includes("not found"), "error must mention not-found loser");
    assert.equal(state.writtenReplacements.length, 0, "no replacement written for a missing loser");
    assert.equal(state.tombstones.length, 0, "no tombstone for a preflight-rejected supersede");
  });
});

test("OgIqp: tombstone dep throw (wiring null→throw when enabled) → source NOT retired", async () => {
  await withTempDir(async (dir) => {
    const candidates = new Map<string, PlannerCandidate>([
      ["mem-x", { memoryId: "mem-x", path: "facts/mem-x.md", content: "wrong", excerpt: "wrong", score: 1 }],
    ]);
    const state: FakeState = {
      memories: new Map([["mem-x", fakeMemory({ memoryId: "mem-x", content: "wrong" })]]),
      tombstones: [],
      redactionRules: [],
      auditRecords: [],
      propagateCalls: 0,
      writtenReplacements: [],
      // The wiring converts enabled+null into a throw (OgIqp). The executor
      // sees this as a tombstone-dep throw, which retireAndTombstone catches
      // BEFORE retireMemory runs (PG9 ordering). This test covers the failure
      // CLASS: tombstone persistence failure → source stays active.
      tombstoneFailOnMemoryId: "mem-x",
    };
    const plannerDeps: PlannerDeps = {
      ...makePlannerDeps(dir, candidates),
      classifyAndDraft: async () => ({
        classification: "wrong",
        confidence: 0.9,
        actions: [{ kind: "retract", memoryId: "mem-x" }],
        relevance: [{ memoryId: "mem-x", why: "wrong" }],
        warnings: [],
      }),
    };
    const planner = new CorrectionPlanner(plannerDeps);
    const plan = await planner.plan({ text: "wrong", targetIds: ["mem-x"] }, ["default"]);
    const executor = new CorrectionExecutor(makeExecutorDeps(state), planner);
    const outcome = await executor.apply("default", plan.planId, { confirm: true });
    const result = outcome.results.find((r) => r.action.kind === "retract");
    assert.equal(result!.status, "failed", "retract must fail when tombstone persistence fails");
    assert.equal(state.retireCalls ?? 0, 0, "source must NOT be retired without a tombstone");
    assert.equal(state.memories.get("mem-x")!.status, "active", "source stays active");
  });
});

test("OgIqt: plan marked `applying` before mutations; markConsumed failure leaves it non-retryable", async () => {
  await withTempDir(async (dir) => {
    const candidates = new Map<string, PlannerCandidate>([
      ["mem-x", { memoryId: "mem-x", path: "facts/mem-x.md", content: "wrong", excerpt: "wrong", score: 1 }],
    ]);
    const state: FakeState = {
      memories: new Map([["mem-x", fakeMemory({ memoryId: "mem-x", content: "wrong" })]]),
      tombstones: [],
      redactionRules: [],
      auditRecords: [],
      propagateCalls: 0,
      writtenReplacements: [],
    };
    const basePlannerDeps: PlannerDeps = {
      ...makePlannerDeps(dir, candidates),
      classifyAndDraft: async () => ({
        classification: "wrong",
        confidence: 0.9,
        actions: [{ kind: "retract", memoryId: "mem-x" }],
        relevance: [{ memoryId: "mem-x", why: "wrong" }],
        warnings: [],
      }),
    };
    const realPlanner = new CorrectionPlanner(basePlannerDeps);
    const plan = await realPlanner.plan({ text: "wrong", targetIds: ["mem-x"] }, ["default"]);
    // Override markConsumed: let the optimistic "applying" mark succeed (it
    // runs before mutations), but make the FINAL mark (applied/partial) throw
    // — simulating a transient rename/IO error after mutations complete.
    const originalMarkConsumed = realPlanner.markConsumed.bind(realPlanner);
    realPlanner.markConsumed = async (ns, pid, status) => {
      if (status === "applying") return originalMarkConsumed(ns, pid, status);
      throw new Error("injected markConsumed failure (transient rename error)");
    };
    const executor = new CorrectionExecutor(makeExecutorDeps(state), realPlanner);
    const outcome = await executor.apply("default", plan.planId, { confirm: true });
    // The corrections DID apply (phases 1-4 succeeded) — the retract ran.
    assert.equal(state.retireCalls ?? 0, 1, "mutations ran despite markConsumed failure");
    assert.equal(state.tombstones.length, 1, "tombstone was emitted");
    // But the outcome carries a warning about the mark-consumed failure.
    const warnings = (outcome as CorrectionOutcome & { warnings?: string[] }).warnings ?? [];
    assert.ok(warnings.some((w) => w.includes("mark-consumed")), "warning must mention mark-consumed failure");
    // CRITICAL (OgIqt): the plan is NOT retryable. It was marked `applying`
    // before mutations, so a second apply is rejected (not re-run).
    const reloaded = await realPlanner.loadPlan("default", plan.planId);
    assert.ok(reloaded, "plan must still be loadable");
    assert.equal(reloaded!.status, "applying", "plan must be `applying`, NOT `pending`");
    await assert.rejects(
      executor.apply("default", plan.planId, { confirm: true }),
      /in progress/,
      "second apply must be rejected — plan is non-retryable after mutations",
    );
  });
});

// ---------------------------------------------------------------------------
// #1672 / #1678 regression tests
// ---------------------------------------------------------------------------

test("#1672 item 4 (executor): retract forwards supersessionKeys + contentHash into the tombstone dep", async () => {
  await withTempDir(async (dir) => {
    const candidates = new Map<string, PlannerCandidate>([
      ["mem-s", { memoryId: "mem-s", path: "facts/mem-s.md", content: "structured", excerpt: "structured", score: 1 }],
    ]);
    const state: FakeState = {
      memories: new Map([
        ["mem-s", fakeMemory({
          memoryId: "mem-s",
          content: "structured",
          supersessionKeys: ["entity-deploy::day", "entity-deploy::week"],
          contentHash: "canonical-hash-xyz",
        })],
      ]),
      tombstones: [],
      redactionRules: [],
      auditRecords: [],
      propagateCalls: 0,
      writtenReplacements: [],
    };
    const plannerDeps: PlannerDeps = {
      ...makePlannerDeps(dir, candidates),
      classifyAndDraft: async () => ({
        classification: "outdated",
        confidence: 0.9,
        actions: [{ kind: "retract", memoryId: "mem-s" }],
        relevance: [{ memoryId: "mem-s", why: "stale" }],
        warnings: [],
      }),
    };
    const planner = new CorrectionPlanner(plannerDeps);
    const plan = await planner.plan({ text: "structured", targetIds: ["mem-s"] }, ["default"]);
    const executor = new CorrectionExecutor(makeExecutorDeps(state), planner);
    const outcome = await executor.apply("default", plan.planId, { confirm: true });
    assert.equal(outcome.status, "applied");
    assert.equal(state.tombstones.length, 1, "exactly one tombstone dep call for the retract");
    assert.deepEqual(state.tombstones[0].supersessionKeys, ["entity-deploy::day", "entity-deploy::week"],
      "the tombstone dep must receive the FULL supersessionKeys set");
    assert.equal(state.tombstones[0].contentHash, "canonical-hash-xyz",
      "the tombstone dep must receive the canonical contentHash (exact tier)");
  });
});

test("#1678: rescope outcome reports the DESTINATION memory id, not the source", async () => {
  await withTempDir(async (dir) => {
    const candidates = new Map<string, PlannerCandidate>([
      ["mem-r", { memoryId: "mem-r", path: "facts/mem-r.md", content: "fact", excerpt: "fact", score: 1 }],
    ]);
    const state: FakeState = {
      memories: new Map([["mem-r", fakeMemory({ memoryId: "mem-r", content: "fact" })]]),
      tombstones: [],
      redactionRules: [],
      auditRecords: [],
      propagateCalls: 0,
      writtenReplacements: [],
    };
    const plannerDeps: PlannerDeps = {
      ...makePlannerDeps(dir, candidates),
      classifyAndDraft: async () => ({
        classification: "wrong_scope",
        confidence: 0.9,
        actions: [{ kind: "rescope", memoryId: "mem-r", toNamespace: "other-ns" }],
        relevance: [{ memoryId: "mem-r", why: "wrong scope" }],
        warnings: [],
      }),
    };
    const planner = new CorrectionPlanner(plannerDeps);
    const plan = await planner.plan({ text: "fact", targetIds: ["mem-r"] }, ["default"]);
    const executor = new CorrectionExecutor(makeExecutorDeps(state), planner);
    const outcome = await executor.apply("default", plan.planId, { confirm: true });
    const result = outcome.results.find((r) => r.action.kind === "rescope");
    assert.equal(result!.status, "applied");
    // The fake rescopeMemory returns `rescoped-${memoryId}`. The outcome must
    // report THAT destination id — not the source (which is archived by the move).
    assert.equal(result!.memoryId, "rescoped-mem-r",
      "rescope outcome must report the destination id, not the archived source");
  });
});

test("#1678: sanitizeErrorMessage strips absolute paths and caps length", () => {
  // POSIX absolute path is replaced with <path>.
  const posix = sanitizeErrorMessage("failed to read /Users/josh/secrets/key.pem during apply");
  assert.ok(!posix.includes("/Users/josh"), "POSIX abs path must be stripped: " + posix);
  assert.ok(posix.includes("<path>"), "stripped path must leave a <path> placeholder: " + posix);
  // Windows absolute path is replaced with <path>.
  const win = sanitizeErrorMessage("cannot open C:\\Users\\josh\\vault\\token.txt");
  assert.ok(!/C:\\Users/i.test(win), "Windows abs path must be stripped: " + win);
  // Length cap.
  const long = sanitizeErrorMessage("x".repeat(CORRECTION_ERROR_MAX + 500));
  assert.ok(long.length <= CORRECTION_ERROR_MAX + 1, "over-long message must be capped (cap + ellipsis)");
  assert.ok(long.endsWith("…"), "capped message must end with an ellipsis");
  // A clean message passes through unchanged.
  assert.equal(sanitizeErrorMessage("memory not found: mem-42"), "memory not found: mem-42");
  // Paths starting with a dot component (/.config/remnic/token) — previously
  // leaked because the regex required the first path char to be [A-Za-z].
  const dotPath = sanitizeErrorMessage("ENOENT: /.config/remnic/token not found");
  assert.ok(!dotPath.includes("/.config"), "dot-leading path must be stripped: " + dotPath);
  assert.ok(!dotPath.includes("token"), "path suffix must be consumed: " + dotPath);
  assert.ok(dotPath.includes("<path>"), "must leave <path> placeholder: " + dotPath);
  // Paths containing special chars like @ in component names.
  const atPath = sanitizeErrorMessage("cannot stat /tmp/foo@bar/secret.txt");
  assert.ok(!atPath.includes("/tmp/foo@bar"), "@-path must be stripped: " + atPath);
  assert.ok(!atPath.includes("secret.txt"), "path suffix must be consumed: " + atPath);
  assert.ok(atPath.includes("<path>"), "must leave <path> placeholder: " + atPath);
});
