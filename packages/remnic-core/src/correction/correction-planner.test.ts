/**
 * Correction planner tests — issue #1580 PR 1 acceptance.
 *
 * Covers:
 *   - explicit-target plan
 *   - search-located plan
 *   - not-found target → explicit error (rule 34)
 *   - LLM classify success per classification class (stubbed adapter, rule 33)
 *   - LLM failure → deterministic fallback plan (rule 13)
 *   - plan persists atomically and expires
 *   - bulk guard: > maxAffected refuses (§39)
 */

import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  CorrectionContractError,
  type CorrectionAction,
  type CorrectionClassification,
  type CorrectionPlan,
} from "./correction-contract.js";
import { CorrectionPlanner, type LlmClassificationResult, type PlannerCandidate, type PlannerDeps } from "./correction-planner.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface StubState {
  candidatesById: Map<string, PlannerCandidate>;
  llmResult: LlmClassificationResult | ((text: string, candidates: PlannerCandidate[]) => LlmClassificationResult);
  writeReplacementCalls: number;
  propagateCalls: number;
  retireCalls: number;
}

function makeCandidate(over: Partial<PlannerCandidate> & { memoryId: string }): PlannerCandidate {
  return {
    path: `facts/${over.memoryId}.md`,
    content: `${over.memoryId} content`,
    excerpt: `${over.memoryId} excerpt`,
    score: 1.0,
    ...over,
  };
}

function makeDeps(stateDir: string, state: StubState, opts: { maxAffected?: number; planTtlHours?: number } = {}): PlannerDeps {
  const fixedNow = new Date("2026-03-15T12:00:00Z");
  return {
    searchCorpus: async ({ text, namespaces, limit }) => {
      // Simple stub: return candidates whose content contains the text.
      const all = [...state.candidatesById.values()];
      const matched = all.filter((c) => c.content.includes(text) || text.includes(c.memoryId));
      return matched.slice(0, limit).map((c, i) => ({ ...c, score: 1 - i * 0.1 }));
    },
    resolveTargets: async ({ targetIds }) => {
      const out: PlannerCandidate[] = [];
      const missing: string[] = [];
      for (const id of targetIds) {
        const c = state.candidatesById.get(id);
        if (c) out.push(c);
        else missing.push(id);
      }
      if (missing.length > 0) {
        throw new CorrectionContractError(`target memory not found: ${missing[0]}`);
      }
      return out;
    },
    expandNeighbors: async ({ seedIds }) => {
      // No neighbors in the stub; return the seeds themselves so neighbor
      // expansion is exercised but produces no surprises.
      return seedIds.map((id) => state.candidatesById.get(id)).filter((c): c is PlannerCandidate => c !== undefined);
    },
    classifyAndDraft: async ({ text, candidates }) => {
      return typeof state.llmResult === "function"
        ? state.llmResult(text, candidates)
        : state.llmResult;
    },
    renderDiff: async ({ actions }) => `DIFF(${actions.length} actions)`,
    storageDir: async () => stateDir,
    maxAffected: opts.maxAffected ?? 10,
    planTtlHours: opts.planTtlHours ?? 24,
    now: () => fixedNow,
  };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-corr-plan-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("explicit-target plan: targetIds resolve directly and the plan records them", async () => {
  await withTempDir(async (dir) => {
    const state: StubState = {
      candidatesById: new Map([
        ["mem-postgres", makeCandidate({ memoryId: "mem-postgres", content: "User prefers PostgreSQL" })],
      ]),
      llmResult: {
        classification: "outdated",
        confidence: 0.9,
        actions: [{ kind: "supersede", loserId: "mem-postgres", replacement: { content: "User prefers MySQL" } }],
        relevance: [{ memoryId: "mem-postgres", why: "contradicted by the correction" }],
        warnings: [],
      },
      writeReplacementCalls: 0,
      propagateCalls: 0,
      retireCalls: 0,
    };
    const planner = new CorrectionPlanner(makeDeps(dir, state));
    const plan = await planner.plan(
      { text: "we migrated to MySQL in March", targetIds: ["mem-postgres"] },
      ["default"],
    );
    assert.equal(plan.classification, "outdated");
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].kind, "supersede");
    assert.equal(plan.affected.length, 1);
    assert.equal(plan.affected[0].memoryId, "mem-postgres");
    assert.equal(plan.confidence, 0.9);
    assert.equal(plan.namespace, "default");
    assert.equal(plan.status, "pending");
    assert.match(plan.diff, /DIFF\(1 actions\)/);
  });
});

test("search-located plan: no targetIds → search runs and top hits become candidates", async () => {
  await withTempDir(async (dir) => {
    const state: StubState = {
      candidatesById: new Map([
        ["mem-a", makeCandidate({ memoryId: "mem-a", content: "prefers PostgreSQL for analytics" })],
        ["mem-b", makeCandidate({ memoryId: "mem-b", content: "PostgreSQL connection string" })],
      ]),
      llmResult: {
        classification: "wrong",
        confidence: 0.7,
        actions: [{ kind: "retract", memoryId: "mem-a" }],
        relevance: [{ memoryId: "mem-a", why: "directly contradicted" }],
        warnings: [],
      },
      writeReplacementCalls: 0,
      propagateCalls: 0,
      retireCalls: 0,
    };
    const planner = new CorrectionPlanner(makeDeps(dir, state));
    const plan = await planner.plan({ text: "PostgreSQL" }, ["default"]);
    // Both mem-a and mem-b match "PostgreSQL"; the planner offers them as
    // candidates but only mem-a is annotated by the LLM.
    assert.equal(plan.affected.length, 1);
    assert.equal(plan.affected[0].memoryId, "mem-a");
  });
});

test("not-found target → explicit error (rule 34)", async () => {
  await withTempDir(async (dir) => {
    const state: StubState = {
      candidatesById: new Map(),
      llmResult: { classification: "outdated", confidence: 0.5, actions: [], relevance: [], warnings: [] },
      writeReplacementCalls: 0,
      propagateCalls: 0,
      retireCalls: 0,
    };
    const planner = new CorrectionPlanner(makeDeps(dir, state));
    await assert.rejects(
      planner.plan({ text: "fix this", targetIds: ["does-not-exist"] }, ["default"]),
      /target memory not found: does-not-exist/,
    );
  });
});

test("LLM classify success per classification class (stubbed adapter, rule 33)", async () => {
  const classes: CorrectionClassification[] = ["wrong", "outdated", "incomplete", "wrong_scope", "never_store"];
  for (const cls of classes) {
    await withTempDir(async (dir) => {
      const action: CorrectionAction =
        cls === "wrong"
          ? { kind: "retract", memoryId: "mem-x" }
          : cls === "outdated"
            ? { kind: "supersede", loserId: "mem-x", replacement: { content: "new" } }
            : cls === "incomplete"
              ? { kind: "edit", memoryId: "mem-x", patch: "updated content" }
              : cls === "wrong_scope"
                ? { kind: "rescope", memoryId: "mem-x", toNamespace: "other" }
                : { kind: "redaction_rule", pattern: "secret-token-\\d+" };
      const state: StubState = {
        candidatesById: new Map([["mem-x", makeCandidate({ memoryId: "mem-x", content: "old fact" })]]),
        llmResult: {
          classification: cls,
          confidence: 0.8,
          actions: [action],
          relevance: [{ memoryId: "mem-x", why: `classified as ${cls}` }],
          warnings: [],
        },
        writeReplacementCalls: 0,
        propagateCalls: 0,
        retireCalls: 0,
      };
      const planner = new CorrectionPlanner(makeDeps(dir, state));
      const plan = await planner.plan({ text: "old fact", targetIds: ["mem-x"] }, ["default"]);
      assert.equal(plan.classification, cls);
      assert.equal(plan.actions.length, 1);
    });
  }
});

test("LLM failure → deterministic fallback plan (rule 13)", async () => {
  await withTempDir(async (dir) => {
    const state: StubState = {
      candidatesById: new Map([["mem-x", makeCandidate({ memoryId: "mem-x", content: "old fact" })]]),
      llmResult: {
        classification: "outdated", // ignored — fallback overrides
        confidence: 0,
        actions: [],
        relevance: [{ memoryId: "mem-x", why: "located" }],
        warnings: [],
        fallback: true,
      },
      writeReplacementCalls: 0,
      propagateCalls: 0,
      retireCalls: 0,
    };
    const planner = new CorrectionPlanner(makeDeps(dir, state));
    const plan = await planner.plan({ text: "old fact", targetIds: ["mem-x"] }, ["default"]);
    assert.equal(plan.classification, "outdated");
    assert.equal(plan.confidence, 0);
    assert.equal(plan.actions.length, 0);
    assert.equal(plan.diff, "");
    assert.ok(
      plan.warnings.some((w) => w.includes("planner LLM unavailable")),
      `expected fallback warning, got: ${JSON.stringify(plan.warnings)}`,
    );
  });
});

test("plan persists atomically to state/corrections/pending/<planId>.json and round-trips", async () => {
  await withTempDir(async (dir) => {
    const state: StubState = {
      candidatesById: new Map([["mem-x", makeCandidate({ memoryId: "mem-x", content: "old fact" })]]),
      llmResult: {
        classification: "outdated",
        confidence: 0.9,
        actions: [{ kind: "supersede", loserId: "mem-x", replacement: { content: "new fact" } }],
        relevance: [{ memoryId: "mem-x", why: "contradicted" }],
        warnings: [],
      },
      writeReplacementCalls: 0,
      propagateCalls: 0,
      retireCalls: 0,
    };
    const planner = new CorrectionPlanner(makeDeps(dir, state));
    const plan = await planner.plan({ text: "old fact", targetIds: ["mem-x"] }, ["default"]);
    // loadPlan round-trips it.
    const reloaded = await planner.loadPlan("default", plan.planId);
    assert.ok(reloaded, "plan should round-trip via loadPlan");
    assert.equal(reloaded!.planId, plan.planId);
    assert.equal(reloaded!.actions.length, 1);
    // listPending surfaces it.
    const pending = await planner.listPending("default");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].planId, plan.planId);
  });
});

test("plan expires after TTL — apply-time rejection is tested in executor; here we verify the timestamp", async () => {
  await withTempDir(async (dir) => {
    const state: StubState = {
      candidatesById: new Map([["mem-x", makeCandidate({ memoryId: "mem-x", content: "old fact" })]]),
      llmResult: { classification: "outdated", confidence: 0.9, actions: [], relevance: [], warnings: [] },
      writeReplacementCalls: 0,
      propagateCalls: 0,
      retireCalls: 0,
    };
    const planner = new CorrectionPlanner(makeDeps(dir, state, { planTtlHours: 1 }));
    const plan = await planner.plan({ text: "old fact", targetIds: ["mem-x"] }, ["default"]);
    const created = new Date(plan.createdAt).getTime();
    const expires = new Date(plan.expiresAt).getTime();
    // TTL of 1h = 3600000ms.
    assert.equal(expires - created, 60 * 60 * 1000);
  });
});

test("bulk guard: > maxAffected refuses with a clear error (§39)", async () => {
  await withTempDir(async (dir) => {
    const candidates = new Map<string, PlannerCandidate>();
    for (let i = 0; i < 5; i++) {
      candidates.set(`mem-${i}`, makeCandidate({ memoryId: `mem-${i}`, content: `fact ${i}` }));
    }
    const state: StubState = {
      candidatesById: candidates,
      llmResult: {
        classification: "wrong",
        confidence: 0.5,
        actions: [...candidates.keys()].map((id) => ({ kind: "retract" as const, memoryId: id })),
        relevance: [...candidates.keys()].map((id) => ({ memoryId: id, why: "x" })),
        warnings: [],
      },
      writeReplacementCalls: 0,
      propagateCalls: 0,
      retireCalls: 0,
    };
    const planner = new CorrectionPlanner(makeDeps(dir, state, { maxAffected: 3 }));
    await assert.rejects(
      planner.plan({ text: "fact" }, ["default"]),
      /exceeding the maxAffected limit of 3/,
    );
  });
});

test("malformed action from the LLM adapter is rejected before persist (defense in depth)", async () => {
  await withTempDir(async (dir) => {
    const state: StubState = {
      candidatesById: new Map([["mem-x", makeCandidate({ memoryId: "mem-x", content: "old fact" })]]),
      llmResult: {
        classification: "outdated",
        confidence: 0.9,
        // Missing required loserId.
        actions: [{ kind: "supersede" } as unknown as CorrectionAction],
        relevance: [],
        warnings: [],
      },
      writeReplacementCalls: 0,
      propagateCalls: 0,
      retireCalls: 0,
    };
    const planner = new CorrectionPlanner(makeDeps(dir, state));
    await assert.rejects(
      planner.plan({ text: "old fact", targetIds: ["mem-x"] }, ["default"]),
      /supersede\.loserId is required/,
    );
  });
});

test("no readable namespaces → explicit error", async () => {
  await withTempDir(async (dir) => {
    const state: StubState = {
      candidatesById: new Map(),
      llmResult: { classification: "outdated", confidence: 0.5, actions: [], relevance: [], warnings: [] },
      writeReplacementCalls: 0,
      propagateCalls: 0,
      retireCalls: 0,
    };
    const planner = new CorrectionPlanner(makeDeps(dir, state));
    await assert.rejects(
      planner.plan({ text: "anything" }, []),
      /at least one readable namespace/,
    );
  });
});
