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
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { withTempDir as managedWithTempDir } from "../testing/tmp-dir.js";
import {
  CorrectionContractError,
  MEMORY_CATEGORIES,
  validateMemoryDraft,
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

const withTempDir = <T>(fn: (dir: string) => Promise<T>): Promise<T> =>
  managedWithTempDir(fn, "remnic-corr-plan-");

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

test("Ug8: path-traversal planId is rejected before building the plan-file path", async () => {
  await withTempDir(async (dir) => {
    const state: StubState = {
      candidatesById: new Map(),
      llmResult: { classification: "outdated", confidence: 0.5, actions: [], relevance: [], warnings: [] },
      writeReplacementCalls: 0,
      propagateCalls: 0,
      retireCalls: 0,
    };
    const planner = new CorrectionPlanner(makeDeps(dir, state));
    // `../../meta` must NOT let path.join escape state/corrections/pending and
    // delete arbitrary .json files under the storage root.
    for (const bad of ["../../meta", "../sibling", "a/b", "a\\b", ".", "..", ".hidden"]) {
      await assert.rejects(planner.loadPlan("default", bad), /Invalid plan id/);
      await assert.rejects(planner.markConsumed("default", bad, "discarded"), /Invalid plan id/);
      await assert.rejects(planner.deletePlan("default", bad), /Invalid plan id/);
    }
    // A canonical corr-... id is accepted (it returns null/not-found without throwing).
    const ok = await planner.loadPlan("default", "corr-abc-123");
    assert.equal(ok, null);
  });
});

test("Of-XJ: validateMemoryDraft rejects categories outside the MemoryCategory allow-list", () => {
  // A path-like or unexpected category must be rejected before it reaches
  // StorageManager.writeMemory, which incorporates the category into the
  // generated memory id/path (review thread Of-XJ).
  for (const cat of ["fact", "preference", "correction", "entity"]) {
    assert.doesNotThrow(() => validateMemoryDraft({ content: "x", category: cat }));
  }
  for (const bad of ["../../etc/passwd", "fact/../../meta", "unknown", "FACT", ""]) {
    assert.throws(
      () => validateMemoryDraft({ content: "x", category: bad }),
      /MemoryDraft.category must be one of/,
    );
  }
  assert.doesNotThrow(() => validateMemoryDraft({ content: "x" }));
  assert.ok(MEMORY_CATEGORIES.includes("reasoning_trace"));
});

test("OgIql: untargeted search uses tokenized keyword matching (not exact-prefix substring)", async () => {
  await withTempDir(async (dir) => {
    // The wiring's searchMemories tokenizes the correction text and matches by
    // keyword overlap, so "we migrated from Postgres to MySQL" finds a memory
    // that says "Postgres is the database" — the old 32-char exact-prefix
    // substring missed this. The planner delegates to deps.searchCorpus, so we
    // verify the planner passes the FULL text and the tokenized search dep
    // (mirroring the wiring logic) locates the memory.
    const candidates = new Map<string, PlannerCandidate>([
      ["mem-db", {
        memoryId: "mem-db",
        path: "facts/mem-db.md",
        content: "Postgres is the database",
        excerpt: "Postgres is the database",
        score: 1,
      }],
    ]);
    let classifyCandidates: PlannerCandidate[] = [];
    const state: StubState = {
      candidatesById: candidates,
      llmResult: { classification: "outdated", confidence: 0.5, actions: [], relevance: [], warnings: [] },
      writeReplacementCalls: 0,
      propagateCalls: 0,
      retireCalls: 0,
    };
    const deps = makeDeps(dir, state);
    // Mirror the wiring's tokenized search: split into keywords, match overlap.
    deps.searchCorpus = async ({ text, limit }) => {
      const STOP = new Set(["the", "a", "an", "is", "are", "to", "of", "from", "we", "and", "or", "in", "on"]);
      const tokens = [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
      const matched = [...state.candidatesById.values()].filter((c) => {
        const hay = c.content.toLowerCase();
        return tokens.some((t) => hay.includes(t));
      });
      return matched.slice(0, limit).map((c, i) => ({ ...c, score: 1 - i * 0.1 }));
    };
    deps.classifyAndDraft = async ({ candidates: cs }) => {
      classifyCandidates = cs;
      return { classification: "outdated", confidence: 0.5, actions: [], relevance: [], warnings: [] };
    };
    const planner = new CorrectionPlanner(deps);
    await planner.plan({ text: "we migrated from Postgres to MySQL" }, ["default"]);
    assert.ok(classifyCandidates.length > 0, "tokenized search must find the Postgres memory");
    assert.equal(classifyCandidates[0].memoryId, "mem-db");
  });
});

test("#1678: never_store plan redacts the request text in the persisted pending-plan file", async () => {
  await withTempDir(async (dir) => {
    const secret = "my API key is sk-secret-DO-NOT-STORE-12345";
    const state: StubState = {
      candidatesById: new Map([["mem-s", makeCandidate({ memoryId: "mem-s", content: secret })]]),
      llmResult: {
        classification: "never_store",
        confidence: 0.95,
        actions: [{ kind: "redaction_rule", pattern: "sk-secret-\\d+" }],
        relevance: [],
        warnings: [],
      },
      writeReplacementCalls: 0,
      propagateCalls: 0,
      retireCalls: 0,
    };
    const planner = new CorrectionPlanner(makeDeps(dir, state));
    // The in-memory plan keeps the original text (the executor's audit body
    // re-applies its own redaction).
    const plan = await planner.plan({ text: secret, targetIds: ["mem-s"] }, ["default"]);
    assert.equal(plan.request.text, secret, "in-memory plan keeps the original request text");
    assert.equal(plan.classification, "never_store");

    // The persisted file MUST NOT contain the secret.
    const filePath = path.join(dir, "state", "corrections", "pending", `${plan.planId}.json`);
    const raw = await readFile(filePath, "utf-8");
    assert.ok(!raw.includes("sk-secret-DO-NOT-STORE"),
      "the persisted pending-plan file must NOT contain the never-store secret (request.text is redacted)");
    assert.ok(raw.includes("redacted"),
      "the persisted request text must be the redaction placeholder");
    // The redaction_rule.pattern is NOT redacted on disk: the executor's apply
    // flow reloads via loadPlan and needs the real pattern to call
    // registerRedactionRule. Redacting it would register a placeholder (#vZln).
    // The pattern's transient exposure is bounded by the pending-plan TTL +
    // consumed-on-apply lifecycle.
    assert.ok(raw.includes("sk-secret"),
      "the redaction_rule.pattern survives on disk for the apply flow (bounded by pending-plan TTL)");

    // loadPlan reads from disk → the reloaded plan has the redacted text.
    const reloaded = await planner.loadPlan("default", plan.planId);
    assert.ok(reloaded, "plan round-trips");
    assert.notEqual(reloaded!.request.text, secret,
      "loaded plan must carry the redacted text, not the original secret");
    assert.ok(reloaded!.request.text.includes("redacted"));
  });
});

// ---------------------------------------------------------------------------
// #1713 Item 2: stale applying plan recovery
// ---------------------------------------------------------------------------

test("#1713: markConsumed(applying) stamps applyingAt", async () => {
  await withTempDir(async (dir) => {
    const state: StubState = {
      candidatesById: new Map([
        ["mem-x", makeCandidate({ memoryId: "mem-x", content: "old fact" })],
      ]),
      llmResult: {
        classification: "outdated",
        confidence: 0.9,
        actions: [{ kind: "supersede", loserId: "mem-x", replacement: { content: "new fact" } }],
        relevance: [],
        warnings: [],
      },
      writeReplacementCalls: 0,
      propagateCalls: 0,
      retireCalls: 0,
    };
    const planner = new CorrectionPlanner(makeDeps(dir, state));
    const plan = await planner.plan({ text: "correct this" }, ["default"]);
    await planner.markConsumed("default", plan.planId, "applying");
    const reloaded = await planner.loadPlan("default", plan.planId);
    assert.equal(reloaded!.status, "applying");
    assert.ok(reloaded!.applyingAt, "applyingAt must be stamped when entering applying state");
  });
});

test("#1713: markConsumed(applied) clears applyingAt", async () => {
  await withTempDir(async (dir) => {
    const state: StubState = {
      candidatesById: new Map([
        ["mem-x", makeCandidate({ memoryId: "mem-x", content: "old fact" })],
      ]),
      llmResult: {
        classification: "outdated",
        confidence: 0.9,
        actions: [{ kind: "supersede", loserId: "mem-x", replacement: { content: "new fact" } }],
        relevance: [],
        warnings: [],
      },
      writeReplacementCalls: 0,
      propagateCalls: 0,
      retireCalls: 0,
    };
    const planner = new CorrectionPlanner(makeDeps(dir, state));
    const plan = await planner.plan({ text: "correct this" }, ["default"]);
    await planner.markConsumed("default", plan.planId, "applying");
    await planner.markConsumed("default", plan.planId, "applied");
    const reloaded = await planner.loadPlan("default", plan.planId);
    assert.equal(reloaded!.status, "applied");
    assert.ok(!reloaded!.applyingAt, "applyingAt must be cleared on terminal status");
  });
});

test("#1713: recoverStaleApplyingPlans discards stale applying plans", async () => {
  await withTempDir(async (dir) => {
    const state: StubState = {
      candidatesById: new Map([
        ["mem-x", makeCandidate({ memoryId: "mem-x", content: "secret-token-1234" })],
      ]),
      llmResult: {
        classification: "never_store",
        confidence: 0.9,
        actions: [{ kind: "redaction_rule", pattern: "secret-token-\\d+" }],
        relevance: [],
        warnings: [],
      },
      writeReplacementCalls: 0,
      propagateCalls: 0,
      retireCalls: 0,
    };
    const planTime = new Date("2026-03-15T12:00:00Z");
    const recoveryTime = new Date("2026-03-15T13:00:00Z");
    const deps = makeDeps(dir, state);
    deps.now = () => planTime;
    const planner = new CorrectionPlanner(deps);
    const plan = await planner.plan({ text: "never store this secret", targetIds: ["mem-x"] }, ["default"]);
    await planner.markConsumed("default", plan.planId, "applying");

    let reloaded = await planner.loadPlan("default", plan.planId);
    assert.equal(reloaded!.status, "applying");

    const recovered = await planner.recoverStaleApplyingPlans("default", { now: recoveryTime });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0], plan.planId);

    // Read the raw file (loadPlan/parsePlan rejects the scrubbed pattern by
    // design — validation rejects placeholder patterns on re-load).
    const { readFile: rf } = await import("node:fs/promises");
    const rawPlan = JSON.parse(
      await rf(dir + "/state/corrections/pending/" + plan.planId + ".json", "utf-8"),
    );
    assert.equal(rawPlan.status, "discarded");
    assert.ok(!rawPlan.applyingAt, "applyingAt cleared on discard");
    const redactionAction = rawPlan.actions.find(
      (a: { kind: string }) => a.kind === "redaction_rule",
    );
    assert.ok(redactionAction, "redaction_rule action should still exist");
    assert.match(String(redactionAction.pattern), /redacted/);
  });
});

test("#1713: recoverStaleApplyingPlans leaves fresh applying plans alone", async () => {
  await withTempDir(async (dir) => {
    const state: StubState = {
      candidatesById: new Map([
        ["mem-x", makeCandidate({ memoryId: "mem-x", content: "old fact" })],
      ]),
      llmResult: {
        classification: "outdated",
        confidence: 0.9,
        actions: [{ kind: "supersede", loserId: "mem-x", replacement: { content: "new fact" } }],
        relevance: [],
        warnings: [],
      },
      writeReplacementCalls: 0,
      propagateCalls: 0,
      retireCalls: 0,
    };
    const fixedNow = new Date("2026-03-15T12:00:00Z");
    const deps = makeDeps(dir, state);
    const planner = new CorrectionPlanner(deps);
    const plan = await planner.plan({ text: "correct this" }, ["default"]);
    await planner.markConsumed("default", plan.planId, "applying");

    const recovered = await planner.recoverStaleApplyingPlans("default", {
      now: new Date(fixedNow.getTime() + 2 * 60 * 1000),
    });
    assert.equal(recovered.length, 0);

    const reloaded = await planner.loadPlan("default", plan.planId);
    assert.equal(reloaded!.status, "applying");
  });
});

test("#1713: recoverStaleApplyingPlans returns empty for namespace with no plans", async () => {
  await withTempDir(async (dir) => {
    const state: StubState = {
      candidatesById: new Map(),
      llmResult: { classification: "outdated", confidence: 0.5, actions: [], relevance: [], warnings: [] },
      writeReplacementCalls: 0,
      propagateCalls: 0,
      retireCalls: 0,
    };
    const planner = new CorrectionPlanner(makeDeps(dir, state));
    const recovered = await planner.recoverStaleApplyingPlans("default");
    assert.deepEqual(recovered, []);
  });
});

test("#1713: recoverStaleApplyingPlans recovers pre-fix plans via expiresAt fallback", async () => {
  await withTempDir(async (dir) => {
    const state: StubState = {
      candidatesById: new Map([
        ["mem-x", makeCandidate({ memoryId: "mem-x", content: "old fact" })],
      ]),
      llmResult: {
        classification: "outdated",
        confidence: 0.9,
        actions: [{ kind: "supersede", loserId: "mem-x", replacement: { content: "new fact" } }],
        relevance: [],
        warnings: [],
      },
      writeReplacementCalls: 0,
      propagateCalls: 0,
      retireCalls: 0,
    };
    const fixedNow = new Date("2026-03-15T12:00:00Z");
    const deps = makeDeps(dir, state);
    const planner = new CorrectionPlanner(deps);
    const plan = await planner.plan({ text: "correct this" }, ["default"]);

    await planner.markConsumed("default", plan.planId, "applying");
    // Simulate a pre-fix plan: manually strip applyingAt from the file
    const { readFile: rf, writeFile: wf } = await import("node:fs/promises");
    const planFile = dir + "/state/corrections/pending/" + plan.planId + ".json";
    const planJson = JSON.parse(await rf(planFile, "utf-8"));
    delete planJson.applyingAt;
    await wf(planFile, JSON.stringify(planJson) + "\n", "utf-8");

    // Recovery 25h later (past the 24h expiry, no applyingAt → falls back to expiresAt)
    const recovered = await planner.recoverStaleApplyingPlans("default", {
      now: new Date(fixedNow.getTime() + 25 * 60 * 60 * 1000),
    });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0], plan.planId);
  });
});

test("#1713: recoverStaleApplyingPlans recovers pre-fix plans immediately at expiry (no extra TTL wait)", async () => {
  await withTempDir(async (dir) => {
    const state: StubState = {
      candidatesById: new Map([
        ["mem-x", makeCandidate({ memoryId: "mem-x", content: "old fact" })],
      ]),
      llmResult: {
        classification: "outdated",
        confidence: 0.9,
        actions: [{ kind: "supersede", loserId: "mem-x", replacement: { content: "new fact" } }],
        relevance: [],
        warnings: [],
      },
      writeReplacementCalls: 0,
      propagateCalls: 0,
      retireCalls: 0,
    };
    const fixedNow = new Date("2026-03-15T12:00:00Z");
    const deps = makeDeps(dir, state);
    const planner = new CorrectionPlanner(deps);
    const plan = await planner.plan({ text: "correct this" }, ["default"]);

    await planner.markConsumed("default", plan.planId, "applying");
    // Simulate a pre-fix plan: manually strip applyingAt from the file
    const { readFile: rf, writeFile: wf } = await import("node:fs/promises");
    const planFile = dir + "/state/corrections/pending/" + plan.planId + ".json";
    const planJson = JSON.parse(await rf(planFile, "utf-8"));
    delete planJson.applyingAt;
    await wf(planFile, JSON.stringify(planJson) + "\n", "utf-8");

    // Recovery at exactly expiresAt: plan is already expired -> recover now
    // (review thread ff034716: no extra TTL wait for pre-fix plans)
    const recovered = await planner.recoverStaleApplyingPlans("default", {
      now: new Date(planJson.expiresAt),
    });
    assert.equal(recovered.length, 1, "pre-fix plan at expiry must be recovered immediately");
  });
});
