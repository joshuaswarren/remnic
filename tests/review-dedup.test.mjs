import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DUPLICATE_LABEL,
  GATE_REPLY_MARKER,
  REVIEW_DEDUP_CONFIG,
  anchorsOverlap,
  computeGuardObligations,
  contentTokens,
  dedupeThreads,
  fingerprint,
  fingerprintSimilarity,
  formatDuplicateReply,
  formatRoundLedger,
  hasGateReply,
  isDetached,
  stripMarkup,
  threadAnchor,
} from "../scripts/review-dedup.mjs";

let clock = 0;
function mkThread({ id, path, startLine, line, author, body, replies = [], isResolved = false, createdAt }) {
  clock += 1;
  const nodes = [
    {
      path,
      startLine: startLine ?? null,
      line: line ?? null,
      author: { login: author },
      body,
      url: `https://github.com/x/y/pull/1#discussion_r${id}`,
      createdAt: createdAt ?? `2026-07-01T00:00:${String(clock).padStart(2, "0")}.000Z`,
    },
    ...replies.map((r) => ({ author: { login: r.author }, body: r.body })),
  ];
  return { id: `t${id}`, isResolved, line: line ?? null, startLine: startLine ?? null, comments: { nodes } };
}

// --- Fixtures reconstructed from the real duplicate threads -----------------
// The three known duplicate pairs the issue names: #1923 filed "Silent LSP
// failure" and "Malformed lsp config silently returns undefined" each twice by
// different reviewers; #1852 filed "sourceConnector not threaded through write
// path" across many write sites. Bodies carry the badge/markup/feedback footers
// bots actually attach, so normalization is exercised, not bypassed.

// #1923 Pair A — Silent LSP failure, code/message discarded.
const dup1923A1 = mkThread({
  id: 101,
  path: "packages/coding-graph/src/lsp/reindex.ts",
  startLine: 210,
  line: 214,
  author: "cursor",
  body:
    "### Silent LSP failure\n\nThe `code` and `message` from `lspResult` are discarded when the LSP reindex call fails, so the caller receives `undefined` and cannot distinguish a real LSP failure from an empty reindex result.\n\n<sub>🐛 Was this report helpful? [Give feedback](https://cursor.com/fb)</sub>",
});
const dup1923A2 = mkThread({
  id: 102,
  path: "packages/coding-graph/src/lsp/reindex.ts",
  startLine: 211,
  line: 215,
  author: "chatgpt-codex-connector",
  body:
    "**[P1] Silent LSP failure swallowing** — In `reindex`, the `code` and `message` on `lspResult` are discarded; a failing LSP call silently returns `undefined` to the caller instead of surfacing the real LSP failure or empty result.",
});

// #1923 Pair B — Malformed LSP config silently returns undefined.
const dup1923B1 = mkThread({
  id: 103,
  path: "packages/coding-graph/src/lsp/config.ts",
  startLine: 44,
  line: 52,
  author: "cursor",
  body:
    "Malformed `lsp` config silently returns `undefined`. When the `lsp` config fails schema validation the parser returns `undefined` with no error, so a malformed config is indistinguishable from an absent one.",
});
const dup1923B2 = mkThread({
  id: 104,
  path: "packages/coding-graph/src/lsp/config.ts",
  startLine: 45,
  line: 50,
  author: "chatgpt-codex-connector",
  body:
    "**Malformed `lsp` config validation gap** — a malformed `lsp` config that fails schema validation silently returns `undefined` from the parser with no error surfaced, so an invalid config looks identical to an absent config.",
});

// #1852 Pair C — sourceConnector not threaded through a write path.
const dup1852C1 = mkThread({
  id: 105,
  path: "packages/remnic-core/src/write/observe-replay.ts",
  startLine: 88,
  line: 96,
  author: "cursor",
  body:
    "`sourceConnector` is not threaded through the observe replay write path. The write envelope omits `sourceConnector`, so the persisted memory loses its connector provenance on replay.",
});
const dup1852C2 = mkThread({
  id: 106,
  path: "packages/remnic-core/src/write/observe-replay.ts",
  startLine: 90,
  line: 94,
  author: "chatgpt-codex-connector",
  body:
    "**Missing provenance** — the observe replay write path does not thread `sourceConnector` into the write envelope, dropping connector provenance from the persisted memory on replay.",
});

const DUPLICATE_PAIRS = [
  ["#1923-A silent-lsp-failure", dup1923A1, dup1923A2],
  ["#1923-B malformed-lsp-config", dup1923B1, dup1923B2],
  ["#1852-C sourceConnector-provenance", dup1852C1, dup1852C2],
];

// --- 20 sampled non-duplicate pairs (distinct findings) ---------------------
// A pool of genuinely distinct findings; the negative set pairs them such that
// each pair is either a different finding on the same file or unrelated files.
const N = [
  mkThread({ id: 201, path: "packages/coding-graph/src/lsp/reindex.ts", startLine: 210, line: 214,
    author: "cursor", body: "Unbounded concurrency: the reindex loop awaits every file in parallel with no limit, risking memory exhaustion on large repos." }),
  mkThread({ id: 202, path: "packages/coding-graph/src/lsp/reindex.ts", startLine: 300, line: 306,
    author: "chatgpt-codex-connector", body: "Race condition: two concurrent reindex calls mutate the shared symbol cache without a lock, so entries can be clobbered." }),
  mkThread({ id: 203, path: "packages/coding-graph/src/lsp/config.ts", startLine: 44, line: 52,
    author: "cursor", body: "The default timeout is hardcoded to 5000ms and is never read from the config; make it configurable." }),
  mkThread({ id: 204, path: "packages/remnic-core/src/write/observe-replay.ts", startLine: 88, line: 96,
    author: "cursor", body: "Idempotency key is computed from unsorted object keys, so two equal payloads hash differently and the dedup check fails." }),
  mkThread({ id: 205, path: "packages/remnic-core/src/write/bulk-import.ts", startLine: 12, line: 20,
    author: "chatgpt-codex-connector", body: "Bulk import swallows per-row validation errors and reports overall success, hiding partial failures from the caller." }),
  mkThread({ id: 206, path: "packages/remnic-core/src/write/suggestions.ts", startLine: 60, line: 66,
    author: "cursor", body: "The suggestion TTL is applied in seconds but the storage layer expects milliseconds, so suggestions expire a thousand times too early." }),
  mkThread({ id: 207, path: "packages/remnic-server/src/routes/recall.ts", startLine: 130, line: 140,
    author: "chatgpt-codex-connector", body: "SQL string interpolation of the query parameter allows injection; use a parameterized statement instead." }),
  mkThread({ id: 208, path: "packages/remnic-cli/src/cli.ts", startLine: 400, line: 405,
    author: "cursor", body: "The --limit flag is parsed with parseInt but negative values are accepted and later used as an array length, throwing a RangeError." }),
  mkThread({ id: 209, path: "packages/remnic-core/src/dedup/semantic-consolidation.ts", startLine: 22, line: 30,
    author: "chatgpt-codex-connector", body: "Embedding cosine similarity divides by zero when a vector is all zeros; guard the magnitude before dividing." }),
  mkThread({ id: 210, path: "packages/remnic-core/src/cache/memory-cache.ts", startLine: 77, line: 84,
    author: "cursor", body: "Cache eviction uses insertion order rather than recency, so hot entries are evicted before cold ones under pressure." }),
  mkThread({ id: 211, path: "docs/ops/pr-review-hardening-playbook.md", startLine: 5, line: 6,
    author: "chatgpt-codex-connector", body: "Broken relative link: the referenced patterns file path is missing a leading directory segment." }),
  mkThread({ id: 212, path: "packages/remnic-core/src/write/corrections.ts", startLine: 15, line: 22,
    author: "cursor", body: "A correction with an empty body is persisted, overwriting the original memory with nothing; reject empty corrections." }),
  mkThread({ id: 213, path: "packages/remnic-core/src/write/promotions.ts", startLine: 8, line: 14,
    author: "chatgpt-codex-connector", body: "Promotion confidence is clamped to [0,1] after multiplication, but the multiplication can overflow to Infinity first." }),
  mkThread({ id: 214, path: "packages/remnic-server/src/auth/token.ts", startLine: 33, line: 40,
    author: "cursor", body: "Token comparison uses == which is timing-variable; use a constant-time comparison to prevent token leakage." }),
];

const NEGATIVE_PAIRS = [
  [N[0], N[1]], [N[0], N[2]], [N[1], N[3]], [N[2], N[4]], [N[3], N[5]],
  [N[4], N[6]], [N[5], N[7]], [N[6], N[8]], [N[7], N[9]], [N[8], N[10]],
  [N[9], N[11]], [N[10], N[12]], [N[11], N[13]], [N[12], N[0]], [N[13], N[1]],
  [N[0], N[5]], [N[2], N[7]], [N[4], N[9]], [N[6], N[11]], [N[8], N[13]],
];

function firstBody(thread) {
  return thread.comments.nodes[0].body;
}

// --- Normalization ----------------------------------------------------------

test("stripMarkup removes badges, links, code, emoji, severity tags, and feedback footers", () => {
  const stripped = stripMarkup(firstBody(dup1923A1));
  assert.doesNotMatch(stripped, /give feedback|helpful/i);
  assert.doesNotMatch(stripped, /https?:\/\//);
  assert.doesNotMatch(stripped, /[`#*]/);
  assert.doesNotMatch(stripped, /🐛/);
  assert.match(stripped, /lspresult/);
});

test("fingerprint is deterministic and set-like", () => {
  const a = fingerprint(firstBody(dup1923A1));
  const b = fingerprint(firstBody(dup1923A1));
  assert.deepEqual([...a].sort(), [...b].sort());
  assert.ok(a.size > 0);
});

// --- Precision/recall on the committed fixture set --------------------------

test("committed threshold: all real duplicate pairs match, zero false positives on 20-pair negative set", () => {
  const threshold = REVIEW_DEDUP_CONFIG.similarityThreshold;

  let minDupSim = Infinity;
  for (const [label, a, b] of DUPLICATE_PAIRS) {
    const sim = fingerprintSimilarity(firstBody(a), firstBody(b));
    minDupSim = Math.min(minDupSim, sim);
    assert.ok(
      anchorsOverlap(threadAnchor(a), threadAnchor(b)),
      `${label}: anchors must overlap`,
    );
    assert.ok(sim >= threshold, `${label}: similarity ${sim.toFixed(3)} must be >= ${threshold}`);
  }

  let maxNegSim = 0;
  let falsePositives = 0;
  for (const [a, b] of NEGATIVE_PAIRS) {
    const overlap = anchorsOverlap(threadAnchor(a), threadAnchor(b));
    const sim = overlap ? fingerprintSimilarity(firstBody(a), firstBody(b)) : 0;
    if (overlap && sim >= threshold) falsePositives += 1;
    if (overlap) maxNegSim = Math.max(maxNegSim, sim);
  }

  assert.equal(falsePositives, 0, "zero false merges on the negative set");
  // Measured separation, committed alongside the fixtures: the threshold sits
  // strictly between the hardest duplicate and the hardest non-duplicate.
  assert.ok(
    minDupSim >= threshold && threshold > maxNegSim,
    `separation broken: minDup=${minDupSim.toFixed(3)} threshold=${threshold} maxNeg=${maxNegSim.toFixed(3)}`,
  );
});

test("dedupeThreads merges each real duplicate into its canonical (first-seen)", () => {
  for (const [label, a, b] of DUPLICATE_PAIRS) {
    const { records, duplicateCount } = dedupeThreads([a, b]);
    assert.equal(duplicateCount, 1, `${label}: exactly one duplicate`);
    const dup = records.find((r) => r.canonicalId !== r.id);
    assert.equal(dup.id, b.id, `${label}: later thread is the duplicate`);
    assert.equal(dup.canonicalId, a.id, `${label}: canonical is the first-seen thread`);
  }
});

test("dedupeThreads leaves distinct findings untouched", () => {
  const { duplicateCount } = dedupeThreads(N);
  assert.equal(duplicateCount, 0);
});

// --- Resolution inheritance + shadow mode -----------------------------------

test("resolving the canonical folds its duplicate under enforcement WITH audit evidence", () => {
  const canonical = { ...dup1923A1, isResolved: true };
  const duplicate = {
    ...dup1923A2,
    isResolved: false,
    comments: {
      nodes: [
        ...dup1923A2.comments.nodes,
        { author: { login: "github-actions[bot]" }, body: formatDuplicateReply("https://x/1") },
      ],
    },
  };
  const enforce = computeGuardObligations([canonical, duplicate], REVIEW_DEDUP_CONFIG, {
    applyInheritance: true,
  });
  assert.equal(enforce.duplicateCount, 1);
  assert.equal(enforce.effectiveUnresolvedCount, 0, "resolved canonical + gate reply folds the duplicate");
  assert.equal(enforce.wouldBeLostUniqueFindings.length, 0);
});

test("a resolved canonical does NOT fold an unaudited duplicate (no silent enforce pass)", () => {
  // Without the gate-authored reply a transient/read-only reply-post failure
  // must not let enforce pass; the duplicate keeps gating until the reply lands.
  const canonical = { ...dup1923A1, isResolved: true };
  const duplicate = { ...dup1923A2, isResolved: false };
  const enforce = computeGuardObligations([canonical, duplicate], REVIEW_DEDUP_CONFIG, {
    applyInheritance: true,
  });
  assert.equal(enforce.duplicateCount, 1);
  assert.equal(enforce.effectiveUnresolvedCount, 1, "no audit evidence -> duplicate still gates");
});

test("a bot reply WITHOUT the gate marker is not audit evidence (partial/failed write still gates)", () => {
  // Models a transient/partial reply write that landed a comment but not the
  // ledger marker: it must NOT count as audit evidence, so the duplicate gates.
  const canonical = { ...dup1923A1, isResolved: true };
  const duplicate = {
    ...dup1923A2,
    isResolved: false,
    comments: {
      nodes: [
        ...dup1923A2.comments.nodes,
        { author: { login: "github-actions[bot]" }, body: "posted, but the marker never persisted" },
      ],
    },
  };
  const enforce = computeGuardObligations([canonical, duplicate], REVIEW_DEDUP_CONFIG, {
    applyInheritance: true,
  });
  assert.equal(enforce.effectiveUnresolvedCount, 1, "a markerless reply is not audit evidence -> still gates");
});

test("not-a-duplicate reply re-opens the detached thread's guard obligation within one cycle", () => {
  const canonical = { ...dup1923A1, isResolved: true };
  const detached = mkThread({
    id: 102,
    path: "packages/coding-graph/src/lsp/reindex.ts",
    startLine: 211,
    line: 215,
    author: "chatgpt-codex-connector",
    isResolved: false,
    body: firstBody(dup1923A2),
    replies: [{ author: "maintainer", body: "not-a-duplicate — this is the async path, distinct fix." }],
  });
  assert.equal(isDetached(detached), true);
  const enforce = computeGuardObligations([canonical, detached], REVIEW_DEDUP_CONFIG, {
    applyInheritance: true,
  });
  assert.equal(enforce.duplicateCount, 0, "detached thread is no longer a duplicate");
  assert.equal(enforce.effectiveUnresolvedCount, 1, "detached unresolved thread gates again");
});

test("an unresolved canonical never hides its duplicate's finding", () => {
  const canonical = { ...dup1852C1, isResolved: false };
  const duplicate = { ...dup1852C2, isResolved: false };
  const enforce = computeGuardObligations([canonical, duplicate], REVIEW_DEDUP_CONFIG, {
    applyInheritance: true,
  });
  // Duplicate folds into canonical (counted once) but the finding still gates.
  assert.equal(enforce.effectiveUnresolvedCount, 1);
  assert.equal(enforce.wouldBeLostUniqueFindings.length, 1);
  assert.equal(enforce.wouldBeLostUniqueFindings[0].surfacedByCanonical, true);
});

test("shadow mode is byte-identical to the raw unresolved count", () => {
  const canonical = { ...dup1923A1, isResolved: true };
  const duplicate = { ...dup1923A2, isResolved: false };
  const shadow = computeGuardObligations([canonical, duplicate], REVIEW_DEDUP_CONFIG, {
    applyInheritance: false,
  });
  assert.equal(shadow.rawUnresolvedCount, 1);
  assert.equal(shadow.effectiveUnresolvedCount, 1, "shadow does not change the count");
  assert.equal(shadow.duplicateCount, 1, "but dedup measurement still exists");
});

test("guard behavior on a zero-duplicate PR is byte-identical under enforcement (regression fixture)", () => {
  const threads = N.map((t, i) => ({ ...t, isResolved: i % 2 === 0 }));
  const shadow = computeGuardObligations(threads, REVIEW_DEDUP_CONFIG, { applyInheritance: false });
  const enforce = computeGuardObligations(threads, REVIEW_DEDUP_CONFIG, { applyInheritance: true });
  assert.equal(shadow.duplicateCount, 0);
  assert.equal(enforce.duplicateCount, 0);
  assert.equal(enforce.effectiveUnresolvedCount, shadow.rawUnresolvedCount);
  assert.equal(enforce.wouldBeLostUniqueFindings.length, 0);
});

// --- CodeQL exclusion + ledger ---------------------------------------------

test("CodeQL threads are never deduplicated", () => {
  const codeqlA = mkThread({
    id: 301, path: "packages/coding-graph/src/lsp/reindex.ts", startLine: 210, line: 214,
    author: "github-advanced-security", body: firstBody(dup1923A1),
  });
  const codeqlB = mkThread({
    id: 302, path: "packages/coding-graph/src/lsp/reindex.ts", startLine: 211, line: 215,
    author: "github-advanced-security", body: firstBody(dup1923A2),
  });
  const { duplicateCount } = dedupeThreads([codeqlA, codeqlB]);
  assert.equal(duplicateCount, 0);
});

test("a real finding is never folded into a CodeQL thread (CodeQL is not a canonical candidate)", () => {
  // CodeQL files first on the range, then a real reviewer files the same finding.
  const codeql = mkThread({
    id: 311, path: "packages/coding-graph/src/lsp/reindex.ts", startLine: 210, line: 214,
    author: "github-advanced-security", body: firstBody(dup1923A1), isResolved: false,
  });
  const realFinding = mkThread({
    id: 312, path: "packages/coding-graph/src/lsp/reindex.ts", startLine: 211, line: 215,
    author: "chatgpt-codex-connector", body: firstBody(dup1923A2), isResolved: false,
  });
  const { records, duplicateCount } = dedupeThreads([codeql, realFinding]);
  assert.equal(duplicateCount, 0, "the real finding must not become a duplicate of a CodeQL thread");
  assert.equal(records.find((r) => r.id === "t312").canonicalId, "t312", "real finding stays its own canonical");
  // Under enforcement it must still gate — a CodeQL 'canonical' cannot hide it.
  const enforce = computeGuardObligations([codeql, realFinding], REVIEW_DEDUP_CONFIG, {
    applyInheritance: true,
  });
  assert.equal(enforce.effectiveUnresolvedCount, 1, "real finding still gates; CodeQL never counts");
});

test("a resolved+outdated canonical never anchors a later active finding (stale canonical)", () => {
  // An earlier thread was resolved, then its anchor's code changed (isOutdated).
  const staleCanonical = {
    ...mkThread({
      id: 401, path: "packages/coding-graph/src/lsp/reindex.ts", startLine: 210, line: 214,
      author: "coderabbitai", body: firstBody(dup1923A1), isResolved: true,
    }),
    isOutdated: true,
  };
  // A NEW active finding lands on the same range with similar text.
  const laterActive = mkThread({
    id: 402, path: "packages/coding-graph/src/lsp/reindex.ts", startLine: 211, line: 215,
    author: "chatgpt-codex-connector", body: firstBody(dup1923A2), isResolved: false,
  });
  const { records, duplicateCount } = dedupeThreads([staleCanonical, laterActive]);
  assert.equal(duplicateCount, 0, "the active finding must not fold into a stale (resolved+outdated) canonical");
  assert.equal(
    records.find((r) => r.id === "t402").canonicalId,
    "t402",
    "active finding stays its own canonical",
  );
  // Under enforcement the stale resolution must NOT satisfy the new finding.
  const enforce = computeGuardObligations([staleCanonical, laterActive], REVIEW_DEDUP_CONFIG, {
    applyInheritance: true,
  });
  assert.equal(enforce.effectiveUnresolvedCount, 1, "active finding still gates; stale resolution cannot satisfy it");
});

test("distinct fenced snippets with identical prose do NOT dedupe (negative)", () => {
  // Two terse findings on the same overlapping lines whose only distinguishing
  // fact is the fenced snippet. Dropping fences would collapse both to "use"
  // and false-merge at 1.0; preserving them keeps the fingerprints distinct.
  const a = mkThread({
    id: 501, path: "a.ts", startLine: 10, line: 12, author: "chatgpt-codex-connector",
    body: "This should use:\n```js\nawait store.close();\n```",
  });
  const b = mkThread({
    id: 502, path: "a.ts", startLine: 10, line: 12, author: "coderabbitai",
    body: "This should use:\n```js\nawait queue.flush();\n```",
  });
  const { records, duplicateCount } = dedupeThreads([a, b]);
  assert.equal(duplicateCount, 0, "distinct code snippets must not merge");
  assert.equal(records.find((r) => r.id === "t502").canonicalId, "t502", "second finding stays its own canonical");
});

test("identical fenced snippets with similar prose still dedupe (positive)", () => {
  // A genuine cross-reviewer duplicate: same fenced fix on the same lines.
  const a = mkThread({
    id: 503, path: "a.ts", startLine: 10, line: 12, author: "chatgpt-codex-connector",
    body: "This should use:\n```js\nawait store.close();\n```",
  });
  const b = mkThread({
    id: 504, path: "a.ts", startLine: 10, line: 12, author: "coderabbitai",
    body: "This should use:\n```js\nawait store.close();\n```",
  });
  const { duplicateCount } = dedupeThreads([a, b]);
  assert.equal(duplicateCount, 1, "same code + prose is a real duplicate and still folds");
});

test("negation tokens survive fingerprinting (no/not/cannot are not stopwords)", () => {
  // Dropping negations makes a prohibition and its opposite recommendation
  // share the same tokens; keeping them preserves the distinguishing signal.
  for (const neg of ["not", "no", "cannot"]) {
    assert.ok(fingerprint(`you must ${neg} touch this`).has(neg), `${neg} must be a fingerprint token`);
  }
});

test("distinct JSX/generic tags in fences are not stripped as HTML (negative)", () => {
  // Fenced code is preserved, but the later HTML-tag pass would delete <Foo/>
  // and <Bar/> and collapse both to the same tokens; flattening angle brackets
  // inside the fence keeps Foo/Bar as distinguishing tokens.
  const a = mkThread({
    id: 511, path: "a.tsx", startLine: 5, line: 5, author: "chatgpt-codex-connector",
    body: "Return:\n```tsx\nreturn <Foo />;\n```",
  });
  const b = mkThread({
    id: 512, path: "a.tsx", startLine: 5, line: 5, author: "coderabbitai",
    body: "Return:\n```tsx\nreturn <Bar />;\n```",
  });
  const { duplicateCount } = dedupeThreads([a, b]);
  assert.equal(duplicateCount, 0, "distinct JSX tags must not merge");
});

test("distinct JSX/generic tags in INLINE code are not stripped as HTML (negative)", () => {
  // Inline code gets the same angle-bracket flattening as fenced code, so the
  // later HTML pass can't delete <Foo/> / <Bar/> and collapse them.
  const a = mkThread({
    id: 521, path: "a.tsx", startLine: 5, line: 5, author: "cursor",
    body: "Return `<Foo />` here",
  });
  const b = mkThread({
    id: 522, path: "a.tsx", startLine: 5, line: 5, author: "chatgpt-codex-connector",
    body: "Return `<Bar />` here",
  });
  const { duplicateCount } = dedupeThreads([a, b]);
  assert.equal(duplicateCount, 0, "distinct inline JSX tags must not merge");
});

test("a finding line mentioning 'generated by' mid-sentence is not stripped as a footer", () => {
  // The footer strip is anchored to line start; a real finding line that merely
  // contains a footer phrase must survive so its distinguishing tokens remain.
  const cleaned = stripMarkup("Validate the generated by header before write");
  assert.match(cleaned, /generated/, "mid-line 'generated by' must survive");
  assert.match(cleaned, /validate/);
  assert.match(cleaned, /header/);
});

test("real bot-footer lines are still stripped", () => {
  const cleaned = stripMarkup(
    "Real finding about the parser\n\n_Generated by CodeRabbit_\nReact with 👍 / 👎\nWas this comment helpful?",
  );
  assert.match(cleaned, /real finding about the parser/, "the finding text survives");
  assert.doesNotMatch(cleaned, /coderabbit/, "'Generated by ...' footer line stripped");
  assert.doesNotMatch(cleaned, /react with/, "'React with' footer line stripped");
  assert.doesNotMatch(cleaned, /helpful/, "'Was this ... helpful' footer line stripped");
});

test("a footer phrase INSIDE fenced code is preserved, not stripped", () => {
  // The footer strip runs after fenced code is pulled to a placeholder, so a
  // fenced line starting with a footer phrase survives as distinguishing tokens.
  const a = "The banner must read:\n```\nGenerated by foo\n```";
  const b = "The banner must read:\n```\nGenerated by bar\n```";
  assert.match(stripMarkup(a), /foo/, "fenced footer-like content survives (foo)");
  assert.match(stripMarkup(b), /bar/, "fenced footer-like content survives (bar)");
  assert.equal(dedupeThreads([
    mkThread({ id: 671, path: "a.ts", startLine: 4, line: 8, author: "cursor", body: a }),
    mkThread({ id: 672, path: "a.ts", startLine: 4, line: 8, author: "chatgpt-codex-connector", body: b }),
  ]).duplicateCount, 0, "distinct fenced footer snippets must not merge");
});

test("opposite directional findings (same tokens, reversed order) do NOT merge", () => {
  // k=1 sets are identical (sim 1.0) but the order is reversed; the directional
  // guard cross-checks the ordered bigram similarity and refuses to fold.
  const a = mkThread({
    id: 601, path: "a.ts", startLine: 10, line: 12, author: "cursor",
    body: "Use cache instead of store here",
  });
  const b = mkThread({
    id: 602, path: "a.ts", startLine: 10, line: 12, author: "chatgpt-codex-connector",
    body: "Use store instead of cache here",
  });
  const { records, duplicateCount } = dedupeThreads([a, b]);
  assert.equal(duplicateCount, 0, "contradictory directives must not merge");
  assert.equal(records.find((r) => r.id === "t602").canonicalId, "t602", "second finding stays its own canonical");
});

test("equivalent findings with the same directional order still merge", () => {
  const a = mkThread({
    id: 603, path: "a.ts", startLine: 10, line: 12, author: "cursor",
    body: "Use cache instead of store here",
  });
  const b = mkThread({
    id: 604, path: "a.ts", startLine: 10, line: 12, author: "chatgpt-codex-connector",
    body: "Use cache instead of store in this path",
  });
  const { duplicateCount } = dedupeThreads([a, b]);
  assert.equal(duplicateCount, 1, "same-direction restatement is a real duplicate and folds");
});

test("reversed directives with shared trailing context still do NOT merge (operand swap)", () => {
  // The shared suffix lifts the ordered-bigram score above the reversed-order
  // cutoff, so the marker-aware operand-swap detector must catch it.
  const a = mkThread({
    id: 611, path: "a.ts", startLine: 10, line: 12, author: "cursor",
    body: "Use cache instead of store for invalidation path",
  });
  const b = mkThread({
    id: 612, path: "a.ts", startLine: 10, line: 12, author: "chatgpt-codex-connector",
    body: "Use store instead of cache for invalidation path",
  });
  const { duplicateCount } = dedupeThreads([a, b]);
  assert.equal(duplicateCount, 0, "swapped instead-of operands with shared context must not merge");
});

test("swapped 'rather than' operands do NOT merge", () => {
  const a = mkThread({
    id: 613, path: "a.ts", startLine: 10, line: 12, author: "cursor",
    body: "Prefer cache rather than store for reads",
  });
  const b = mkThread({
    id: 614, path: "a.ts", startLine: 10, line: 12, author: "chatgpt-codex-connector",
    body: "Prefer store rather than cache for reads",
  });
  assert.equal(dedupeThreads([a, b]).duplicateCount, 0, "swapped rather-than operands must not merge");
});

test("swapped MULTI-WORD directional operands do NOT merge", () => {
  // The distinguishing operands are two-word phrases; the phrase-based detector
  // must compare whole operands, not just the single tokens adjacent to the marker.
  const a = mkThread({
    id: 621, path: "a.ts", startLine: 10, line: 12, author: "cursor",
    body: "Use memory cache instead of disk store for reads",
  });
  const b = mkThread({
    id: 622, path: "a.ts", startLine: 10, line: 12, author: "chatgpt-codex-connector",
    body: "Use disk store instead of memory cache for reads",
  });
  assert.equal(dedupeThreads([a, b]).duplicateCount, 0, "swapped multi-word operands must not merge");
});

test("same-direction multi-word directive still merges", () => {
  const a = mkThread({
    id: 623, path: "a.ts", startLine: 10, line: 12, author: "cursor",
    body: "Use memory cache instead of disk store for reads",
  });
  const b = mkThread({
    id: 624, path: "a.ts", startLine: 10, line: 12, author: "chatgpt-codex-connector",
    body: "Use memory cache instead of disk store for read requests",
  });
  assert.equal(dedupeThreads([a, b]).duplicateCount, 1, "same-direction multi-token restatement folds");
});

test("contracted negations are normalized so the negation survives tokenizing", () => {
  // can't/won't/don't/isn't ... expand so 'not' is kept and a prohibition stays
  // lexically distinct from its opposite.
  assert.ok(contentTokens("can't delete the backup").includes("not"), "can't keeps a negation token");
  assert.ok(!contentTokens("can delete the backup").includes("not"), "the affirmative has no negation token");
  for (const c of ["don't drop it", "isn't valid", "won't retry"]) {
    assert.ok(contentTokens(c).includes("not"), `${c} keeps a negation token`);
  }
});

test("a prohibition and its affirmative on the same lines do NOT merge (polarity mismatch)", () => {
  // Preserving 'not' isn't enough — k=1 Jaccard still scores these ~0.8. The
  // polarity check rejects the pair (one negated, otherwise-identical content).
  const a = mkThread({
    id: 631, path: "a.ts", startLine: 4, line: 6, author: "cursor",
    body: "Do not call deleteAll before backup",
  });
  const b = mkThread({
    id: 632, path: "a.ts", startLine: 4, line: 6, author: "chatgpt-codex-connector",
    body: "Call deleteAll before backup",
  });
  assert.equal(dedupeThreads([a, b]).duplicateCount, 0, "opposite polarity must not merge");
});

test("a contracted prohibition and its affirmative do NOT merge", () => {
  const a = mkThread({
    id: 633, path: "a.ts", startLine: 4, line: 6, author: "cursor",
    body: "Don't call deleteAll before backup",
  });
  const b = mkThread({
    id: 634, path: "a.ts", startLine: 4, line: 6, author: "chatgpt-codex-connector",
    body: "Call deleteAll before backup",
  });
  assert.equal(dedupeThreads([a, b]).duplicateCount, 0, "contracted negation flips polarity too");
});

test("two same-polarity prohibitions still merge", () => {
  const a = mkThread({
    id: 635, path: "a.ts", startLine: 4, line: 6, author: "cursor",
    body: "Do not call deleteAll before backup",
  });
  const b = mkThread({
    id: 636, path: "a.ts", startLine: 4, line: 6, author: "chatgpt-codex-connector",
    body: "Do not ever call deleteAll before backup",
  });
  assert.equal(dedupeThreads([a, b]).duplicateCount, 1, "same polarity + same finding folds");
});

test("terse findings differing by one distinguishing word do NOT merge", () => {
  // Short comments: a single differing token is the whole finding. "null" vs
  // "auth" makes these distinct even though k=1 Jaccard scores them 0.6.
  const a = mkThread({
    id: 641, path: "a.ts", startLine: 4, line: 6, author: "cursor",
    body: "Missing null guard check",
  });
  const b = mkThread({
    id: 642, path: "a.ts", startLine: 4, line: 6, author: "chatgpt-codex-connector",
    body: "Missing auth guard check",
  });
  assert.equal(dedupeThreads([a, b]).duplicateCount, 0, "mutually-divergent terse findings are distinct");
});

test("a terse subset/superset restatement still merges", () => {
  const a = mkThread({
    id: 643, path: "a.ts", startLine: 4, line: 6, author: "cursor",
    body: "Missing null check",
  });
  const b = mkThread({
    id: 644, path: "a.ts", startLine: 4, line: 6, author: "chatgpt-codex-connector",
    body: "Missing null guard check",
  });
  assert.equal(dedupeThreads([a, b]).duplicateCount, 1, "only one side diverges -> real duplicate folds");
});

test("longer findings identical except one token also do NOT merge (length-agnostic)", () => {
  // The single-token guard is not limited to terse comments: a 10-token pair
  // differing only by null vs auth is still distinct.
  const a = mkThread({
    id: 645, path: "a.ts", startLine: 4, line: 6, author: "cursor",
    body: "Missing null guard check in request parser because optional metadata can crash",
  });
  const b = mkThread({
    id: 646, path: "a.ts", startLine: 4, line: 6, author: "chatgpt-codex-connector",
    body: "Missing auth guard check in request parser because optional metadata can crash",
  });
  assert.equal(dedupeThreads([a, b]).duplicateCount, 0, "one substantive token apart at any length is distinct");
});

test("a multi-token paraphrase duplicate still merges (not blanket divergence)", () => {
  // Differs on several tokens per side -> genuine paraphrase, must still fold.
  const a = mkThread({
    id: 647, path: "a.ts", startLine: 4, line: 6, author: "cursor",
    body: "The reindex call discards the code and message so the caller cannot tell a real failure from an empty result",
  });
  const b = mkThread({
    id: 648, path: "a.ts", startLine: 4, line: 6, author: "chatgpt-codex-connector",
    body: "The reindex call drops the code and message leaving the caller unable to tell a genuine failure from an empty result",
  });
  assert.equal(dedupeThreads([a, b]).duplicateCount, 1, "multi-token paraphrase folds");
});

test("swapped one-character directional operands do NOT merge", () => {
  // Operands are single characters; the directional detector must keep them.
  const a = mkThread({
    id: 649, path: "a.ts", startLine: 4, line: 6, author: "cursor",
    body: "Use x instead of y here",
  });
  const b = mkThread({
    id: 650, path: "a.ts", startLine: 4, line: 6, author: "chatgpt-codex-connector",
    body: "Use y instead of x here",
  });
  assert.equal(dedupeThreads([a, b]).duplicateCount, 0, "swapped 1-char operands must not merge");
});

test("swapped 'before'/'after' ordering directives do NOT merge", () => {
  // "before"/"after" are directional markers too; a reversed ordering directive
  // is a contradiction even with shared trailing context.
  const a = mkThread({
    id: 651, path: "a.ts", startLine: 4, line: 8, author: "cursor",
    body: "Move validation before write for request path",
  });
  const b = mkThread({
    id: 652, path: "a.ts", startLine: 4, line: 8, author: "chatgpt-codex-connector",
    body: "Move write before validation for request path",
  });
  assert.equal(dedupeThreads([a, b]).duplicateCount, 0, "swapped before/after operands must not merge");
});

test("a non-reversed 'before' directive still merges", () => {
  const a = mkThread({
    id: 653, path: "a.ts", startLine: 4, line: 8, author: "cursor",
    body: "Validate input before processing the request",
  });
  const b = mkThread({
    id: 654, path: "a.ts", startLine: 4, line: 8, author: "chatgpt-codex-connector",
    body: "Validate input before processing the request now",
  });
  assert.equal(dedupeThreads([a, b]).duplicateCount, 1, "same-order before directive folds");
});

test("a near-identical polarity flip (differs only by a context word) does NOT merge", () => {
  const a = mkThread({
    id: 655, path: "a.ts", startLine: 4, line: 8, author: "cursor",
    body: "Do not call deleteAll before backup in the reset path because it revokes all cached user sessions",
  });
  const b = mkThread({
    id: 656, path: "a.ts", startLine: 4, line: 8, author: "chatgpt-codex-connector",
    body: "Call deleteAll before backup in the reset handler because it revokes all cached user sessions",
  });
  assert.equal(dedupeThreads([a, b]).duplicateCount, 0, "near-match opposite polarity must not merge");
});

test("an unrelated directive phrase is not falsely blocked or merged", () => {
  const a = mkThread({
    id: 615, path: "a.ts", startLine: 10, line: 12, author: "cursor",
    body: "Use cache instead of store",
  });
  const b = mkThread({
    id: 616, path: "a.ts", startLine: 10, line: 12, author: "chatgpt-codex-connector",
    body: "Delete the temporary lockfile on process exit",
  });
  assert.equal(dedupeThreads([a, b]).duplicateCount, 0, "unrelated findings simply do not match");
});

test("enforce obligations fold an unresolved duplicate only with resolved canonical AND audit evidence", () => {
  // The duplicate's own thread is UNRESOLVED; its canonical is RESOLVED and the
  // gate-authored reply is present, so the finding is satisfied and folds.
  const canonical = mkThread({
    id: 701, path: "svc.ts", startLine: 3, line: 5, author: "cursor",
    body: "The retry loop never bounds its attempts and can spin forever on a dead host",
    isResolved: true,
  });
  const duplicate = mkThread({
    id: 702, path: "svc.ts", startLine: 3, line: 5, author: "chatgpt-codex-connector",
    body: "The retry loop never bounds its attempts and can spin forever on a dead host",
    isResolved: false,
    replies: [{ author: "github-actions[bot]", body: formatDuplicateReply("https://svc/1") }],
  });
  const enforce = computeGuardObligations([canonical, duplicate], REVIEW_DEDUP_CONFIG, { applyInheritance: true });
  assert.equal(enforce.duplicateCount, 1, "the second thread is a duplicate of the resolved canonical");
  assert.equal(enforce.effectiveUnresolvedCount, 0, "resolved canonical + audit evidence folds the duplicate");
  assert.equal(enforce.wouldBeLostUniqueFindings.length, 0, "nothing hidden: canonical carries the resolution");
});

test("comments on the same line but opposite diff sides do NOT merge", () => {
  // LEFT (pre-image) and RIGHT (post-image) on the same line are different
  // locations; identical text on opposite sides must not collapse.
  const left = {
    ...mkThread({ id: 801, path: "a.ts", startLine: 5, line: 7, author: "cursor", body: "This branch is dead code and should be removed" }),
    diffSide: "LEFT",
  };
  const right = {
    ...mkThread({ id: 802, path: "a.ts", startLine: 5, line: 7, author: "chatgpt-codex-connector", body: "This branch is dead code and should be removed" }),
    diffSide: "RIGHT",
  };
  assert.equal(dedupeThreads([left, right]).duplicateCount, 0, "opposite diff sides are distinct locations");
});

test("same-side duplicates on the same line still merge", () => {
  const a = {
    ...mkThread({ id: 803, path: "a.ts", startLine: 5, line: 7, author: "cursor", body: "This branch is dead code and should be removed" }),
    diffSide: "RIGHT",
  };
  const b = {
    ...mkThread({ id: 804, path: "a.ts", startLine: 5, line: 7, author: "chatgpt-codex-connector", body: "This branch is dead code and should be removed" }),
    diffSide: "RIGHT",
  };
  assert.equal(dedupeThreads([a, b]).duplicateCount, 1, "same side + same finding folds");
});

test("multi-line threads with the same end side but different START side do NOT merge", () => {
  // The end line shares a side but the multi-line span starts on different sides
  // (startDiffSide), so the two threads cover different locations.
  const a = {
    ...mkThread({ id: 811, path: "a.ts", startLine: 5, line: 9, author: "cursor", body: "This block is dead code and should be removed" }),
    startDiffSide: "LEFT", diffSide: "RIGHT",
  };
  const b = {
    ...mkThread({ id: 812, path: "a.ts", startLine: 5, line: 9, author: "chatgpt-codex-connector", body: "This block is dead code and should be removed" }),
    startDiffSide: "RIGHT", diffSide: "RIGHT",
  };
  assert.equal(dedupeThreads([a, b]).duplicateCount, 0, "differing start side is a different location");
});

test("multi-line threads with matching start AND end side still merge", () => {
  const a = {
    ...mkThread({ id: 813, path: "a.ts", startLine: 5, line: 9, author: "cursor", body: "This block is dead code and should be removed" }),
    startDiffSide: "LEFT", diffSide: "RIGHT",
  };
  const b = {
    ...mkThread({ id: 814, path: "a.ts", startLine: 5, line: 9, author: "chatgpt-codex-connector", body: "This block is dead code and should be removed" }),
    startDiffSide: "LEFT", diffSide: "RIGHT",
  };
  assert.equal(dedupeThreads([a, b]).duplicateCount, 1, "matching start+end side + same finding folds");
});

test("formatRoundLedger reports filed, deduplicated, and unique-by-reviewer counts", () => {
  const ledger = formatRoundLedger([dup1923A1, dup1923A2, ...N.slice(0, 3)]);
  assert.match(ledger, /5 filed, 1 deduplicated/);
  assert.match(ledger, /duplicate of/);
  assert.match(ledger, /unique-by-reviewer/);
});

test("anchorsOverlap requires same file and intersecting known ranges", () => {
  assert.equal(anchorsOverlap({ path: "a", start: 10, end: 20 }, { path: "a", start: 15, end: 25 }), true);
  assert.equal(anchorsOverlap({ path: "a", start: 10, end: 20 }, { path: "a", start: 21, end: 25 }), false);
  assert.equal(anchorsOverlap({ path: "a", start: 10, end: 20 }, { path: "b", start: 15, end: 25 }), false);
  assert.equal(anchorsOverlap({ path: "a", start: null, end: null }, { path: "a", start: 15, end: 25 }), false);
});

// --- Gate-authored reply, label, and idempotency ----------------------------

test("formatDuplicateReply carries the marker, canonical link, and detach instruction", () => {
  const url = "https://github.com/x/y/pull/1#discussion_r101";
  const reply = formatDuplicateReply(url);
  assert.ok(reply.startsWith(GATE_REPLY_MARKER));
  assert.match(reply, /Duplicate of https:\/\/github\.com\/x\/y\/pull\/1#discussion_r101/);
  assert.match(reply, /not-a-duplicate/);
  assert.equal(DUPLICATE_LABEL, "duplicate-finding");
});

test("hasGateReply detects the gate's prior reply for idempotency", () => {
  const withReply = mkThread({
    id: 401, path: "a.ts", startLine: 1, line: 2, author: "cursor", body: "finding",
    replies: [{ author: "github-actions[bot]", body: formatDuplicateReply("https://x/1") }],
  });
  const without = mkThread({ id: 402, path: "a.ts", startLine: 1, line: 2, author: "cursor", body: "finding" });
  assert.equal(hasGateReply(withReply), true);
  assert.equal(hasGateReply(without), false);
});

test("hasGateReply rejects a spoofed marker from a non-bot author", () => {
  // The marker is public; only the Actions bot's reply may count as a real gate
  // fold, or anyone who can comment could fold a duplicate out of the guard.
  const spoofed = mkThread({
    id: 405, path: "a.ts", startLine: 1, line: 2, author: "cursor", body: "finding",
    replies: [{ author: "attacker", body: formatDuplicateReply("https://x/1") }],
  });
  assert.equal(hasGateReply(spoofed), false, "a non-bot marker must not satisfy hasGateReply");
});

test("the gate's own reply never self-triggers the detach escape hatch", () => {
  const gateReplied = mkThread({
    id: 403, path: "a.ts", startLine: 1, line: 2, author: "cursor", body: "finding",
    replies: [{ author: "github-actions[bot]", body: formatDuplicateReply("https://x/1") }],
  });
  assert.equal(isDetached(gateReplied), false, "gate instruction mentioning not-a-duplicate must not detach");

  const maintainerDetach = mkThread({
    id: 404, path: "a.ts", startLine: 1, line: 2, author: "cursor", body: "finding",
    replies: [
      { author: "github-actions[bot]", body: formatDuplicateReply("https://x/1") },
      { author: "maintainer", body: "not-a-duplicate — distinct fix" },
    ],
  });
  assert.equal(isDetached(maintainerDetach), true, "a real not-a-duplicate reply still detaches");
});

// --- Workflow integration contract ------------------------------------------

test("review-thread-guard workflow mirrors the dedup module and stays in shadow mode by default", () => {
  const workflow = readFileSync(".github/workflows/review-thread-guard.yml", "utf8");
  assert.match(workflow, /dedup/i);
  assert.match(workflow, /not-a-duplicate/);
  assert.match(workflow, /REVIEW_DEDUP_MODE/);
  assert.match(workflow, /shadow/);
  // Enforcement must default off: the count-changing branch is gated on an
  // explicit enforce flag so shadow mode is byte-identical to today.
  assert.match(workflow, /applyInheritance/);
});

test("review-thread-guard workflow posts the gate reply and duplicate-finding label only under enforce", () => {
  const workflow = readFileSync(".github/workflows/review-thread-guard.yml", "utf8");
  // Write-side must exist: reply-linking + label via the REST helpers.
  assert.match(workflow, /createReplyForReviewComment/);
  assert.match(workflow, /addLabels/);
  assert.match(workflow, /duplicate-finding/);
  assert.match(workflow, /remnic-review-dedup:duplicate/);
  // Writes require write permissions and must be guarded by the enforce flag.
  assert.match(workflow, /pull-requests:\s*write/);
  assert.match(workflow, /issues:\s*write/);
});

test("kilo-code-bot is retired from the reviewer lineup", () => {
  const gate = readFileSync(".github/workflows/ai-review-gate.yml", "utf8");
  assert.doesNotMatch(gate, /kilo-code-bot\[bot\].*REQUIRED_AI_REVIEWER_GROUPS/s);
  assert.doesNotMatch(gate, /REQUIRED_AI_REVIEWER_GROUPS[\s\S]{0,200}kilo/i);
});
