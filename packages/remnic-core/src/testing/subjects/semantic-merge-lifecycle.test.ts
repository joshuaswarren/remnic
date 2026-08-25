/**
 * Semantic merge-on-write lifecycle subject for the scenario-matrix harness
 * (PR #2771 review finding B, issue #2330).
 *
 * The lifecycle-matrix gate previously accepted changes to
 * `orchestration/semantic-merge-persist.ts` through the `extraction-lifecycle`
 * subject, which builds every configuration with `semanticMerge` disabled —
 * the required gate passed without ever exercising the merge path it claimed
 * to cover. This subject runs the REAL orchestrator + storage persist path
 * (turn ingestion → buffer → flush → `ExtractionPersistCoordinator` →
 * `applySemanticMergeAtPersist` → `StorageManager` compare-and-swap) with
 * `semanticMerge` ENABLED for all nine canonical rows, and asserts the merge
 * outcome survives each lifecycle transition.
 *
 * Deterministic sensors use the established field-level seams (never
 * production hooks): the extraction client (`stubExtraction`), the embedding
 * neighbor index (`embeddingFallback`), and the local-llm judge client
 * (`localLlm`, answering only the merge-judge system prompt). Storage,
 * versioning, the merge decision, the CAS writes, the rollback data, and the
 * index repair are all production code.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Orchestrator } from "../../orchestrator.js";
import { resolveNamespaceStorageRoot } from "../../namespaces/storage.js";
import type { BufferTurn, PluginConfig } from "../../types.js";
import {
  type LifecycleSubject,
  type MatrixRow,
  runLifecycleMatrix,
} from "../lifecycle-matrix.js";
import {
  cleanupDir,
  makeLifecycleConfig,
  markdownFilesUnder,
  mkTempMemoryDir,
  pastIso,
  singleFactResult,
  sleep,
  stubExtraction,
} from "../orchestrator-lite.js";
import { queryTemporalTimelineAsync } from "../../temporal-index.js";

// ── Fixtures (synthetic; no real paths, hosts, or memory content) ─────────────

const SEED_A = "The billing service deploys on a Tuesday cadence.";
const INCOMING_A = "The billing service deploys at 09:00 UTC sharp.";
const INCOMING_B = "The billing service deploy includes the payments module.";
const SEED_B = "The audit service tracks quarterly access reviews.";
const INCOMING_BOB = "The audit service also covers vendor onboarding.";

/**
 * Capture-cued turn contents. The smart trigger auto-fires on the explicit
 * "Please remember" cue (the same pattern every auto-extraction row in the
 * reference subject uses); flush-driven rows use the same turns for uniformity,
 * and the fact body carries the cue verbatim.
 */
const TURN_A = `Please remember: ${INCOMING_A}`;
const TURN_B = `Please remember: ${INCOMING_B}`;
const TURN_BOB = `Please remember: ${INCOMING_BOB}`;
const GRAPH_SEED = "The billing service deploys on a Tuesday cadence.";
const GRAPH_INCOMING = "The billing service deploys at 09:00 UTC because payments reconciliation gates the window.";
const GRAPH_SIBLING = "The billing service pages the on-call engineer after failed deploys.";
const PREF_SEED = "Commit messages favor terse commit subject lines.";
const PREF_INCOMING = "Commit messages favor imperative mood subjects.";

const NEEDLE_SEED_A = "Tuesday cadence";
const NEEDLE_A = "09:00 UTC sharp";
const NEEDLE_B = "payments module";
const NEEDLE_SEED_B = "quarterly access reviews";
const NEEDLE_BOB = "vendor onboarding";

/** A sparse, opaque session id remembered (bound) to alice from a PRIOR session. */
const REMEMBERED_SESSION = "restored-session-9f2a";
/** A sparse, opaque session id with NO remembered binding. */
const UNBOUND_SESSION = "unbound-session-0000";

/** Merge band neighbor score: inside [minSimilarity=0.8, dedupThreshold=0.92). */
const BAND_SCORE = 0.85;

interface SemanticMergeLifecycleState {
  memoryDir: string;
  cfg: PluginConfig;
  orchestrators: Orchestrator[];
  calls: BufferTurn[][];
  restartCalls?: BufferTurn[][];
  /** Judge verdicts answered across ALL orchestrator instances. */
  judge: { calls: number };
  aliceRoot?: string;
  bobRoot?: string;
  aliceFile?: string;
  bobFile?: string;
  targetFile?: string;
  callsBeforeForceFlush?: number;
}

// ── Configs ───────────────────────────────────────────────────────────────────

/** Merge-on-write lifecycle config: semanticMerge ON, embedding + versioning ON. */
function mergeLifecycleConfig(memoryDir: string, overrides: Record<string, unknown> = {}): PluginConfig {
  return makeLifecycleConfig(memoryDir, {
    semanticMerge: { enabled: true },
    embeddingFallbackEnabled: true,
    versioningEnabled: true,
    // Round N+12 (CI-0): the commit-effects sibling (snapshot staging, prune
    // finalization, durable thread-episode persist) runs on this subject's
    // merge path — threading ON gives the thread-episode helper a real
    // thread id so every exported function of that module executes here.
    threadingEnabled: true,
    ...overrides,
  });
}

/** Namespaces-on config with alice/bob principal prefix routing (identity rows). */
function namespacedConfig(memoryDir: string): PluginConfig {
  return mergeLifecycleConfig(memoryDir, {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    defaultRecallNamespaces: ["self"],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [
      { match: "alice:", principal: "alice" },
      { match: "bob:", principal: "bob" },
    ],
    namespacePolicies: [
      { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
      { name: "bob", readPrincipals: ["bob"], writePrincipals: ["bob"] },
    ],
  });
}

/** Map-mode config where {@link REMEMBERED_SESSION} is bound to alice. */
function rememberedBindingConfig(memoryDir: string): PluginConfig {
  return mergeLifecycleConfig(memoryDir, {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    defaultRecallNamespaces: ["self"],
    principalFromSessionKeyMode: "map",
    principalFromSessionKeyRules: [{ match: REMEMBERED_SESSION, principal: "alice" }],
    namespacePolicies: [{ name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] }],
  });
}

// ── Deterministic sensors (field-level seams) ─────────────────────────────────

/** The embedding-fallback field seam replaced by {@link installNeighbors}. */
interface EmbeddingFallbackSeam {
  embeddingFallback: {
    isAvailable: () => Promise<boolean>;
    search: (
      query: string,
      limit: number,
      options?: unknown,
    ) => Promise<Array<{ id: string; score: number; path: string }>>;
    indexFile: (id: string, content: string, path: string) => Promise<void>;
    removeFromIndex: (id: string) => Promise<void>;
  };
}

/**
 * Serve in-band nearest neighbors for EXACT incoming fact contents only.
 * Recall queries and any other content get an empty index, so the stub can
 * never fabricate a recall hit.
 */
function installNeighbors(
  orchestrator: Orchestrator,
  neighborsFor: (query: string) => Array<{ id: string; score: number }>,
): void {
  (orchestrator as unknown as EmbeddingFallbackSeam).embeddingFallback = {
    isAvailable: async () => true,
    search: async (query: string) =>
      neighborsFor(query).map((n) => ({ id: n.id, score: n.score, path: "" })),
    indexFile: async () => {},
    removeFromIndex: async () => {},
  };
}

/** The local-llm field seam replaced by {@link installJudge}. */
interface LocalLlmSeam {
  localLlm: {
    chatCompletion: (
      messages: Array<{ role: string; content: string }>,
      options?: unknown,
    ) => Promise<{ content: string } | null>;
  };
}

/**
 * Answer ONLY the merge-judge prompt (the production callMergeJudge routing
 * reaches this field through the late-binding `getLocalLlm` dep). Every other
 * caller gets `null` — the same "no backend answered" they already handle.
 * The verdict merges the top candidate's CURRENT body with the incoming text,
 * so replays merge into the already-merged target.
 */
function installJudge(orchestrator: Orchestrator, judge: { calls: number }): void {
  (orchestrator as unknown as LocalLlmSeam).localLlm = {
    chatCompletion: async (messages) => {
      if (messages[0]?.role !== "system" || !messages[0].content.startsWith("You maintain a long-term memory store")) {
        return null;
      }
      judge.calls++;
      const input = JSON.parse(messages[1]?.content ?? "{}") as {
        new?: { content?: string };
        existing?: Array<{ id?: string; content?: string }>;
      };
      const target = input.existing?.[0];
      if (!target?.id || typeof target.content !== "string" || typeof input.new?.content !== "string") {
        return { content: JSON.stringify({ decision: "create", targetId: null, mergedContent: null, reason: "no candidate" }) };
      }
      return {
        content: JSON.stringify({
          decision: "merge",
          targetId: target.id,
          mergedContent: `${target.content} ${input.new.content}`.trim(),
          reason: "deterministic lifecycle subject judge",
        }),
      };
    },
  };
}

// ── Seeding ───────────────────────────────────────────────────────────────────

/**
 * Seed a merge TARGET directly on disk with PAST timestamps and a high
 * importance score, so an incoming fact's own importance never bypasses the
 * merge as unpreservable metadata. Returns the file path.
 */
async function seedMergeTarget(
  root: string,
  id: string,
  content: string,
  options: {
    /** Category (and its directory) for the target; default `fact`/`facts`. */
    category?: "fact" | "preference";
    /** Storage tier: `cold` seeds under `<root>/cold/...` (demoted target). */
    tier?: "hot" | "cold";
    /** Extra frontmatter lines stamped between `status` and `importanceScore`. */
    extraFrontmatter?: string[];
  } = {},
): Promise<string> {
  const category = options.category ?? "fact";
  const created = pastIso();
  const dir = path.join(
    root,
    options.tier === "cold" ? "cold" : ".",
    category === "preference" ? "preferences" : "facts",
    created.slice(0, 10),
  );
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.md`);
  await writeFile(
    file,
    [
      "---",
      `id: ${id}`,
      `category: ${category}`,
      `created: ${created}`,
      `updated: ${created}`,
      "source: extraction",
      "confidence: 0.9",
      "confidenceTier: explicit",
      "status: active",
      ...(options.extraFrontmatter ?? []),
      "importanceScore: 0.9",
      "importanceLevel: high",
      "---",
      "",
      content,
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

async function assertMerged(file: string, needles: string[], reinforcementCount: number): Promise<void> {
  const raw = await readFile(file, "utf8");
  for (const needle of needles) {
    assert.ok(raw.includes(needle), `merged target must contain "${needle}"`);
  }
  assert.ok(raw.includes("derived_via: merge"), "merged target must carry merge provenance");
  assert.ok(
    raw.includes(`reinforcement_count: ${reinforcementCount}`),
    `merged target must record reinforcement_count: ${reinforcementCount}`,
  );
}

/** Read one graph JSONL edge file (entity/time/causal) as parsed rows. */
async function readGraphEdges(
  memoryDir: string,
  type: "entity" | "time" | "causal",
): Promise<Array<{ from: string; to: string; label: string }>> {
  const file = path.join(memoryDir, "state", "graphs", `${type}.jsonl`);
  try {
    const raw = await readFile(file, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { from: string; to: string; label: string });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

test("a judge-accepted merge builds the create path's graph edges for the target (round N+5 A)", async () => {
  const memoryDir = await mkTempMemoryDir("semantic-merge-graph");
  let orch: Orchestrator | undefined;
  try {
    const cfg = mergeLifecycleConfig(memoryDir, {
      multiGraphMemoryEnabled: true,
      threadingEnabled: true,
    });
    orch = new Orchestrator(cfg);
    const judge = { calls: 0 };
    installJudge(orch, judge);
    // Fact 1 has no merge candidate (created; becomes the batch's causal and
    // time predecessor). Fact 2 merges into the seeded target.
    const FIRST = "The audit service tracks quarterly access reviews.";
    stubExtraction(orch, () => ({
      facts: [
        { category: "fact", content: FIRST, confidence: 0.9, tags: [] },
        { category: "fact", content: GRAPH_INCOMING, confidence: 0.9, tags: [] },
      ],
      entities: [],
      relationships: [],
      questions: [],
      profileUpdates: [],
    }));
    installNeighbors(orch, (query) =>
      query === GRAPH_INCOMING ? [{ id: "merge-target-graph", score: BAND_SCORE }] : [],
    );
    const targetFile = await seedMergeTarget(memoryDir, "merge-target-graph", GRAPH_SEED, {
      extraFrontmatter: ["entityRef: entity-billing-service"],
    });
    await seedMergeTarget(memoryDir, "merge-sibling-graph", GRAPH_SIBLING, {
      extraFrontmatter: ["entityRef: entity-billing-service"],
    });
    await orch.processTurn("user", `Please remember: ${GRAPH_INCOMING}`, "session-graph");
    assert.equal(await orch.waitForExtractionIdle(15_000), true);

    assert.equal(judge.calls, 1, "the mergeable fact must reach the judge exactly once");
    await assertMerged(targetFile, ["Tuesday cadence", "09:00 UTC"], 1);

    const entityEdges = await readGraphEdges(memoryDir, "entity");
    assert.equal(
      entityEdges.filter((e) => e.from.endsWith("merge-target-graph.md")).length,
      1,
      "the merged target must carry an entity edge to its seeded sibling",
    );
    assert.ok(
      entityEdges.some(
        (e) =>
          e.from.endsWith("merge-target-graph.md") &&
          e.to.endsWith("merge-sibling-graph.md") &&
          e.label === "entity-billing-service",
      ),
    );
    const timeEdges = await readGraphEdges(memoryDir, "time");
    assert.equal(
      timeEdges.filter((e) => e.to.endsWith("merge-target-graph.md")).length,
      1,
      "the merged target must carry a time edge from the same extraction's created fact",
    );
    assert.ok(
      timeEdges.every((e) => typeof e.label === "string" && e.label.length > 0),
      "time edges carry the thread id as their label",
    );
    const causalEdges = await readGraphEdges(memoryDir, "causal");
    assert.equal(
      causalEdges.filter((e) => e.to.endsWith("merge-target-graph.md")).length,
      1,
      "the merged body's causal phrase must link the created fact to the merged target",
    );
  } finally {
    await orch?.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});

test("a preference accepted through semantic merge reaches the behavior-signal ledger (round N+5 B)", async () => {
  const memoryDir = await mkTempMemoryDir("semantic-merge-pref");
  let orch: Orchestrator | undefined;
  try {
    const cfg = mergeLifecycleConfig(memoryDir);
    orch = new Orchestrator(cfg);
    const judge = { calls: 0 };
    installJudge(orch, judge);
    stubExtraction(orch, () => ({
      facts: [
        { category: "preference", content: PREF_INCOMING, confidence: 0.9, tags: [] },
      ],
      entities: [],
      relationships: [],
      questions: [],
      profileUpdates: [],
    }));
    installNeighbors(orch, (query) =>
      query === PREF_INCOMING ? [{ id: "merge-target-pref", score: BAND_SCORE }] : [],
    );
    const targetFile = await seedMergeTarget(memoryDir, "merge-target-pref", PREF_SEED, {
      category: "preference",
    });
    await orch.processTurn("user", `Please remember: ${PREF_INCOMING}`, "session-pref");
    assert.equal(await orch.waitForExtractionIdle(15_000), true);

    assert.equal(judge.calls, 1, "the preference must reach the judge exactly once");
    await assertMerged(targetFile, ["terse commit subject lines", "imperative mood"], 1);

    const ledgerPath = path.join(memoryDir, "state", "behavior-signals.jsonl");
    const rows = (await readFile(ledgerPath, "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, string>);
    const affinity = rows.filter(
      (row) => row.memoryId === "merge-target-pref" && row.signalType === "preference_affinity",
    );
    assert.equal(
      affinity.length,
      1,
      "the merged preference target must record exactly one preference_affinity event",
    );
    assert.equal(affinity[0]?.direction, "positive");
    assert.equal(affinity[0]?.category, "preference");
    assert.equal(affinity[0]?.source, "extraction");
  } finally {
    await orch?.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});

test("a merge into a cold-tier target records graph edges at the committed cold path (round N+6 A)", async () => {
  const memoryDir = await mkTempMemoryDir("semantic-merge-cold-graph");
  let orch: Orchestrator | undefined;
  try {
    const cfg = mergeLifecycleConfig(memoryDir, {
      multiGraphMemoryEnabled: true,
      threadingEnabled: true,
    });
    orch = new Orchestrator(cfg);
    const judge = { calls: 0 };
    installJudge(orch, judge);
    stubExtraction(orch, () => ({
      facts: [
        { category: "fact", content: INCOMING_A, confidence: 0.9, tags: [] },
      ],
      entities: [],
      relationships: [],
      questions: [],
      profileUpdates: [],
    }));
    installNeighbors(orch, (query) =>
      query === INCOMING_A ? [{ id: "merge-target-cold", score: BAND_SCORE }] : [],
    );
    // The sibling stays hot so the entity-edge neighbor scan can see it; the
    // TARGET is demoted to cold/, invisible to the hot-only graph context.
    await seedMergeTarget(memoryDir, "merge-sibling-cold", GRAPH_SIBLING, {
      extraFrontmatter: ["entityRef: entity-billing-service"],
    });
    const coldFile = await seedMergeTarget(memoryDir, "merge-target-cold", GRAPH_SEED, {
      tier: "cold",
      extraFrontmatter: ["entityRef: entity-billing-service"],
    });
    await orch.processTurn("user", `Please remember: ${INCOMING_A}`, "session-cold");
    assert.equal(await orch.waitForExtractionIdle(15_000), true);

    assert.equal(judge.calls, 1, "the cold-tier target must still reach the judge");
    await assertMerged(coldFile, ["Tuesday cadence", "09:00 UTC sharp"], 1);

    const entityEdges = await readGraphEdges(memoryDir, "entity");
    const targetEdges = entityEdges.filter((e) => e.from.endsWith("merge-target-cold.md"));
    assert.equal(targetEdges.length, 1, "the cold target must carry its entity edge");
    assert.ok(
      targetEdges[0]?.from.startsWith(`cold${path.sep}`),
      `entity edge must reference the committed cold path, got ${targetEdges[0]?.from}`,
    );
    // The pre-fix hot-only fallback fabricated facts/<day>/merge-target-cold.md.
    const day = path.basename(path.dirname(coldFile));
    const fabricated = path.join("facts", day, "merge-target-cold.md");
    for (const type of ["entity", "time", "causal"] as const) {
      const edges = await readGraphEdges(memoryDir, type);
      assert.ok(
        edges.every((e) => e.from !== fabricated && e.to !== fabricated),
        `no ${type} edge may reference the fabricated hot path ${fabricated}`,
      );
    }
  } finally {
    await orch?.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});

test("repeated merges of one target replace, not re-append, its entity edges (round N+6 B)", async () => {
  const memoryDir = await mkTempMemoryDir("semantic-merge-dup-edges");
  let orch: Orchestrator | undefined;
  try {
    const cfg = mergeLifecycleConfig(memoryDir, { multiGraphMemoryEnabled: true });
    orch = new Orchestrator(cfg);
    const judge = { calls: 0 };
    installJudge(orch, judge);
    // Turn 1 merges INCOMING_A into the target; turn 2 merges INCOMING_B into
    // the SAME (already-merged) target — the replay pattern the judge stub
    // exists for.
    let extractionCall = 0;
    stubExtraction(orch, () => {
      extractionCall++;
      return {
        facts: [
          {
            category: "fact",
            content: extractionCall === 1 ? INCOMING_A : INCOMING_B,
            confidence: 0.9,
            tags: [],
          },
        ],
        entities: [],
        relationships: [],
        questions: [],
        profileUpdates: [],
      };
    });
    installNeighbors(orch, (query) =>
      query === INCOMING_A || query === INCOMING_B
        ? [{ id: "merge-target-dup", score: BAND_SCORE }]
        : [],
    );
    const targetFile = await seedMergeTarget(memoryDir, "merge-target-dup", GRAPH_SEED, {
      extraFrontmatter: ["entityRef: entity-billing-service"],
    });
    await seedMergeTarget(memoryDir, "merge-sibling-dup", GRAPH_SIBLING, {
      extraFrontmatter: ["entityRef: entity-billing-service"],
    });
    await orch.processTurn("user", `Please remember: ${INCOMING_A}`, "session-dup-1");
    assert.equal(await orch.waitForExtractionIdle(15_000), true);
    await orch.processTurn("user", `Please remember: ${INCOMING_B}`, "session-dup-2");
    assert.equal(await orch.waitForExtractionIdle(15_000), true);

    assert.equal(judge.calls, 2, "both turns must reach the judge");
    await assertMerged(targetFile, ["Tuesday cadence", "09:00 UTC sharp", "payments module"], 2);

    const entityEdges = await readGraphEdges(memoryDir, "entity");
    const fromTarget = entityEdges.filter((e) => e.from.endsWith("merge-target-dup.md"));
    assert.equal(
      fromTarget.length,
      1,
      `re-merging must replace the target's entity edges, got ${JSON.stringify(fromTarget)}`,
    );
    assert.equal(
      fromTarget.filter((e) => e.to.endsWith("merge-sibling-dup.md")).length,
      1,
      "exactly one edge per (target, neighbor) pair after both merges",
    );
  } finally {
    await orch?.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});

test("the fact after a merge chains time/causal adjacency through the merged target (round N+6 C)", async () => {
  const memoryDir = await mkTempMemoryDir("semantic-merge-thread-chain");
  let orch: Orchestrator | undefined;
  try {
    const cfg = mergeLifecycleConfig(memoryDir, {
      multiGraphMemoryEnabled: true,
      threadingEnabled: true,
    });
    orch = new Orchestrator(cfg);
    const judge = { calls: 0 };
    installJudge(orch, judge);
    // One batch: FIRST is created (becomes the thread's first episode),
    // INCOMING_A merges into the target, then SUCCESSOR is created and must
    // chain through the merged target — its "because" phrase drives the
    // causal edge. No other content carries a causal phrase.
    const FIRST = "The audit service tracks quarterly access reviews.";
    const SUCCESSOR =
      "The billing service deploy queue drains slowly because reconciliation locks the ledger.";
    stubExtraction(orch, () => ({
      facts: [
        { category: "fact", content: FIRST, confidence: 0.9, tags: [] },
        { category: "fact", content: INCOMING_A, confidence: 0.9, tags: [] },
        { category: "fact", content: SUCCESSOR, confidence: 0.9, tags: [] },
      ],
      entities: [],
      relationships: [],
      questions: [],
      profileUpdates: [],
    }));
    installNeighbors(orch, (query) =>
      query === INCOMING_A ? [{ id: "merge-target-thread", score: BAND_SCORE }] : [],
    );
    const targetFile = await seedMergeTarget(memoryDir, "merge-target-thread", GRAPH_SEED, {});
    await orch.processTurn("user", `Please remember: ${INCOMING_A}`, "session-chain");
    assert.equal(await orch.waitForExtractionIdle(15_000), true);

    assert.equal(judge.calls, 1, "only the mergeable fact reaches the judge");
    await assertMerged(targetFile, ["Tuesday cadence", "09:00 UTC sharp"], 1);

    const timeEdges = await readGraphEdges(memoryDir, "time");
    const intoTarget = timeEdges.find((e) => e.to.endsWith("merge-target-thread.md"));
    const outOfTarget = timeEdges.find((e) => e.from.endsWith("merge-target-thread.md"));
    assert.ok(intoTarget, "the merged target keeps its own incoming time edge");
    assert.ok(
      outOfTarget,
      "the fact following the merge must chain its time edge through the merged target",
    );
    assert.equal(
      outOfTarget?.from,
      intoTarget?.to,
      "the successor edge starts at the merged target's committed path",
    );
    const causalEdges = await readGraphEdges(memoryDir, "causal");
    assert.equal(
      causalEdges.filter((e) => e.from.endsWith("merge-target-thread.md")).length,
      1,
      "the successor fact's causal phrase must link through the merged target",
    );
  } finally {
    await orch?.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});

// ── Subject ───────────────────────────────────────────────────────────────────

const subject: LifecycleSubject<SemanticMergeLifecycleState> = {
  async setup(row: MatrixRow): Promise<SemanticMergeLifecycleState> {
    const memoryDir = await mkTempMemoryDir(`semantic-merge-${row.id}`);
    let primary: Orchestrator | undefined;
    try {
      const cfg =
        row.id === "sparse-metadata-with-binding" || row.id === "sparse-metadata-without-binding"
          ? rememberedBindingConfig(memoryDir)
          : row.id === "explicit-provider-identity" || row.id === "provider-rebinding"
            ? namespacedConfig(memoryDir)
            : row.id === "dedupe-replay"
              ? mergeLifecycleConfig(memoryDir, {
                  extractionDedupeEnabled: true,
                  extractionDedupeWindowMs: 60_000,
                })
              : mergeLifecycleConfig(memoryDir);
      primary = new Orchestrator(cfg);
      const judge = { calls: 0 };
      const state: SemanticMergeLifecycleState = {
        memoryDir,
        cfg,
        orchestrators: [primary],
        calls: [],
        judge,
      };
      state.calls = stubExtraction(primary, (turns) =>
        singleFactResult(
          // Identical buffered turns (the replay row keeps its in-window
          // duplicate buffered) collapse to one fact body so the neighbor
          // index sees the same content on the force-flushed re-extraction.
          [...new Set(turns.filter((turn) => turn.role === "user").map((turn) => turn.content))].join(" "),
        ),
      );
      installJudge(primary, judge);

      // In-band neighbors for the row's OWN target ids: candidate resolution
      // runs against the write's storage, so a foreign row's id resolves to
      // nothing and the merge correctly falls back to create.
      const namespacedRow =
        row.id === "explicit-provider-identity" ||
        row.id === "provider-rebinding" ||
        row.id === "sparse-metadata-with-binding" ||
        row.id === "sparse-metadata-without-binding";
      const neighbors = (query: string): Array<{ id: string; score: number }> => {
        if (query === TURN_A || query === INCOMING_A) {
          return [{ id: namespacedRow ? "merge-target-alice" : "merge-target-main", score: BAND_SCORE }];
        }
        if (query === TURN_BOB) return [{ id: "merge-target-bob", score: BAND_SCORE }];
        if (query === TURN_B) return [{ id: "merge-target-main", score: BAND_SCORE }];
        return [];
      };
      installNeighbors(primary, neighbors);

      // Seed the merge targets AFTER construction (cold caches) so the
      // orchestrator's own storage instances discover them on first read.
      if (row.id === "explicit-provider-identity" || row.id === "provider-rebinding") {
        state.aliceRoot = await resolveNamespaceStorageRoot(cfg, "alice");
        state.aliceFile = await seedMergeTarget(state.aliceRoot, "merge-target-alice", SEED_A);
      }
      if (row.id === "sparse-metadata-with-binding" || row.id === "sparse-metadata-without-binding") {
        state.aliceRoot = await resolveNamespaceStorageRoot(cfg, "alice");
        state.aliceFile = await seedMergeTarget(state.aliceRoot, "merge-target-alice", SEED_A);
      }
      if (row.id === "provider-rebinding") {
        state.bobRoot = await resolveNamespaceStorageRoot(cfg, "bob");
        state.bobFile = await seedMergeTarget(state.bobRoot, "merge-target-bob", SEED_B);
      }
      if (
        row.id === "restart-reload-recovery" ||
        row.id === "compaction-flush" ||
        row.id === "before-reset" ||
        row.id === "session-end" ||
        row.id === "dedupe-replay"
      ) {
        state.targetFile = await seedMergeTarget(memoryDir, "merge-target-main", SEED_A);
      }
      return state;
    } catch (err) {
      // Transactional setup: a partial build must not leak the orchestrator or temp dir.
      await primary?.destroy().catch(() => undefined);
      await cleanupDir(memoryDir);
      throw err;
    }
  },

  async exercise(state: SemanticMergeLifecycleState, row: MatrixRow): Promise<void> {
    const primary = state.orchestrators[0];
    switch (row.id) {
      case "explicit-provider-identity": {
        await primary.processTurn("user", TURN_A, "alice:chat");
        assert.equal(await primary.waitForExtractionIdle(15_000), true);
        return;
      }
      case "sparse-metadata-with-binding": {
        await primary.processTurn("user", INCOMING_A, REMEMBERED_SESSION);
        await primary.flushSession(REMEMBERED_SESSION, { reason: "before_reset" });
        assert.equal(await primary.waitForExtractionIdle(15_000), true);
        return;
      }
      case "sparse-metadata-without-binding": {
        await primary.processTurn("user", INCOMING_A, UNBOUND_SESSION);
        await primary.flushSession(UNBOUND_SESSION, { reason: "before_reset" });
        assert.equal(await primary.waitForExtractionIdle(15_000), true);
        return;
      }
      case "provider-rebinding": {
        await primary.processTurn("user", TURN_A, "alice:chat");
        assert.equal(await primary.waitForExtractionIdle(15_000), true);
        await primary.processTurn("user", TURN_BOB, "bob:chat");
        assert.equal(await primary.waitForExtractionIdle(15_000), true);
        return;
      }
      case "restart-reload-recovery": {
        await primary.processTurn("user", TURN_A, "session-merge");
        assert.equal(await primary.waitForExtractionIdle(15_000), true);
        await primary.destroy();
        state.orchestrators.length = 0;
        const second = new Orchestrator(mergeLifecycleConfig(state.memoryDir));
        state.orchestrators.push(second);
        state.restartCalls = stubExtraction(second, (turns) =>
          singleFactResult(
            turns
              .filter((turn) => turn.role === "user")
              .map((turn) => turn.content)
              .join(" "),
          ),
        );
        installJudge(second, state.judge);
        installNeighbors(second, (query) =>
          query === TURN_B ? [{ id: "merge-target-main", score: BAND_SCORE }] : [],
        );
        await second.processTurn("user", TURN_B, "session-merge");
        assert.equal(await second.waitForExtractionIdle(15_000), true);
        return;
      }
      case "compaction-flush": {
        await primary.processTurn("user", INCOMING_A, "session-compact");
        await primary.processTurn("assistant", "Noted the Tuesday deploy detail.", "session-compact");
        await primary.flushSession("session-compact", { reason: "compaction" });
        return;
      }
      case "before-reset": {
        await primary.processTurn("user", INCOMING_A, "session-reset");
        await primary.flushSession("session-reset", { reason: "before_reset" });
        return;
      }
      case "session-end": {
        await primary.processTurn("user", INCOMING_A, "session-end");
        await primary.flushSession("session-end", { reason: "session_end" });
        return;
      }
      case "dedupe-replay": {
        await primary.processTurn("user", TURN_A, "session-dedupe");
        assert.equal(await primary.waitForExtractionIdle(15_000), true);
        await primary.processTurn("user", TURN_A, "session-dedupe");
        assert.equal(await primary.waitForExtractionIdle(15_000), true);
        state.callsBeforeForceFlush = state.calls.length;
        await primary.flushSession("session-dedupe", { reason: "before_reset" });
        return;
      }
      default: {
        const exhaustive: never = row.id;
        throw new Error(`unhandled row ${String(exhaustive)}`);
      }
    }
  },

  async invariants(state: SemanticMergeLifecycleState, row: MatrixRow): Promise<void> {
    const primary = state.orchestrators[0];
    assert.equal(state.cfg.semanticMerge.enabled, true, "every lifecycle row enables semantic merge-on-write");
    switch (row.id) {
      case "explicit-provider-identity": {
        assert.equal(state.judge.calls, 1, "the turn extracts and merges exactly once");
        assert.ok(state.aliceFile);
        await assertMerged(state.aliceFile, [NEEDLE_SEED_A, NEEDLE_A], 1);
        assert.equal(
          (await markdownFilesUnder(path.join(state.aliceRoot ?? "", "facts"))).length,
          1,
          "a merge updates in place — no second fragment",
        );
        assert.equal(
          (await markdownFilesUnder(path.join(state.memoryDir, "facts"))).length,
          0,
          "an identity-routed merge must not land in the default root",
        );
        return;
      }
      case "sparse-metadata-with-binding": {
        assert.equal(state.judge.calls, 1);
        assert.ok(state.aliceFile);
        await assertMerged(state.aliceFile, [NEEDLE_SEED_A, NEEDLE_A], 1);
        assert.equal((await markdownFilesUnder(path.join(state.aliceRoot ?? "", "facts"))).length, 1);
        return;
      }
      case "sparse-metadata-without-binding": {
        // The unbound session must NOT merge into alice's target: candidate
        // resolution runs against the WRITE's storage, where her id is unknown.
        assert.equal(state.judge.calls, 0, "no candidate resolves for an unbound session — the judge is never asked");
        assert.ok(state.aliceFile);
        const raw = await readFile(state.aliceFile, "utf8");
        assert.ok(raw.includes(NEEDLE_SEED_A), "alice's target keeps its original body");
        assert.ok(!raw.includes(NEEDLE_A), "an unbound session must not merge into alice's target");
        assert.ok(!raw.includes("derived_via"), "alice's target carries no merge provenance");
        assert.equal(
          (await markdownFilesUnder(path.join(state.memoryDir, "facts"))).length,
          1,
          "the fact is CREATED in the default root instead of merging cross-tenant",
        );
        return;
      }
      case "provider-rebinding": {
        assert.equal(state.judge.calls, 2, "each identity's turn merges exactly once");
        assert.ok(state.aliceFile && state.bobFile);
        const aliceRaw = await readFile(state.aliceFile, "utf8");
        const bobRaw = await readFile(state.bobFile, "utf8");
        assert.ok(aliceRaw.includes(NEEDLE_A) && aliceRaw.includes(NEEDLE_SEED_A));
        assert.ok(bobRaw.includes(NEEDLE_BOB) && bobRaw.includes(NEEDLE_SEED_B));
        assert.ok(!aliceRaw.includes(NEEDLE_BOB), "bob's fact must not merge into alice's target");
        assert.ok(!bobRaw.includes(NEEDLE_A), "alice's fact must not merge into bob's target");
        assert.ok(aliceRaw.includes("derived_via: merge") && bobRaw.includes("derived_via: merge"));
        return;
      }
      case "restart-reload-recovery": {
        const second = state.orchestrators[0];
        assert.ok(state.targetFile);
        assert.equal(state.judge.calls, 2, "one merge before the restart, one through the restarted instance");
        await assertMerged(state.targetFile, [NEEDLE_SEED_A, NEEDLE_A, NEEDLE_B], 2);
        assert.equal(
          (await markdownFilesUnder(path.join(state.memoryDir, "facts"))).length,
          1,
          "both merges update the SAME target — restart must not fork a fragment",
        );
        const context = await second.recall("What does the billing service deploy include?", "reader");
        assert.match(context, /payments module/i, "the post-restart merge is recallable");
        return;
      }
      case "compaction-flush": {
        assert.equal(state.calls.length, 1, "the flush compacts the buffered turns into one extraction");
        assert.deepEqual(
          state.calls[0]?.map((turn) => turn.content),
          [INCOMING_A, "Noted the Tuesday deploy detail."],
        );
        assert.equal(state.judge.calls, 1);
        assert.ok(state.targetFile);
        await assertMerged(state.targetFile, [NEEDLE_SEED_A, NEEDLE_A], 1);
        assert.equal((await markdownFilesUnder(path.join(state.memoryDir, "facts"))).length, 1);
        return;
      }
      case "before-reset": {
        assert.equal(state.judge.calls, 1);
        assert.ok(state.targetFile);
        await assertMerged(state.targetFile, [NEEDLE_SEED_A, NEEDLE_A], 1);
        const merged = await readFile(state.targetFile, "utf8");
        await primary.flushSession("session-reset", { reason: "before_reset" });
        assert.equal(state.judge.calls, 1, "an empty-buffer re-flush must not merge again");
        assert.equal(
          await readFile(state.targetFile, "utf8").then((raw) => raw === merged),
          true,
          "the drained re-flush leaves the merged target byte-identical",
        );
        assert.equal((await markdownFilesUnder(path.join(state.memoryDir, "facts"))).length, 1);
        return;
      }
      case "session-end": {
        assert.equal(state.calls.length, 1, "session_end drains the buffer like before_reset");
        assert.equal(state.judge.calls, 1);
        assert.ok(state.targetFile);
        await assertMerged(state.targetFile, [NEEDLE_SEED_A, NEEDLE_A], 1);
        assert.equal((await markdownFilesUnder(path.join(state.memoryDir, "facts"))).length, 1);
        return;
      }
      case "dedupe-replay": {
        assert.equal(
          state.callsBeforeForceFlush,
          1,
          "the in-window duplicate must be suppressed — one extraction before the force flush",
        );
        assert.equal(state.calls.length, 2, "the force flush bypasses the dedupe fingerprint and re-extracts");
        assert.equal(state.judge.calls, 2, "the replayed duplicate MERGES AGAIN into the same target");
        assert.ok(state.targetFile);
        await assertMerged(state.targetFile, [NEEDLE_SEED_A, NEEDLE_A], 2);
        assert.equal(
          (await markdownFilesUnder(path.join(state.memoryDir, "facts"))).length,
          1,
          "replaying the duplicate must not fork a second fragment",
        );
        return;
      }
      default: {
        const exhaustive: never = row.id;
        throw new Error(`unhandled row ${String(exhaustive)}`);
      }
    }
  },

  async teardown(state: SemanticMergeLifecycleState): Promise<void> {
    for (const orchestrator of state.orchestrators) {
      await orchestrator.destroy().catch(() => undefined);
    }
    await cleanupDir(state.memoryDir);
  },
};

test("a merged target's new claims reach the temporal timeline index (round N+7 D)", async () => {
  const memoryDir = await mkTempMemoryDir("semantic-merge-temporal");
  let orch: Orchestrator | undefined;
  try {
    const cfg = mergeLifecycleConfig(memoryDir, { queryAwareIndexingEnabled: true });
    orch = new Orchestrator(cfg);
    const judge = { calls: 0 };
    installJudge(orch, judge);
    const targetFile = await seedMergeTarget(memoryDir, "merge-target-temporal", SEED_A);
    // Turn 1: an unrelated created fact bootstraps the temporal index, so the
    // seeded target is indexed with its PRE-merge text (which has no
    // "sharp") and turn 2 runs the INCREMENTAL, id-filtered update.
    const FIRST = "The audit service tracks quarterly access reviews.";
    stubExtraction(orch, () => ({
      facts: [{ category: "fact", content: FIRST, confidence: 0.9, tags: [] }],
      entities: [],
      relationships: [],
      questions: [],
      profileUpdates: [],
    }));
    installNeighbors(orch, () => []);
    await orch.processTurn("user", `Please remember: ${FIRST}`, "session-temporal-1");
    assert.equal(await orch.waitForExtractionIdle(15_000), true);
    // Turn 1's temporal-index bootstrap is fire-and-forget: wait until it
    // has COMPLETED (the created fact's row is served) so turn 2 runs the
    // INCREMENTAL id-filtered update instead of re-bootstrapping the whole
    // corpus — a re-bootstrap would index the already-merged target even
    // without the fix, masking the defect.
    let bootstrapped = false;
    for (let attempt = 0; attempt < 40 && !bootstrapped; attempt++) {
      const events =
        (await queryTemporalTimelineAsync(memoryDir, { query: "quarterly", limit: 10 })) ?? [];
      bootstrapped = events.length > 0;
      if (!bootstrapped) await sleep(250);
    }
    assert.ok(bootstrapped, "turn 1's temporal index bootstrap must complete");
    // Turn 2: the merge commits "09:00 UTC sharp" into the target.
    stubExtraction(orch, () => ({
      facts: [{ category: "fact", content: INCOMING_A, confidence: 0.9, tags: [] }],
      entities: [],
      relationships: [],
      questions: [],
      profileUpdates: [],
    }));
    installNeighbors(orch, (query) =>
      query === INCOMING_A ? [{ id: "merge-target-temporal", score: BAND_SCORE }] : [],
    );
    await orch.processTurn("user", `Please remember: ${INCOMING_A}`, "session-temporal-2");
    assert.equal(await orch.waitForExtractionIdle(15_000), true);
    assert.equal(judge.calls, 1);
    await assertMerged(targetFile, ["Tuesday cadence", "09:00 UTC sharp"], 1);
    // Membership in the returned rows is not evidence on its own: with few
    // rows the query returns the chronology unfiltered (and the no-match
    // fallback returns both edges). Assert the merged token's HASH is on the
    // target's own row — the exact contract queryTemporalTimelineAsync
    // scores against.
    const sharpToken = crypto.createHash("sha256").update("sharp").digest("hex");
    let served = false;
    for (let attempt = 0; attempt < 40 && !served; attempt++) {
      const events =
        (await queryTemporalTimelineAsync(memoryDir, { query: "sharp", limit: 10 })) ?? [];
      served = events.some(
        (event) =>
          event.path.endsWith("merge-target-temporal.md") &&
          (event.searchTokenHashes ?? []).includes(sharpToken),
      );
      if (!served) await sleep(250);
    }
    assert.ok(
      served,
      "event-order queries must find the merged target's new tokens without a full rebuild",
    );
  } finally {
    await orch?.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});

test("a cold-tier merged target's new claims reach the temporal timeline index (round N+9 B)", async () => {
  const memoryDir = await mkTempMemoryDir("semantic-merge-temporal-cold");
  let orch: Orchestrator | undefined;
  try {
    const cfg = mergeLifecycleConfig(memoryDir, { queryAwareIndexingEnabled: true });
    orch = new Orchestrator(cfg);
    const judge = { calls: 0 };
    installJudge(orch, judge);
    // The target lives under cold/ — invisible to the hot-only
    // readAllMemories() scan that builds the incremental temporal-index
    // pool, so only a cold-aware id lookup can refresh its row.
    const coldFile = await seedMergeTarget(memoryDir, "merge-target-cold-temporal", SEED_A, {
      tier: "cold",
    });
    // Turn 1 bootstraps the index from a hot fact so turn 2 runs the
    // INCREMENTAL id-filtered update (a re-bootstrap would index the cold
    // target even without the fix, masking the defect).
    const FIRST = "The audit service tracks quarterly access reviews.";
    stubExtraction(orch, () => ({
      facts: [{ category: "fact", content: FIRST, confidence: 0.9, tags: [] }],
      entities: [],
      relationships: [],
      questions: [],
      profileUpdates: [],
    }));
    installNeighbors(orch, () => []);
    await orch.processTurn("user", `Please remember: ${FIRST}`, "session-temporal-cold-1");
    assert.equal(await orch.waitForExtractionIdle(15_000), true);
    let bootstrapped = false;
    for (let attempt = 0; attempt < 40 && !bootstrapped; attempt++) {
      const events =
        (await queryTemporalTimelineAsync(memoryDir, { query: "quarterly", limit: 10 })) ?? [];
      bootstrapped = events.length > 0;
      if (!bootstrapped) await sleep(250);
    }
    assert.ok(bootstrapped, "turn 1's temporal index bootstrap must complete");
    // Turn 2: the merge commits "09:00 UTC sharp" into the COLD target.
    stubExtraction(orch, () => ({
      facts: [{ category: "fact", content: INCOMING_A, confidence: 0.9, tags: [] }],
      entities: [],
      relationships: [],
      questions: [],
      profileUpdates: [],
    }));
    installNeighbors(orch, (query) =>
      query === INCOMING_A ? [{ id: "merge-target-cold-temporal", score: BAND_SCORE }] : [],
    );
    await orch.processTurn("user", `Please remember: ${INCOMING_A}`, "session-temporal-cold-2");
    assert.equal(await orch.waitForExtractionIdle(15_000), true);
    assert.equal(judge.calls, 1);
    await assertMerged(coldFile, ["Tuesday cadence", "09:00 UTC sharp"], 1);
    // Same token-hash contract as the hot-tier test above: the merged
    // token's HASH must sit on the cold target's own row.
    const sharpToken = crypto.createHash("sha256").update("sharp").digest("hex");
    let served = false;
    for (let attempt = 0; attempt < 40 && !served; attempt++) {
      const events =
        (await queryTemporalTimelineAsync(memoryDir, { query: "sharp", limit: 10 })) ?? [];
      served = events.some(
        (event) =>
          event.path.endsWith("merge-target-cold-temporal.md") &&
          (event.searchTokenHashes ?? []).includes(sharpToken),
      );
      if (!served) await sleep(250);
    }
    assert.ok(
      served,
      "event-order queries must find the cold-tier merged target's new tokens",
    );
  } finally {
    await orch?.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});

test("repeated merges leave exactly one generated edge per graph type for the target (round N+7 G)", async () => {
  const memoryDir = await mkTempMemoryDir("semantic-merge-graph-parity");
  let orch: Orchestrator | undefined;
  try {
    const cfg = mergeLifecycleConfig(memoryDir, {
      multiGraphMemoryEnabled: true,
      threadingEnabled: true,
    });
    orch = new Orchestrator(cfg);
    const judge = { calls: 0 };
    installJudge(orch, judge);
    // Two turns; each creates its own thread-local fact (becomes that
    // thread's first episode) and merges a because-sentence into the SAME
    // target. Each merge appends time+causal edges INTO the target from that
    // turn's created fact — without per-type replacement the second merge
    // duplicates them.
    const GRAPH_INCOMING_2 =
      "The billing service deploy window opens early because the EU handoff needs overlap.";
    let extractionCall = 0;
    stubExtraction(orch, () => {
      extractionCall++;
      return {
        facts: [
          {
            category: "fact",
            content: extractionCall === 1 ? "The audit service tracks quarterly access reviews." : "The audit service also archives vendor onboarding evidence.",
            confidence: 0.9,
            tags: [],
          },
          {
            category: "fact",
            content: extractionCall === 1 ? GRAPH_INCOMING : GRAPH_INCOMING_2,
            confidence: 0.9,
            tags: [],
          },
        ],
        entities: [],
        relationships: [],
        questions: [],
        profileUpdates: [],
      };
    });
    installNeighbors(orch, (query) =>
      query === GRAPH_INCOMING || query === GRAPH_INCOMING_2
        ? [{ id: "merge-target-parity", score: BAND_SCORE }]
        : [],
    );
    const targetFile = await seedMergeTarget(memoryDir, "merge-target-parity", GRAPH_SEED, {
      extraFrontmatter: ["entityRef: entity-billing-service"],
    });
    await seedMergeTarget(memoryDir, "merge-sibling-parity", GRAPH_SIBLING, {
      extraFrontmatter: ["entityRef: entity-billing-service"],
    });
    await orch.processTurn("user", `Please remember: ${GRAPH_INCOMING}`, "session-parity-1");
    assert.equal(await orch.waitForExtractionIdle(15_000), true);
    await orch.processTurn("user", `Please remember: ${GRAPH_INCOMING_2}`, "session-parity-2");
    assert.equal(await orch.waitForExtractionIdle(15_000), true);

    assert.equal(judge.calls, 2, "both turns must reach the judge");
    await assertMerged(targetFile, ["Tuesday cadence", "09:00 UTC"], 2);

    const entityEdges = await readGraphEdges(memoryDir, "entity");
    assert.equal(
      entityEdges.filter((e) => e.from.endsWith("merge-target-parity.md")).length,
      1,
      "entity: the target's from-side edges are replaced, not accumulated",
    );
    const timeEdges = await readGraphEdges(memoryDir, "time");
    assert.equal(
      timeEdges.filter((e) => e.to.endsWith("merge-target-parity.md")).length,
      1,
      `time: one inbound edge for the target, got ${JSON.stringify(timeEdges)}`,
    );
    const causalEdges = await readGraphEdges(memoryDir, "causal");
    assert.equal(
      causalEdges.filter((e) => e.to.endsWith("merge-target-parity.md")).length,
      1,
      `causal: one inbound edge for the target, got ${JSON.stringify(causalEdges)}`,
    );
  } finally {
    await orch?.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});

runLifecycleMatrix("semantic-merge-lifecycle", subject);
