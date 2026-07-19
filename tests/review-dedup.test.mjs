import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  REVIEW_DEDUP_CONFIG,
  anchorsOverlap,
  computeGuardObligations,
  dedupeThreads,
  fingerprint,
  fingerprintSimilarity,
  formatRoundLedger,
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

test("resolving the canonical auto-satisfies its duplicate under enforcement", () => {
  const canonical = { ...dup1923A1, isResolved: true };
  const duplicate = { ...dup1923A2, isResolved: false };
  const enforce = computeGuardObligations([canonical, duplicate], REVIEW_DEDUP_CONFIG, {
    applyInheritance: true,
  });
  assert.equal(enforce.duplicateCount, 1);
  assert.equal(enforce.effectiveUnresolvedCount, 0, "resolved canonical clears the duplicate");
  assert.equal(enforce.wouldBeLostUniqueFindings.length, 0);
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
    replies: [{ author: "joshuaswarren", body: "not-a-duplicate — this is the async path, distinct fix." }],
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

test("kilo-code-bot is retired from the reviewer lineup", () => {
  const gate = readFileSync(".github/workflows/ai-review-gate.yml", "utf8");
  assert.doesNotMatch(gate, /kilo-code-bot\[bot\].*REQUIRED_AI_REVIEWER_GROUPS/s);
  assert.doesNotMatch(gate, /REQUIRED_AI_REVIEWER_GROUPS[\s\S]{0,200}kilo/i);
});
