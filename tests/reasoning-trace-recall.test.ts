/**
 * Tests for reasoning_trace recall boost + storage routing (issue #564 PR 3).
 *
 * Covers:
 * - looksLikeProblemSolvingQuery heuristic accept/reject matrix.
 * - isReasoningTracePath path-segment detection.
 * - applyReasoningTraceBoost: no-op when disabled / wrong query / no traces
 *   in results; re-sorts boosted traces to the top when enabled + matching.
 * - Config parsing: recallReasoningTraceBoostEnabled defaults false, accepts
 *   explicit true, and tolerates the usual coerceBool string variants.
 * - StorageManager.writeMemory routes category="reasoning_trace" into a
 *   dedicated reasoning-traces/<date>/ subtree and ensureDirectories
 *   pre-creates that tree.
 * - readAllMemories discovers memories written to reasoning-traces/ so they
 *   show up for downstream retrieval.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { access, mkdtemp, rm } from "node:fs/promises";

import {
  applyReasoningTraceBoost,
  isReasoningTracePath,
  looksLikeProblemSolvingQuery,
  DEFAULT_REASONING_TRACE_BOOST,
} from "../packages/remnic-core/src/reasoning-trace-recall.js";
import { parseConfig } from "../packages/remnic-core/src/config.js";
import { StorageManager } from "@remnic/core/storage";

describe("looksLikeProblemSolvingQuery", () => {
  it("accepts 'how do I' style starts", () => {
    assert.equal(looksLikeProblemSolvingQuery("How do I debug this deadlock?"), true);
    assert.equal(looksLikeProblemSolvingQuery("how can I make this faster"), true);
    assert.equal(looksLikeProblemSolvingQuery("How would I approach sharding?"), true);
    assert.equal(looksLikeProblemSolvingQuery("how to configure Vite with TS"), true);
  });

  it("accepts 'step by step' and 'walk me through' variants", () => {
    assert.equal(looksLikeProblemSolvingQuery("show me step by step"), true);
    assert.equal(looksLikeProblemSolvingQuery("walk me through the refactor"), true);
    assert.equal(looksLikeProblemSolvingQuery("let's work through this"), true);
  });

  it("accepts reasoning/chain-of-thought phrasing", () => {
    assert.equal(looksLikeProblemSolvingQuery("reason through the tradeoffs"), true);
    assert.equal(looksLikeProblemSolvingQuery("show me the chain of thought"), true);
    assert.equal(looksLikeProblemSolvingQuery("help me troubleshoot the deploy"), true);
  });

  it("rejects ordinary queries", () => {
    assert.equal(looksLikeProblemSolvingQuery("What's the user's favorite editor?"), false);
    assert.equal(looksLikeProblemSolvingQuery("Acme Corp address"), false);
    assert.equal(looksLikeProblemSolvingQuery("latest commitment about the release"), false);
    assert.equal(looksLikeProblemSolvingQuery(""), false);
  });
});

describe("isReasoningTracePath", () => {
  it("matches reasoning-traces subtree (both separators)", () => {
    assert.equal(isReasoningTracePath("reasoning-traces/2026-04-20/foo.md"), true);
    assert.equal(isReasoningTracePath("/base/reasoning-traces/2026-04-20/foo.md"), true);
    assert.equal(isReasoningTracePath("C\\base\\reasoning-traces\\x.md"), true);
  });

  it("does not match confusables", () => {
    assert.equal(isReasoningTracePath("my-reasoning-traces-notes/foo.md"), false);
    assert.equal(isReasoningTracePath("facts/2026-04-20/foo.md"), false);
    assert.equal(isReasoningTracePath(""), false);
  });
});

describe("applyReasoningTraceBoost", () => {
  const fixture = [
    { docid: "a", path: "facts/2026-04-20/a.md", score: 0.9 },
    { docid: "b", path: "reasoning-traces/2026-04-20/b.md", score: 0.6 },
    { docid: "c", path: "facts/2026-04-20/c.md", score: 0.8 },
    { docid: "d", path: "reasoning-traces/2026-04-19/d.md", score: 0.5 },
  ];

  it("is a no-op when disabled", () => {
    const out = applyReasoningTraceBoost(fixture, {
      enabled: false,
      query: "how do I debug",
    });
    assert.deepEqual(
      out.map((r) => r.docid),
      ["a", "b", "c", "d"],
    );
    // Input not mutated.
    assert.equal(fixture[1].score, 0.6);
  });

  it("is a no-op for non-problem-solving queries", () => {
    const out = applyReasoningTraceBoost(fixture, {
      enabled: true,
      query: "what's Alice's favorite editor",
    });
    assert.deepEqual(
      out.map((r) => r.docid),
      ["a", "b", "c", "d"],
    );
  });

  it("is a no-op when no reasoning traces are in the result list", () => {
    const facts = fixture.filter((r) => !isReasoningTracePath(r.path));
    const out = applyReasoningTraceBoost(facts, {
      enabled: true,
      query: "how do I debug",
    });
    assert.deepEqual(
      out.map((r) => r.docid),
      facts.map((r) => r.docid),
    );
  });

  it("promotes traces past lower-scored neighbors without re-sorting the full list", () => {
    // Lower-boost case: default 0.15 boost bumps b to 0.75 and d to 0.65,
    // but fact-a (0.9) and fact-c (0.8) both still outscore them, so the
    // order shouldn't change — critically, we do NOT globally re-sort
    // (which would move b ahead of c by pure score). Non-trace items keep
    // their incoming relative order so reranker-driven ordering survives.
    const out = applyReasoningTraceBoost(fixture, {
      enabled: true,
      query: "how do I debug the latency spike?",
    });
    assert.deepEqual(
      out.map((r) => r.docid),
      ["a", "b", "c", "d"],
    );
    const b = out.find((r) => r.docid === "b");
    assert.equal(b?.score, 0.6 + DEFAULT_REASONING_TRACE_BOOST);
  });

  it("honors a custom boost amount and promotes traces past lower-scored facts", () => {
    const out = applyReasoningTraceBoost(fixture, {
      enabled: true,
      query: "walk me through the debug",
      boost: 1.0, // enormous — trace scores beat every fact
    });
    // b (trace, 0.6+1.0=1.6) promotes past a (0.9). d (trace, 0.5+1.0=1.5)
    // promotes past c (0.8). Trace-vs-trace order preserved (b before d
    // since it appeared earlier in the input).
    assert.deepEqual(
      out.map((r) => r.docid),
      ["b", "d", "a", "c"],
    );
  });

  it("preserves rerank order on non-trace items when traces move up", () => {
    // Input simulates a reranker output: fact-a has stale low score but
    // higher position, fact-b has a higher numeric score but lower
    // position (classic rerank-rewrites-order-not-scores shape). The
    // boost must promote the trace past fact-b (whose score is lower
    // than the boosted trace) without globally re-sorting, so the
    // reranker-preferred order [fact-a, fact-b] is kept.
    const rerankShape = [
      { docid: "fact-a-reranked", path: "facts/a.md", score: 0.40 },
      { docid: "fact-b-lower-rank", path: "facts/b.md", score: 0.60 },
      { docid: "the-trace", path: "reasoning-traces/t.md", score: 0.50 },
    ];
    const out = applyReasoningTraceBoost(rerankShape, {
      enabled: true,
      query: "how do I debug",
    });
    // trace: 0.50+0.15=0.65. Walk back: prev=fact-b-lower-rank(0.60)
    // which is strictly less than 0.65 → promote past. prev=fact-a
    // -reranked(0.40) which is also strictly less → promote past. Final
    // order puts trace first. Critically, fact-a-reranked stays ahead
    // of fact-b-lower-rank (the reranker's intended order) rather than
    // being re-sorted by score.
    assert.deepEqual(
      out.map((r) => r.docid),
      ["the-trace", "fact-a-reranked", "fact-b-lower-rank"],
    );
  });

  it("preserves stable tie-break on equal scores", () => {
    const ties = [
      { docid: "x", path: "facts/a.md", score: 0.5 },
      { docid: "y", path: "reasoning-traces/a.md", score: 0.35 },
      { docid: "z", path: "facts/b.md", score: 0.5 },
    ];
    const out = applyReasoningTraceBoost(ties, {
      enabled: true,
      query: "how do I",
    });
    // y boosts to 0.5 → three-way tie; stable order preserves original index.
    assert.deepEqual(
      out.map((r) => r.docid),
      ["x", "y", "z"],
    );
  });
});

describe("config recallReasoningTraceBoostEnabled", () => {
  it("defaults to false", () => {
    const cfg = parseConfig({ memoryDir: "/tmp/remnic-cfg-default" });
    assert.equal(cfg.recallReasoningTraceBoostEnabled, false);
  });

  it("accepts boolean true", () => {
    const cfg = parseConfig({
      memoryDir: "/tmp/remnic-cfg-on",
      recallReasoningTraceBoostEnabled: true,
    });
    assert.equal(cfg.recallReasoningTraceBoostEnabled, true);
  });

  it("accepts string 'true'", () => {
    const cfg = parseConfig({
      memoryDir: "/tmp/remnic-cfg-str",
      recallReasoningTraceBoostEnabled: "true",
    });
    assert.equal(cfg.recallReasoningTraceBoostEnabled, true);
  });

  it("stays false for string 'false'", () => {
    const cfg = parseConfig({
      memoryDir: "/tmp/remnic-cfg-str-false",
      recallReasoningTraceBoostEnabled: "false",
    });
    assert.equal(cfg.recallReasoningTraceBoostEnabled, false);
  });
});

describe("StorageManager reasoning_trace routing", () => {
  it("routes a reasoning_trace memory under reasoning-traces/<date>/", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-reasoning-trace-route-"));
    try {
      const storage = new StorageManager(dir);
      const body = [
        "How I picked route-b for the low-latency path",
        "",
        "## Step 1",
        "",
        "Enumerated candidate routes.",
        "",
        "## Step 2",
        "",
        "Measured round-trip times.",
        "",
        "## Final Answer",
        "",
        "route-b won and was pinned.",
      ].join("\n");

      const { id: id } = await storage.writeMemory("reasoning_trace", body, {
        source: "test",
        tags: ["reasoning"],
        confidence: 0.9,
      });

      const today = new Date().toISOString().slice(0, 10);
      const expected = path.join(dir, "reasoning-traces", today, `${id}.md`);
      await access(expected); // throws if not present

      const memories = await storage.readAllMemories();
      const found = memories.find((m) => m.frontmatter.id === id);
      assert.ok(found, "written reasoning-trace memory should be discoverable");
      assert.equal(found.frontmatter.category, "reasoning_trace");
      assert.ok(
        found.path.includes(path.join("reasoning-traces", today)),
        `expected path to include reasoning-traces/${today}/, got: ${found.path}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ensureDirectories pre-creates the reasoning-traces/<date>/ tree", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-reasoning-trace-ensure-"));
    try {
      const storage = new StorageManager(dir);
      await storage.ensureDirectories();
      const today = new Date().toISOString().slice(0, 10);
      await access(path.join(dir, "reasoning-traces", today));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("buildTierMemoryPath preserves the reasoning-traces/ subtree across tier moves", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-reasoning-trace-tier-"));
    try {
      const storage = new StorageManager(dir);
      const body = [
        "How I picked route-b",
        "",
        "## Step 1",
        "",
        "Enumerated candidate routes.",
        "",
        "## Step 2",
        "",
        "Measured round-trip times.",
        "",
        "## Final Answer",
        "",
        "route-b pinned.",
      ].join("\n");
      const { id: id } = await storage.writeMemory("reasoning_trace", body, {
        source: "test",
      });
      const memories = await storage.readAllMemories();
      const found = memories.find((m) => m.frontmatter.id === id);
      assert.ok(found, "stored reasoning_trace should be readable");

      // Both hot and cold migration targets must live under reasoning-traces/.
      const hot = storage.buildTierMemoryPath(found, "hot");
      const cold = storage.buildTierMemoryPath(found, "cold");
      assert.ok(
        hot.includes(`${path.sep}reasoning-traces${path.sep}`),
        `hot tier path should remain under reasoning-traces/, got: ${hot}`,
      );
      assert.ok(
        cold.includes(`${path.sep}reasoning-traces${path.sep}`),
        `cold tier path should remain under reasoning-traces/, got: ${cold}`,
      );
      // And it must NOT be funneled into facts/ — that would break
      // isReasoningTracePath() and silently disable the recall boost.
      assert.ok(
        !/[\\/]facts[\\/]/.test(hot),
        `reasoning_trace must not be migrated into facts/: ${hot}`,
      );
      assert.ok(
        !/[\\/]facts[\\/]/.test(cold),
        `reasoning_trace must not be migrated into facts/: ${cold}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("buildTierMemoryPath routes a decision into <root>/decisions/<date>/ (issue #1546)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-decision-tier-"));
    try {
      const storage = new StorageManager(dir);
      const { id: id } = await storage.writeMemory("decision", "We chose blue-green deploys.", {
        source: "test",
      });
      const memories = await storage.readAllMemories();
      const found = memories.find((m) => m.frontmatter.id === id);
      assert.ok(found, "stored decision should be readable");

      const hot = storage.buildTierMemoryPath(found, "hot");
      const cold = storage.buildTierMemoryPath(found, "cold");
      assert.ok(
        hot.includes(`${path.sep}decisions${path.sep}`),
        `hot tier path should be under decisions/, got: ${hot}`,
      );
      assert.ok(
        cold.includes(`${path.sep}cold${path.sep}decisions${path.sep}`),
        `cold tier path should be under cold/decisions/, got: ${cold}`,
      );
      // The generic tail must not funnel non-fact categories into facts/.
      assert.ok(
        !/[\\/]facts[\\/]/.test(hot),
        `decision must not be migrated into facts/: ${hot}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
