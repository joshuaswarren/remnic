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
  stubExtraction,
} from "../orchestrator-lite.js";

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
async function seedMergeTarget(root: string, id: string, content: string): Promise<string> {
  const created = pastIso();
  const dir = path.join(root, "facts", created.slice(0, 10));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.md`);
  await writeFile(
    file,
    [
      "---",
      `id: ${id}`,
      "category: fact",
      `created: ${created}`,
      `updated: ${created}`,
      "source: extraction",
      "confidence: 0.9",
      "confidenceTier: explicit",
      "status: active",
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

runLifecycleMatrix("semantic-merge-lifecycle", subject);
