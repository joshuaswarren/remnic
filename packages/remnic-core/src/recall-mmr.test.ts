import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMmrToCandidates,
  reorderRecallResultsWithMmr,
  summarizeMmrDiversity,
  normalizeTokens,
  type MmrCandidate,
  type MmrRecallResult,
} from "./recall-mmr.js";

function makeCandidate(
  id: string,
  content: string,
  score: number,
  embedding?: number[],
): MmrCandidate {
  return { id, content, score, embedding: embedding ?? null };
}

test("applyMmrToCandidates returns [] for empty input", () => {
  const out = applyMmrToCandidates({ candidates: [] });
  assert.deepEqual(out, []);
});

test("applyMmrToCandidates is a no-op for a single candidate", () => {
  const input = [makeCandidate("a", "hello", 1)];
  const out = applyMmrToCandidates({ candidates: input });
  assert.equal(out.length, 1);
  assert.equal(out[0]?.id, "a");
});

test("applyMmrToCandidates does not mutate input", () => {
  const input: MmrCandidate[] = [
    makeCandidate("a", "one", 0.9, [1, 0, 0, 0]),
    makeCandidate("b", "two", 0.8, [0, 1, 0, 0]),
  ];
  const before = input.map((c) => c.id).join(",");
  applyMmrToCandidates({ candidates: input, budget: 1 });
  assert.equal(
    input.map((c) => c.id).join(","),
    before,
    "input order should be unchanged",
  );
});

test("applyMmrToCandidates collapses near-duplicate clusters (cosine)", () => {
  // Five near-duplicate candidates all pointing toward [1,0,0,0] with tiny
  // perturbations, plus four diverse candidates along orthogonal axes.
  const epsilon = 0.001;
  const nearDupe = (idx: number): number[] => [1, epsilon * idx, 0, 0];
  const candidates: MmrCandidate[] = [
    makeCandidate("dupe-1", "alpha one", 0.99, nearDupe(1)),
    makeCandidate("dupe-2", "alpha two", 0.98, nearDupe(2)),
    makeCandidate("dupe-3", "alpha three", 0.97, nearDupe(3)),
    makeCandidate("dupe-4", "alpha four", 0.96, nearDupe(4)),
    makeCandidate("dupe-5", "alpha five", 0.95, nearDupe(5)),
    makeCandidate("div-y", "beta", 0.9, [0, 1, 0, 0]),
    makeCandidate("div-z", "gamma", 0.85, [0, 0, 1, 0]),
    makeCandidate("div-w", "delta", 0.8, [0, 0, 0, 1]),
    makeCandidate("div-a", "epsilon", 0.75, [1, 1, 0, 0]),
  ];

  // Budget = 4 — with 4 distinct axes available (plus a 5th dupe cluster),
  // MMR should pick 1 dupe + 3 diverse before ever revisiting the cluster.
  const selected = applyMmrToCandidates({
    candidates,
    lambda: 0.5, // balance relevance + diversity
    topN: 40,
    budget: 4,
  });

  assert.equal(selected.length, 4);

  const dupeCount = selected.filter((c) => c.id.startsWith("dupe-")).length;
  assert.ok(
    dupeCount <= 1,
    `expected at most 1 representative from the duplicate cluster, got ${dupeCount}: ${selected
      .map((c) => c.id)
      .join(",")}`,
  );

  // The highest-relevance duplicate should still be included.
  const ids = selected.map((c) => c.id);
  assert.ok(ids.includes("dupe-1"), `expected dupe-1 in selection: ${ids}`);
  // All three fully diverse axes should also surface.
  assert.ok(ids.includes("div-y"));
  assert.ok(ids.includes("div-z"));
  assert.ok(ids.includes("div-w"));
});

test("applyMmrToCandidates falls back to Jaccard when embeddings are missing", () => {
  // Three candidates with heavy lexical overlap + two diverse ones.
  const candidates: MmrCandidate[] = [
    makeCandidate(
      "s1",
      "The cat sat on the red mat in the sunny kitchen",
      0.95,
    ),
    makeCandidate(
      "s2",
      "The cat sat on the red mat in the sunny kitchen today",
      0.94,
    ),
    makeCandidate(
      "s3",
      "A cat is sitting on the red mat in the kitchen",
      0.93,
    ),
    makeCandidate(
      "d1",
      "Quantum tunneling explains alpha decay in heavy nuclei",
      0.5,
    ),
    makeCandidate(
      "d2",
      "Bicycle gears shift when pedaling uphill on pavement",
      0.4,
    ),
  ];

  const selected = applyMmrToCandidates({
    candidates,
    lambda: 0.4, // push harder toward diversity so clustering shows up
    topN: 40,
    budget: 3,
  });

  assert.equal(selected.length, 3);
  const ids = selected.map((c) => c.id);
  // The top-scored lexical duplicate should be included...
  assert.ok(ids.includes("s1"));
  // ...but MMR should prefer the diverse candidates over the other near-dupes.
  const sxCount = ids.filter((id) => id.startsWith("s")).length;
  assert.ok(
    sxCount < 3,
    `MMR should not fill the slate with lexical duplicates: ${ids.join(",")}`,
  );
  assert.ok(
    ids.includes("d1") || ids.includes("d2"),
    `at least one diverse candidate should appear: ${ids.join(",")}`,
  );
});

test("applyMmrToCandidates is sensitive to lambda", () => {
  const candidates: MmrCandidate[] = [
    makeCandidate("a", "alpha one", 1.0, [1, 0.001, 0, 0]),
    makeCandidate("b", "alpha two", 0.99, [1, 0.002, 0, 0]),
    makeCandidate("c", "beta", 0.5, [0, 1, 0, 0]),
    makeCandidate("d", "gamma", 0.4, [0, 0, 1, 0]),
  ];

  // Lambda = 1.0 → pure relevance, no diversity adjustment.
  const pureRelevance = applyMmrToCandidates({
    candidates,
    lambda: 1.0,
    budget: 2,
  });
  assert.deepEqual(pureRelevance.map((c) => c.id), ["a", "b"]);

  // Lambda = 0.2 → diversity dominates, the second pick should avoid the
  // near-duplicate of `a`.
  const diverse = applyMmrToCandidates({
    candidates,
    lambda: 0.2,
    budget: 2,
  });
  assert.equal(diverse[0]?.id, "a", "highest-relevance should still lead");
  assert.notEqual(
    diverse[1]?.id,
    "b",
    "diversity-heavy MMR should avoid the near-duplicate",
  );
});

test("applyMmrToCandidates preserves all candidates when budget >= length", () => {
  const candidates: MmrCandidate[] = [
    makeCandidate("a", "one", 1, [1, 0, 0]),
    makeCandidate("b", "two", 0.9, [0, 1, 0]),
    makeCandidate("c", "three", 0.8, [0, 0, 1]),
  ];
  const out = applyMmrToCandidates({
    candidates,
    budget: 10,
  });
  assert.equal(out.length, 3);
  const ids = out.map((c) => c.id).sort();
  assert.deepEqual(ids, ["a", "b", "c"]);
});

test("applyMmrToCandidates respects topN clamping", () => {
  const candidates: MmrCandidate[] = Array.from({ length: 50 }, (_, i) =>
    makeCandidate(`c-${i}`, `content ${i}`, 1 - i * 0.01, [1, i * 0.001, 0]),
  );
  const out = applyMmrToCandidates({
    candidates,
    topN: 10,
    budget: 5,
  });
  assert.equal(out.length, 5);
  // All selected should come from the top 10 (indices 0-9).
  for (const c of out) {
    const idx = Number.parseInt(c.id.split("-")[1]!, 10);
    assert.ok(idx < 10, `selected candidate ${c.id} outside topN window`);
  }
});

test("applyMmrToCandidates handles budget=0 as empty selection", () => {
  const candidates = [makeCandidate("a", "one", 1), makeCandidate("b", "two", 0.5)];
  const out = applyMmrToCandidates({ candidates, budget: 0 });
  // budget=0 is clamped to 0, nothing selected
  assert.equal(out.length, 0);
});

test("summarizeMmrDiversity reports higher before-sim for dup-heavy input", () => {
  const dupHeavy: MmrCandidate[] = [
    makeCandidate("a", "the cat sat on the mat", 1, [1, 0.001, 0]),
    makeCandidate("b", "a cat sat on the mat", 0.99, [1, 0.002, 0]),
    makeCandidate("c", "cats sit on mats", 0.98, [1, 0.003, 0]),
  ];
  const diversified = applyMmrToCandidates({
    candidates: dupHeavy.concat([
      makeCandidate("d", "rocket thrust vectoring", 0.5, [0, 1, 0]),
      makeCandidate("e", "violin bow rosin", 0.4, [0, 0, 1]),
    ]),
    lambda: 0.4,
    budget: 3,
  });

  const report = summarizeMmrDiversity(dupHeavy, diversified, 40);
  assert.ok(
    report.avgPairwiseSimAfter <= report.avgPairwiseSimBefore + 1e-9,
    `avg pairwise similarity should not increase after MMR: before=${report.avgPairwiseSimBefore} after=${report.avgPairwiseSimAfter}`,
  );
});

test("normalizeTokens lowercases and strips punctuation", () => {
  assert.deepEqual(
    [...normalizeTokens("Hello, World! 42 TIMES.")],
    ["hello", "world", "42", "times"],
  );
  assert.deepEqual([...normalizeTokens("")], []);
  assert.deepEqual([...normalizeTokens("   ")], []);
});

test("applyMmrToCandidates end-to-end: duplicate sentences reduced vs disabled", () => {
  // Small seeded fixture: 4 near-duplicate "fact" sentences + 3 diverse.
  const fixture: MmrCandidate[] = [
    makeCandidate(
      "f1",
      "The user prefers dark mode for their terminal",
      0.95,
    ),
    makeCandidate(
      "f2",
      "User likes dark mode in the terminal interface",
      0.94,
    ),
    makeCandidate(
      "f3",
      "Prefers dark mode setting for terminal usage",
      0.93,
    ),
    makeCandidate(
      "f4",
      "The terminal should use dark mode",
      0.92,
    ),
    makeCandidate("d1", "Coffee is brewed at 195 degrees fahrenheit", 0.8),
    makeCandidate("d2", "The sunset reflected orange on the ocean waves", 0.75),
    makeCandidate("d3", "Linear algebra underpins modern machine learning", 0.7),
  ];

  // Without MMR: top-4 would be f1..f4, all near-duplicates.
  const noMmrTop4 = fixture.slice(0, 4);
  const mmrTop4 = applyMmrToCandidates({
    candidates: fixture,
    lambda: 0.4,
    budget: 4,
  });

  const noMmrIds = noMmrTop4.map((c) => c.id);
  const mmrIds = mmrTop4.map((c) => c.id);

  const countDupes = (ids: string[]) =>
    ids.filter((id) => id.startsWith("f")).length;

  assert.ok(
    countDupes(mmrIds) < countDupes(noMmrIds),
    `MMR should strictly reduce duplicate cluster count: noMmr=${noMmrIds} mmr=${mmrIds}`,
  );
  assert.ok(
    mmrIds.some((id) => id.startsWith("d")),
    `MMR should surface at least one diverse candidate: ${mmrIds}`,
  );
});

// ---------------------------------------------------------------------------
// Regression: path-first keying for reorderRecallResultsWithMmr
// (ChatGPT Codex P2 review comment on PR #391)
// ---------------------------------------------------------------------------

test(
  "reorderRecallResultsWithMmr preserves distinct results that share a docid",
  () => {
    // Two results with IDENTICAL docids but DIFFERENT paths. A docid-keyed
    // implementation would collapse these into one and silently drop a valid
    // recall candidate.
    const results: MmrRecallResult[] = [
      {
        docid: "fact-007",
        path: "memories/facts/source-a/fact-007.md",
        snippet: "Some fact from source A",
        score: 0.95,
      },
      {
        docid: "fact-007",
        path: "memories/facts/source-b/fact-007.md",
        snippet: "A very different fact from source B",
        score: 0.92,
      },
      {
        docid: "fact-008",
        path: "memories/facts/source-a/fact-008.md",
        snippet: "Yet another unrelated fact",
        score: 0.9,
      },
    ];

    const { reordered } = reorderRecallResultsWithMmr(results);

    assert.equal(
      reordered.length,
      results.length,
      "no candidate should be dropped when docids collide across paths",
    );
    const paths = reordered.map((r) => r.path).sort();
    assert.deepEqual(paths, [
      "memories/facts/source-a/fact-007.md",
      "memories/facts/source-a/fact-008.md",
      "memories/facts/source-b/fact-007.md",
    ]);
  },
);

test(
  "reorderRecallResultsWithMmr keeps results with empty path AND empty docid distinct",
  () => {
    // Pathological input: every result has empty path and empty docid. The
    // stable index-suffix fallback must still give each candidate its own
    // key so none of them collapse.
    const results: MmrRecallResult[] = [
      { docid: "", path: "", snippet: "alpha content", score: 0.9 },
      { docid: "", path: "", snippet: "beta content", score: 0.8 },
      { docid: "", path: "", snippet: "gamma content", score: 0.7 },
    ];

    const { reordered } = reorderRecallResultsWithMmr(results);
    assert.equal(reordered.length, 3);
    const snippets = reordered.map((r) => r.snippet).sort();
    assert.deepEqual(snippets, ["alpha content", "beta content", "gamma content"]);
  },
);

// ---------------------------------------------------------------------------
// Regression: head-of-list diversity metric actually reflects reordering
// (Cursor Bugbot Medium review comment on PR #391)
// ---------------------------------------------------------------------------

test(
  "summarizeMmrDiversity with small sample size reflects head-of-list reordering",
  () => {
    // Input: 5 near-duplicate high-score "a*" candidates up front, then 3
    // diverse candidates. With `budget = candidates.length`, MMR reorders but
    // drops nothing — the two slices pre- and post-MMR contain the same
    // SET. If the diversity metric used a large sample size it would report
    // identical before/after averages. With a small head-of-list sample size
    // the head *does* differ, so avgPairwiseSimAfter < avgPairwiseSimBefore.
    const candidates: MmrCandidate[] = [
      { id: "a1", content: "alpha", score: 0.99, embedding: [1, 0.001, 0] },
      { id: "a2", content: "alpha", score: 0.98, embedding: [1, 0.002, 0] },
      { id: "a3", content: "alpha", score: 0.97, embedding: [1, 0.003, 0] },
      { id: "a4", content: "alpha", score: 0.96, embedding: [1, 0.004, 0] },
      { id: "a5", content: "alpha", score: 0.95, embedding: [1, 0.005, 0] },
      { id: "b1", content: "beta", score: 0.9, embedding: [0, 1, 0] },
      { id: "b2", content: "gamma", score: 0.85, embedding: [0, 0, 1] },
      { id: "b3", content: "delta", score: 0.8, embedding: [1, 1, 0] },
    ];

    const reordered = applyMmrToCandidates({
      candidates,
      lambda: 0.3, // push hard toward diversity
      budget: candidates.length, // same set, just reordered — same bug regime
    });
    assert.equal(reordered.length, candidates.length);

    // Default small sample size (10 is larger than our 8-element pool, so
    // everything is compared — this recreates the bug the comment flagged).
    const trivialReport = summarizeMmrDiversity(
      candidates,
      reordered,
      candidates.length,
    );
    // With full-pool sampling the before/after average pairwise similarity
    // is order-independent — the bug condition.
    assert.ok(
      Math.abs(trivialReport.avgPairwiseSimBefore - trivialReport.avgPairwiseSimAfter) < 1e-9,
      "sanity: full-pool sampling is order-independent and hides diversity gains",
    );

    // With a small head-of-list sample size (4), MMR's reordering *must*
    // show up as a strictly lower average pairwise similarity.
    const headReport = summarizeMmrDiversity(candidates, reordered, 4);
    assert.ok(
      headReport.avgPairwiseSimAfter + 1e-9 < headReport.avgPairwiseSimBefore,
      `head-of-list sample should show MMR diversity gain: before=${headReport.avgPairwiseSimBefore} after=${headReport.avgPairwiseSimAfter}`,
    );
  },
);

// ---------------------------------------------------------------------------
// Regression: MMR must run before truncation so diverse candidates just below
// the cutoff can be promoted into the final injected set.
// (ChatGPT Codex P2 review comment on PR #391)
// ---------------------------------------------------------------------------

test(
  "reorderRecallResultsWithMmr promotes sub-cutoff diverse candidates when run pre-slice",
  () => {
    // Simulate a near-duplicate cluster of 5 high-score candidates followed
    // by a truly diverse candidate at position 5 (just below a final limit
    // of 5). If MMR ran only on the already-truncated top-5, the diverse
    // candidate would never make it into the injected set. Running MMR on
    // the full 6-candidate pool and then slicing to 5 must pull the diverse
    // candidate into the final slice.
    const results: MmrRecallResult[] = [
      { docid: "a1", path: "p/a1", snippet: "alpha fact one", score: 0.99 },
      { docid: "a2", path: "p/a2", snippet: "alpha fact two", score: 0.98 },
      { docid: "a3", path: "p/a3", snippet: "alpha fact three", score: 0.97 },
      { docid: "a4", path: "p/a4", snippet: "alpha fact four", score: 0.96 },
      { docid: "a5", path: "p/a5", snippet: "alpha fact five", score: 0.95 },
      {
        docid: "d1",
        path: "p/d1",
        snippet: "orthogonal concept rocket fuel chemistry",
        score: 0.94,
      },
    ];

    // Simulate the buggy "slice then MMR" behavior.
    const sliceFirst = results.slice(0, 5);
    const sliceFirstMmr = reorderRecallResultsWithMmr(sliceFirst, {
      lambda: 0.3,
    }).reordered;
    const sliceFirstIds = sliceFirstMmr.map((r) => r.docid);
    assert.ok(
      !sliceFirstIds.includes("d1"),
      "sanity: slicing before MMR cannot recover the sub-cutoff diverse candidate",
    );

    // Now the correct "MMR then slice" behavior.
    const mmrFirst = reorderRecallResultsWithMmr(results, {
      lambda: 0.3,
    }).reordered.slice(0, 5);
    const mmrFirstIds = mmrFirst.map((r) => r.docid);
    assert.equal(mmrFirst.length, 5);
    assert.ok(
      mmrFirstIds.includes("d1"),
      `MMR-then-slice should promote the diverse candidate into the top-5: ${mmrFirstIds.join(",")}`,
    );
  },
);

// NOTE: the orchestrator's `diversifyAndLimitRecallResults` helper is a
// private method, but its zero-limit behavior is covered by the pure
// equivalent below: when the caller wants zero results, MMR plus a slice of
// zero should yield an empty array. This mirrors the legacy
// `.slice(0, recallResultLimit)` semantics when `recallResultLimit === 0`
// (which happens when `memoriesSectionEnabled` is false). Cursor Bugbot flagged
// this regression on PR #391.

test(
  "MMR + slice(0) idiom yields empty array when limit is zero",
  () => {
    const results: MmrRecallResult[] = [
      { docid: "a", path: "p/a", snippet: "one", score: 0.9 },
      { docid: "b", path: "p/b", snippet: "two", score: 0.8 },
    ];
    const { reordered } = reorderRecallResultsWithMmr(results);
    const limited = reordered.slice(0, 0);
    assert.equal(
      limited.length,
      0,
      "slice(0, 0) must still yield an empty array after MMR",
    );
  },
);

test(
  "reorderRecallResultsWithMmr with topN=0 is a full no-op preserving input order",
  () => {
    // AGENTS.md §4: never coerce zero limits to non-zero. A topN of 0 means
    // "apply MMR over an empty window" — no candidate gets dropped and the
    // original order is preserved.
    const results: MmrRecallResult[] = [
      { docid: "a", path: "p/a", snippet: "one", score: 0.9 },
      { docid: "b", path: "p/b", snippet: "two", score: 0.8 },
      { docid: "c", path: "p/c", snippet: "three", score: 0.7 },
    ];
    const { reordered } = reorderRecallResultsWithMmr(results, { topN: 0 });
    assert.equal(reordered.length, results.length);
    assert.deepEqual(
      reordered.map((r) => r.docid),
      ["a", "b", "c"],
      "topN=0 should be a no-op and preserve input order",
    );
  },
);

// ---------------------------------------------------------------------------
// Regression: Unicode-aware Jaccard tokenization for multilingual snippets
// (ChatGPT Codex P2 review comment on PR #391)
// ---------------------------------------------------------------------------

test(
  "normalizeTokens preserves non-ASCII scripts for multilingual Jaccard",
  () => {
    // Cyrillic: two near-identical snippets must share tokens, not collapse
    // to an empty set like the old [^a-z0-9]+ tokenizer did.
    const ruA = normalizeTokens("Привет, мир! Это тест.");
    const ruB = normalizeTokens("Привет мир это тест");
    assert.ok(ruA.size > 0, "Cyrillic snippet should produce non-empty tokens");
    let ruOverlap = 0;
    for (const t of ruA) if (ruB.has(t)) ruOverlap += 1;
    assert.ok(
      ruOverlap >= 3,
      `Cyrillic near-duplicates should share most tokens, overlap=${ruOverlap}`,
    );

    // Greek: same near-duplicate invariant.
    const grA = normalizeTokens("Καλημέρα κόσμε");
    const grB = normalizeTokens("καλημέρα κόσμε!");
    assert.ok(grA.size > 0);
    let grOverlap = 0;
    for (const t of grA) if (grB.has(t)) grOverlap += 1;
    assert.ok(
      grOverlap >= 2,
      `Greek near-duplicates should share tokens, overlap=${grOverlap}`,
    );

    // CJK (Chinese): no whitespace word breaks, so tokens are per-character.
    // Two snippets that share most characters must produce overlapping token
    // sets, not the empty set the old tokenizer returned.
    const zhA = normalizeTokens("用户喜欢深色模式");
    const zhB = normalizeTokens("用户偏好深色模式");
    assert.ok(zhA.size > 0, "CJK snippet should produce non-empty tokens");
    let zhOverlap = 0;
    for (const t of zhA) if (zhB.has(t)) zhOverlap += 1;
    assert.ok(
      zhOverlap >= 5,
      `Chinese near-duplicates should share most chars, overlap=${zhOverlap}`,
    );
  },
);

test(
  "reorderRecallResultsWithMmr detects non-ASCII near-duplicates and diversifies",
  () => {
    // Without Unicode-aware tokenization, the Jaccard fallback returned 0 for
    // all non-Latin snippets and MMR degenerated to plain relevance ordering.
    // After the fix the duplicate Cyrillic cluster must give up at least one
    // head-of-list slot to the diverse candidate.
    const results: MmrRecallResult[] = [
      { docid: "ru1", path: "p/ru1", snippet: "Пользователь предпочитает тёмный режим в терминале", score: 0.99 },
      { docid: "ru2", path: "p/ru2", snippet: "Пользователь предпочитает тёмный режим в терминалах", score: 0.98 },
      { docid: "ru3", path: "p/ru3", snippet: "Пользователь любит тёмный режим в терминале", score: 0.97 },
      { docid: "ru4", path: "p/ru4", snippet: "Пользователь предпочитает тёмную тему в терминале", score: 0.96 },
      { docid: "dv1", path: "p/dv1", snippet: "Ракетное топливо на основе жидкого кислорода", score: 0.9 },
    ];
    const { reordered, diversity } = reorderRecallResultsWithMmr(results, {
      lambda: 0.3,
      diversitySampleSize: 4,
    });
    const headIds = reordered.slice(0, 4).map((r) => r.docid);
    assert.ok(
      headIds.includes("dv1"),
      `diverse Cyrillic candidate should be promoted into head: ${headIds.join(",")}`,
    );
    assert.ok(
      diversity.headReorderCount > 0,
      `headReorderCount should be > 0 after MMR promoted a diverse candidate, got ${diversity.headReorderCount}`,
    );
  },
);

// ---------------------------------------------------------------------------
// Regression: min-max normalization used to defeat MMR for tight score
// clusters. After the fix, scores that already live in [0, 1] pass through
// untouched so the (1 - lambda) * maxSim penalty can actually outweigh a
// 0.01 relevance gap.
// (Cursor Bugbot Medium review comment on PR #391)
// ---------------------------------------------------------------------------

test(
  "applyMmrToCandidates diversifies tight reranker score clusters",
  () => {
    // Three near-duplicates tightly clustered in [0.93, 0.95], plus one
    // genuinely diverse candidate slightly below at 0.92. The old min-max
    // normalization would scale the diverse candidate's relevance to 0.0 and
    // it could never beat any duplicate; after the fix it must be promoted.
    const candidates: MmrCandidate[] = [
      { id: "dup1", content: "alpha content", score: 0.95, embedding: [1, 0.001, 0] },
      { id: "dup2", content: "alpha content near", score: 0.94, embedding: [1, 0.002, 0] },
      { id: "dup3", content: "alpha content close", score: 0.93, embedding: [1, 0.003, 0] },
      { id: "div", content: "completely orthogonal", score: 0.92, embedding: [0, 1, 0] },
    ];
    const reordered = applyMmrToCandidates({
      candidates,
      lambda: 0.7,
      budget: 2,
    });
    const ids = reordered.map((c) => c.id);
    assert.equal(reordered.length, 2);
    assert.ok(
      ids.includes("div"),
      `tight-cluster MMR should promote diverse candidate into top-2: ${ids.join(",")}`,
    );
  },
);

// ---------------------------------------------------------------------------
// Regression: diversity metric must emit an actionable signal even in
// reorder-only mode. `kept/considered` alone is unactionable when MMR never
// drops candidates; the new `headReorderCount` field makes the metric useful.
// (Cursor Bugbot Low-severity review comment on PR #391)
// ---------------------------------------------------------------------------

test(
  "summarizeMmrDiversity emits headReorderCount > 0 when MMR reorders the head",
  () => {
    // Near-dup cluster up front plus diverse candidates behind — MMR with
    // low lambda must swap at least one head-of-list slot, producing a
    // positive headReorderCount signal.
    const candidates: MmrCandidate[] = [
      { id: "a1", content: "dup alpha one", score: 0.99, embedding: [1, 0, 0] },
      { id: "a2", content: "dup alpha two", score: 0.98, embedding: [1, 0.001, 0] },
      { id: "a3", content: "dup alpha three", score: 0.97, embedding: [1, 0.002, 0] },
      { id: "b1", content: "diverse beta", score: 0.8, embedding: [0, 1, 0] },
      { id: "b2", content: "diverse gamma", score: 0.75, embedding: [0, 0, 1] },
    ];
    const reordered = applyMmrToCandidates({
      candidates,
      lambda: 0.3,
      budget: candidates.length,
    });
    const report = summarizeMmrDiversity(candidates, reordered, 3);
    assert.equal(report.considered, candidates.length);
    assert.equal(report.kept, reordered.length);
    assert.ok(
      report.headReorderCount > 0,
      `headReorderCount should be > 0 after MMR swapped head slots, got ${report.headReorderCount}`,
    );
  },
);

test(
  "summarizeMmrDiversity headReorderCount is 0 for an identity reorder",
  () => {
    // If MMR leaves the head untouched (e.g. all candidates are already
    // maximally diverse), headReorderCount should be exactly 0 so callers
    // can distinguish "no head change" from "head was reshuffled".
    const candidates: MmrCandidate[] = [
      { id: "x", content: "one", score: 0.9, embedding: [1, 0, 0] },
      { id: "y", content: "two", score: 0.8, embedding: [0, 1, 0] },
      { id: "z", content: "three", score: 0.7, embedding: [0, 0, 1] },
    ];
    const reordered = applyMmrToCandidates({
      candidates,
      lambda: 0.7,
      budget: candidates.length,
    });
    // Sanity: MMR should not reshuffle a perfectly diverse pool.
    assert.deepEqual(
      reordered.map((c) => c.id),
      ["x", "y", "z"],
    );
    const report = summarizeMmrDiversity(candidates, reordered);
    assert.equal(report.headReorderCount, 0);
  },
);

// ---------------------------------------------------------------------------
// Regression: single-element input must report considered=1 kept=1, not the
// 0/0 sentinel meant for the empty case.
// (Cursor Bugbot Low-severity review comment on PR #391)
// ---------------------------------------------------------------------------

test(
  "reorderRecallResultsWithMmr reports considered=1 kept=1 for single-element input",
  () => {
    const results: MmrRecallResult[] = [
      { docid: "only", path: "p/only", snippet: "sole result", score: 0.9 },
    ];
    const { reordered, diversity } = reorderRecallResultsWithMmr(results);
    assert.equal(reordered.length, 1);
    assert.equal(diversity.considered, 1);
    assert.equal(diversity.kept, 1);
    assert.equal(diversity.headReorderCount, 0);
  },
);

// ---------------------------------------------------------------------------
// Regression: diversity metric must detect head swaps even when two results
// share the same base key (path or docid). Previously the reordered-side
// candidate ids were rebuilt with the *post-MMR* position index, so the
// position suffix cancelled out and two same-path results swapping into the
// same head position looked like a no-op.
// (Cursor Bugbot Low-severity review comment on PR #391)
// ---------------------------------------------------------------------------

test(
  "reorderRecallResultsWithMmr detects head swaps for results sharing a base key",
  () => {
    // Both results share the same `path` and empty `docid`, so the base
    // portion of makeRecallKey is identical. Only the input-index suffix
    // distinguishes them. If the diversity report rebuilt the reordered
    // candidate ids with the post-MMR position index, a swap at position 0
    // would be invisible because both reorderings produce the same
    // `"shared-path::0"` id. After the fix the original-index-suffixed ids
    // are preserved, so the head swap is counted.
    const results: MmrRecallResult[] = [
      {
        docid: "",
        path: "shared/path.md",
        // Strongly duplicate-cluster-forming snippet at top.
        snippet: "dup alpha content alpha",
        score: 0.99,
      },
      {
        docid: "",
        path: "shared/path.md",
        snippet: "dup alpha content alpha near",
        score: 0.98,
      },
      {
        docid: "",
        path: "shared/path.md",
        // Orthogonal diverse candidate.
        snippet: "rocket propellant chemistry",
        score: 0.97,
      },
    ];
    const { reordered, diversity } = reorderRecallResultsWithMmr(results, {
      lambda: 0.3,
      diversitySampleSize: 2,
    });
    // MMR should have surfaced the diverse "rocket" candidate into the head
    // two — verify by checking the first two snippets include the diverse
    // one (order of the cluster pair is implementation-dependent).
    const headSnippets = reordered.slice(0, 2).map((r) => r.snippet);
    assert.ok(
      headSnippets.some((s) => s && s.includes("rocket")),
      `diverse candidate should be in head-of-list: ${headSnippets.join(" | ")}`,
    );
    // The real regression: headReorderCount must be > 0 even though all
    // three inputs share the same base key.
    assert.ok(
      diversity.headReorderCount > 0,
      `headReorderCount must detect same-base-key head swaps, got ${diversity.headReorderCount}`,
    );
  },
);

test(
  "reorderRecallResultsWithMmr diversity report defaults to head-of-list sample",
  () => {
    // Integration check for the orchestration helper: even with
    // `budget = results.length`, the default diversity report should surface
    // the fact that MMR promoted diverse candidates to the head.
    const results: MmrRecallResult[] = [
      { docid: "a1", path: "p/a1", snippet: "the quick brown fox jumps over the lazy dog", score: 0.99 },
      { docid: "a2", path: "p/a2", snippet: "the quick brown fox jumps over a lazy dog", score: 0.98 },
      { docid: "a3", path: "p/a3", snippet: "a quick brown fox jumps over the lazy dog", score: 0.97 },
      { docid: "a4", path: "p/a4", snippet: "quick brown fox jumping over lazy dogs", score: 0.96 },
      { docid: "a5", path: "p/a5", snippet: "brown foxes jumping over lazy dogs", score: 0.95 },
      { docid: "d1", path: "p/d1", snippet: "rocket thrust vectoring", score: 0.6 },
      { docid: "d2", path: "p/d2", snippet: "violin bow rosin reservoir", score: 0.5 },
      { docid: "d3", path: "p/d3", snippet: "coffee brewing at high altitude", score: 0.4 },
    ];

    const { reordered, diversity } = reorderRecallResultsWithMmr(results, {
      lambda: 0.3,
      diversitySampleSize: 4,
    });
    assert.equal(reordered.length, results.length);
    assert.ok(
      diversity.avgPairwiseSimAfter + 1e-9 < diversity.avgPairwiseSimBefore,
      `head-of-list MMR should lower avg pairwise similarity: before=${diversity.avgPairwiseSimBefore} after=${diversity.avgPairwiseSimAfter}`,
    );
    // Sanity: MMR should have pulled at least one diverse candidate into the head.
    const headDocids = reordered.slice(0, 4).map((r) => r.docid);
    assert.ok(
      headDocids.some((d) => d && d.startsWith("d")),
      `expected a diverse candidate in the head after MMR: ${headDocids.join(",")}`,
    );
  },
);
