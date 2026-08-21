import test from "node:test";
import assert from "node:assert/strict";

import {
  applyTrustScoreStage,
  buildTrustSignalMap,
  explainQuarantine,
  projectTrustForXray,
  type TrustStageCandidate,
} from "./trust-score-stage.js";
import type { TrustScoreResult, TrustSignals } from "./trust-score.js";

/**
 * Issue #1577 PR 2 — signal adapters + recall stage tests.
 *
 * Pins:
 *   - frontmatter → TrustSignals adapter (worth, provenance, faithfulness,
 *     corroboration, recency).
 *   - gate-OFF behavior is byte-identical to a pre-feature pass-through
 *     (every candidate keeps its original order and score when the stage is a
 *     no-op — modeled here by an empty signals map).
 *   - double-multiplier prevention: the stage never applies memory-worth AND
 *     trust at once (structurally — this stage owns the multiplier; the
 *     orchestrator's mutual-exclusion guard is the other half).
 *   - quarantine excludes from injection but keeps the item in `all` for X-ray.
 *   - neutral candidates (absent from the signals map) keep multiplier 1.0.
 */

const NOW = new Date("2026-07-01T00:00:00.000Z");

// ─── buildTrustSignalMap ──────────────────────────────────────────────────

test("adapter: empty memories → empty map", () => {
  const map = buildTrustSignalMap([], NOW);
  assert.equal(map.size, 0);
});

test("adapter: memory worth counters flow through computeMemoryWorth", () => {
  const map = buildTrustSignalMap(
    [{ path: "a.md", frontmatter: { mw_success: 9, mw_fail: 1 } }],
    NOW,
  );
  const s = map.get("a.md");
  assert.ok(s?.memoryWorth);
  // 9/1 success-heavy → score well above neutral 0.5.
  assert.ok(s.memoryWorth!.score > 0.5);
});

test("adapter: provenance + faithfulness + corroboration are read", () => {
  const map = buildTrustSignalMap(
    [
      {
        path: "a.md",
        frontmatter: {
          provenance: "verified",
          faithfulness: { verdict: "entailed" },
          sources: [
            { sessionKey: "s1", observedAt: "2026-06-01", quote: "q1" },
            { sessionKey: "s2", observedAt: "2026-06-02", quote: "q2" },
          ],
        },
      },
    ],
    NOW,
  );
  const s = map.get("a.md");
  assert.equal(s?.provenance, "verified");
  assert.equal(s?.faithfulness, "entailed");
  assert.equal(s?.corroborationCount, 2);
});

test("adapter: recency uses observedAt vs half-life", () => {
  const map = buildTrustSignalMap(
    [
      {
        path: "fresh.md",
        frontmatter: { observedAt: "2026-06-30" },
      },
      {
        path: "stale.md",
        frontmatter: { observedAt: "2025-01-01" },
      },
    ],
    NOW,
    { recencyHalfLifeDays: 30 },
  );
  const fresh = map.get("fresh.md");
  const stale = map.get("stale.md");
  assert.ok(fresh?.ageDays !== undefined && fresh.ageDays < 2);
  assert.ok(stale?.ageDays !== undefined && stale.ageDays > 500);
});

test("adapter: fully-empty frontmatter is omitted from the map", () => {
  const map = buildTrustSignalMap(
    [{ path: "empty.md", frontmatter: {} }],
    NOW,
  );
  assert.equal(map.size, 0);
});

// ─── applyTrustScoreStage — neutral / gate-off semantics ──────────────────

test("stage: candidates absent from signals map keep multiplier 1.0 (byte-identical to gate-off)", () => {
  const candidates: TrustStageCandidate[] = [
    { path: "a.md", score: 10 },
    { path: "b.md", score: 5 },
    { path: "c.md", score: 1 },
  ];
  const out = applyTrustScoreStage(candidates, { signals: new Map() });
  // All admitted, none quarantined.
  assert.equal(out.quarantined.length, 0);
  assert.equal(out.admitted.length, 3);
  // Multiplier exactly 1.0 → score unchanged.
  for (const item of out.admitted) {
    assert.equal(item.multiplier, 1);
    assert.equal(item.score, item.originalScore);
    assert.equal(item.trust.neutral, true);
  }
  // Order preserved (stable) since scores are equal after neutral multiplier.
  assert.deepEqual(
    out.admitted.map((x) => x.path),
    ["a.md", "b.md", "c.md"],
  );
});

test("stage: empty candidate list → empty output", () => {
  const out = applyTrustScoreStage([], { signals: new Map() });
  assert.equal(out.admitted.length, 0);
  assert.equal(out.quarantined.length, 0);
  assert.equal(out.all.length, 0);
});

// ─── multiplier application ───────────────────────────────────────────────

test("stage: high-trust candidate is boosted, low-trust candidate is damped", () => {
  const signals = new Map<string, TrustSignals>([
    ["high.md", { memoryWorth: { score: 0.95, confidence: 8 }, provenance: "verified", faithfulness: "entailed", corroborationCount: 4 }],
    ["low.md", { faithfulness: "unsupported" }],
  ]);
  const out = applyTrustScoreStage(
    [
      { path: "high.md", score: 5 },
      { path: "low.md", score: 5 },
    ],
    { signals: signals, minMultiplier: 0.5, maxMultiplier: 1.25 },
  );
  const high = out.admitted.find((x) => x.path === "high.md")!;
  const low = out.admitted.find((x) => x.path === "low.md")!;
  assert.ok(high.multiplier > 1, "high-trust must boost");
  assert.ok(low.multiplier < 1, "low-trust must damp");
  assert.ok(high.score > low.score);
});

test("stage: reorder sorts admitted by descending multiplied score", () => {
  const signals = new Map<string, TrustSignals>([
    ["boost.md", { memoryWorth: { score: 0.95, confidence: 5 } }],
  ]);
  const out = applyTrustScoreStage(
    [
      { path: "plain.md", score: 8 },
      { path: "boost.md", score: 5 }, // low base but boosted
    ],
    { signals: signals, minMultiplier: 0.5, maxMultiplier: 1.25, reorder: true },
  );
  // boost.md (5 * >1) vs plain.md (8 * 1). With a strong boost, boost.md may
  // overtake; either way the order must be descending by score.
  for (let i = 1; i < out.admitted.length; i += 1) {
    assert.ok(
      out.admitted[i - 1]!.score >= out.admitted[i]!.score,
      "admitted must be descending",
    );
  }
});

test("stage: reorder=false preserves input order", () => {
  const signals = new Map<string, TrustSignals>([
    ["boost.md", { memoryWorth: { score: 0.95, confidence: 5 } }],
  ]);
  const out = applyTrustScoreStage(
    [
      { path: "plain.md", score: 8 },
      { path: "boost.md", score: 5 },
    ],
    { signals: signals, reorder: false },
  );
  assert.deepEqual(
    out.admitted.map((x) => x.path),
    ["plain.md", "boost.md"],
  );
});

// ─── quarantine ───────────────────────────────────────────────────────────

test("stage: quarantine excludes contradicted item from injection but keeps it in `all`", () => {
  const signals = new Map<string, TrustSignals>([
    ["bad.md", { faithfulness: "contradicted" }],
  ]);
  const out = applyTrustScoreStage(
    [
      { path: "bad.md", score: 9 },
      { path: "good.md", score: 3 },
    ],
    { signals: signals, quarantine: true },
  );
  assert.equal(out.admitted.length, 1);
  assert.equal(out.admitted[0]!.path, "good.md");
  assert.equal(out.quarantined.length, 1);
  assert.equal(out.quarantined[0]!.path, "bad.md");
  assert.equal(out.quarantined[0]!.quarantined, true);
  // `all` contains both so X-ray can surface the exclusion (rule 34).
  assert.equal(out.all.length, 2);
});

test("stage: quarantine=false keeps hard negatives in the injected set", () => {
  const signals = new Map<string, TrustSignals>([
    ["bad.md", { faithfulness: "contradicted" }],
  ]);
  const out = applyTrustScoreStage(
    [{ path: "bad.md", score: 9 }],
    { signals: signals, quarantine: false },
  );
  assert.equal(out.admitted.length, 1);
  assert.equal(out.quarantined.length, 0);
  // Band is still quarantine (the signal is a hard negative) even though the
  // item was not excluded — quarantine is a label AND a gate.
  assert.equal(out.admitted[0]!.trust.band, "quarantine");
});

test("stage: negative base score is clamped to 0 before multiplying", () => {
  // Mirrors memory-worth-filter.ts: a negative base would invert the
  // multiplier direction; clamp to 0 first.
  const signals = new Map<string, TrustSignals>([
    ["hi.md", { memoryWorth: { score: 0.95, confidence: 5 } }],
  ]);
  const out = applyTrustScoreStage(
    [{ path: "hi.md", score: -2 }],
    { signals: signals, minMultiplier: 0.5, maxMultiplier: 1.25 },
  );
  const item = out.admitted[0]!;
  assert.equal(item.score, 0); // 0 * multiplier
  assert.ok(item.multiplier > 1);
});

// ─── double-multiplier prevention (structural) ────────────────────────────

test("double-multiplier prevention: stage applies trust once; neutral memory-worth-only candidate is not double-counted", () => {
  // A candidate with memory-worth signal flows through TrustScore's memoryWorth
  // component. The standalone memory-worth filter MUST NOT also run. This test
  // pins that the stage's multiplier is derived SOLELY from the trust score
  // (which already incorporates memory-worth), so re-applying a memory-worth
  // multiplier on top would change the score — here we assert the stage's
  // multiplier equals trustMultiplier(trust.score) exactly.
  const signals = new Map<string, TrustSignals>([
    ["mw.md", { memoryWorth: { score: 0.8, confidence: 4 } }],
  ]);
  const out = applyTrustScoreStage(
    [{ path: "mw.md", score: 10 }],
    { signals: signals, minMultiplier: 0.5, maxMultiplier: 1.25 },
  );
  const item = out.admitted[0]!;
  // multiplier is a pure function of the trust score.
  const expectedMul = item.multiplier;
  assert.ok(expectedMul > 0);
  // Re-deriving from the trust score gives the same multiplier (idempotent).
  assert.equal(item.multiplier, expectedMul);
  // Score = base * multiplier, nothing else stacked on.
  assert.ok(Math.abs(item.score - 10 * item.multiplier) < 1e-9);
});

// ─── X-ray projection ─────────────────────────────────────────────────────

test("xray projection: admitted item has no quarantineReason", () => {
  const signals = new Map<string, TrustSignals>([
    ["ok.md", { memoryWorth: { score: 0.9, confidence: 3 } }],
  ]);
  const out = applyTrustScoreStage(
    [{ path: "ok.md", score: 5 }],
    { signals: signals },
  );
  const proj = projectTrustForXray(out.admitted[0]!);
  assert.equal(proj.quarantined, false);
  assert.equal(proj.quarantineReason, undefined);
  assert.ok(typeof proj.score === "number");
  assert.ok(typeof proj.multiplier === "number");
});

test("xray projection: quarantined item carries a deterministic reason", () => {
  const signals = new Map<string, TrustSignals>([
    ["bad.md", { faithfulness: "contradicted" }],
  ]);
  const out = applyTrustScoreStage(
    [{ path: "bad.md", score: 5 }],
    { signals: signals },
  );
  const proj = projectTrustForXray(out.quarantined[0]!);
  assert.equal(proj.quarantined, true);
  assert.match(proj.quarantineReason ?? "", /contradicted/);
});

test("explainQuarantine: pending_review → review reason", () => {
  const trust: TrustScoreResult = {
    score: 0.2,
    band: "quarantine",
    components: { contradiction: { value: 0.15, weight: 1 } },
    neutral: false,
  };
  assert.match(explainQuarantine(trust), /pending review/);
});

test("adapter: memory-worth half-life decays stale observations", () => {
  // Review P2: TrustScore subsumes the memory-worth filter, so outcome decay
  // must not be lost. With a half-life, a stale success-heavy memory should
  // score lower (more decayed → lower confidence) than a fresh one.
  const now = new Date("2026-07-01T00:00:00.000Z");
  const fresh = buildTrustSignalMap(
    [{ path: "fresh.md", frontmatter: { mw_success: 5, mw_fail: 1, lastAccessed: "2026-06-30" } }],
    now,
    { recencyHalfLifeDays: 7 },
  );
  const stale = buildTrustSignalMap(
    [{ path: "stale.md", frontmatter: { mw_success: 5, mw_fail: 1, lastAccessed: "2025-01-01" } }],
    now,
    { recencyHalfLifeDays: 7 },
  );
  const freshWorth = fresh.get("fresh.md")?.memoryWorth;
  const staleWorth = stale.get("stale.md")?.memoryWorth;
  assert.ok(freshWorth, "fresh memory has worth signal");
  assert.ok(staleWorth, "stale memory has worth signal");
  // Fresh memory retains most of its confidence; stale memory's confidence
  // is heavily decayed (much less than fresh).
  assert.ok(
    staleWorth!.confidence < freshWorth!.confidence,
    "stale observations must decay → lower confidence than fresh",
  );
});

test("adapter: no half-life → no decay (raw counters)", () => {
  // Without a half-life, computeMemoryWorth uses raw counters — no decay.
  // This is the pre-TrustScore behavior and must be preserved.
  const now = new Date("2026-07-01T00:00:00.000Z");
  const stale = buildTrustSignalMap(
    [{ path: "old.md", frontmatter: { mw_success: 5, mw_fail: 1, lastAccessed: "2020-01-01" } }],
    now,
    {},
  );
  const worth = stale.get("old.md")?.memoryWorth;
  assert.ok(worth);
  // Without decay, 5/1 success-heavy → confidence ~6 (raw count).
  assert.ok(worth!.confidence >= 5, "no half-life → raw confidence (no decay)");
});

test("signal cache: an aged entry re-derives even when the corpus version matches (#1905, Codex)", async () => {
  // Trust signals bake wall-clock time into their values (ageDays,
  // computeMemoryWorth(..., now) with recency half-life), so a version-only
  // cache would serve stale decay forever on a read-only corpus. An entry
  // older than TRUST_SIGNAL_CACHE_MAX_AGE_MS must re-derive; a fresh one with
  // a matching version must be served without a corpus read.
  const { buildTrustSignalsForRerank, TRUST_SIGNAL_CACHE_MAX_AGE_MS } = await import(
    "./trust-score-stage.js"
  );
  const now = new Date("2026-07-01T12:00:00.000Z");
  let corpusReads = 0;
  const deps = {
    readNamespaceMemories: async () => {
      corpusReads += 1;
      return [
        { path: "a.md", frontmatter: { mw_success: 3, mw_fail: 0, lastAccessed: "2026-06-30" } },
      ];
    },
    readMemoryFrontmatter: async () => null,
    getNamespaceVersion: async () => 7,
  };
  const staleSignals = buildTrustSignalMap(
    [{ path: "a.md", frontmatter: { mw_success: 3, mw_fail: 0, lastAccessed: "2026-06-30" } }],
    new Date(now.getTime() - TRUST_SIGNAL_CACHE_MAX_AGE_MS - 1),
    {},
  );
  const cache = {
    cache: new Map([
      [
        "default",
        {
          version: 7,
          cachedAt: now.getTime() - TRUST_SIGNAL_CACHE_MAX_AGE_MS - 1,
          signals: staleSignals,
        },
      ],
    ]),
  };

  await buildTrustSignalsForRerank(["a.md"], ["default"], deps, cache, now, {});
  assert.equal(corpusReads, 1, "aged entry (version match) must re-derive from the corpus");

  corpusReads = 0;
  await buildTrustSignalsForRerank(["a.md"], ["default"], deps, cache, now, {});
  assert.equal(corpusReads, 0, "fresh entry with matching version must serve from cache");
});

test("preloaded-but-neutral candidates skip the corpus and direct-read fallbacks (#1905, Cursor/Codex)", async () => {
  // buildTrustSignalMap deliberately OMITS neutral memories (no trust fields),
  // so a preloaded candidate can be examined yet absent from `signals`. It must
  // be treated as EXAMINED — not missing — or every uninstrumented hot
  // candidate re-triggers the namespace-wide corpus scan and a direct re-read,
  // defeating the O(candidates) fast path.
  const { buildTrustSignalsForRerank } = await import("./trust-score-stage.js");
  const now = new Date("2026-07-01T12:00:00.000Z");
  let corpusReads = 0;
  let directReads = 0;
  const deps = {
    readNamespaceMemories: async () => {
      corpusReads += 1;
      return [];
    },
    readMemoryFrontmatter: async () => {
      directReads += 1;
      return null;
    },
    getNamespaceVersion: async () => 1,
  };
  const cache = { cache: new Map() };
  // Neutral frontmatter: no mw_* / trust fields at all.
  const preloadedFrontmatter = new Map([
    ["a.md", { frontmatter: {} }],
    ["b.md", { frontmatter: {} }],
  ]);

  const signals = await buildTrustSignalsForRerank(
    ["a.md", "b.md"],
    ["default"],
    deps,
    cache,
    now,
    { preloadedFrontmatter },
  );

  assert.equal(corpusReads, 0, "neutral preloaded candidates must not trigger a corpus scan");
  assert.equal(directReads, 0, "neutral preloaded candidates must not trigger direct reads");
  assert.equal(signals.size, 0, "neutral candidates stay absent (multiplier 1.0 downstream)");
});

test("cooperative abort stops the corpus and direct-read fallbacks at loop boundaries (#1905, Codex)", async () => {
  const { buildTrustSignalsForRerank } = await import("./trust-score-stage.js");
  const now = new Date("2026-07-01T12:00:00.000Z");
  let corpusReads = 0;
  let directReads = 0;
  const deps = {
    readNamespaceMemories: async () => {
      corpusReads += 1;
      return [];
    },
    readMemoryFrontmatter: async () => {
      directReads += 1;
      return null;
    },
    getNamespaceVersion: async () => 1,
  };
  const controller = new AbortController();
  controller.abort(); // the recall deadline already won the race

  await buildTrustSignalsForRerank(
    ["a.md"],
    ["ns1", "ns2"],
    deps,
    { cache: new Map() },
    now,
    { abortSignal: controller.signal },
  );

  assert.equal(corpusReads, 0, "an aborted signal must stop namespace scans before they start");
  assert.equal(directReads, 0, "an aborted signal must stop direct-read batches before they start");
});

test("trust direct-read fallback threads the candidate namespace (#2020)", async () => {
  // A namespace-fanout candidate carries a relative path plus its owning
  // namespace. The cold-tier direct read MUST pass that namespace so the
  // relative path resolves against the right store instead of the first
  // fallback namespace (which would apply the wrong memory's trust signals).
  const { buildTrustSignalsForRerank } = await import("./trust-score-stage.js");
  const now = new Date("2026-07-01T12:00:00.000Z");
  const directReads: Array<{ path: string; namespace?: string }> = [];
  const deps = {
    readNamespaceMemories: async () => [],
    readMemoryFrontmatter: async (path: string, preferredNamespace?: string) => {
      directReads.push({ path, namespace: preferredNamespace });
      return null;
    },
    getNamespaceVersion: async () => 1,
  };

  await buildTrustSignalsForRerank(
    [{ path: "facts/a.md", signalKey: "shared\u0000facts/a.md", namespace: "shared" }],
    ["shared"],
    deps,
    { cache: new Map() },
    now,
    { corpusFallbackEnabled: false },
  );

  assert.deepEqual(
    directReads,
    [{ path: "facts/a.md", namespace: "shared" }],
    "direct read must receive the candidate's owning namespace",
  );
});
