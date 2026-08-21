/**
 * Tests for the structural-context-aware review-context path
 * (issue #1548 Track A PR 5).
 *
 * This file is the prove-fail-before characterization for PR 5:
 *   1. GATE-OFF PARITY — with no provider consulted (the pure
 *      {@link packReviewContext} path), output is byte-identical to
 *      pre-feature behaviour on every input. Captured FIRST, before any
 *      assertion about the wired path.
 *   2. PROVIDER-FAILURE FALLBACK — when the provider fails (any code),
 *      {@link packReviewContextStructural} ranking falls back to
 *      FILE-PATH-ONLY boosting, IDENTICAL to the pure packer, AND surfaces
 *      a distinct `structuralDegradation` so the failure is never silent
 *      (rule 34).
 *   3. PROVIDER-SUCCESS EXPANSION — when the provider returns symbols,
 *      memories mentioning a symbol name float up via the same bounded
 *      additive boost.
 *
 * The provider is a fake implementing the port contract; no subprocess.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  packReviewContext,
  packReviewContextStructural,
  rankReviewCandidates,
  type ReviewCandidate,
} from "./review-context.js";
import type {
  StructuralContextProvider,
  SymbolsForDiffResult,
} from "./structural-context.js";

function c(id: string, score: number, entityRefs?: string[]): ReviewCandidate {
  return { id, score, entityRefs };
}

/** Fake provider whose symbolsForDiff returns a fixed result. */
function providerReturning(result: SymbolsForDiffResult): StructuralContextProvider {
  return {
    id: "fake",
    async probe() {
      return { available: true };
    },
    async symbolsForDiff() {
      return result;
    },
  };
}

const DIFF_TOUCHING_AUTH = [
  "diff --git a/src/auth.ts b/src/auth.ts",
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -1,3 +1,4 @@",
  "+ export function login() {}",
].join("\n");

// ──────────────────────────────────────────────────────────────────────────
// 1. GATE-OFF PARITY — pure packReviewContext is byte-identical to today
//    (prove-fail-before: this must pass BEFORE the structural path exists,
//     and must keep passing unchanged after).
// ──────────────────────────────────────────────────────────────────────────

test("gate-off parity: pure packReviewContext boosts only on touched file paths", () => {
  const candidates = [
    c("auth-history", 0.2, ["src/auth.ts"]),
    c("unrelated", 0.9, ["src/other.ts"]),
    c("weak-match", 0.1, ["auth.ts"]),
  ];
  const result = packReviewContext({ diff: DIFF_TOUCHING_AUTH, candidates });
  assert.equal(result.touchedFiles.length, 1);
  assert.equal(result.touchedFiles[0], "src/auth.ts");
  // structuralDegradation is NOT set on the pure path.
  assert.equal(result.structuralDegradation, undefined);
  // strongest unrelated wins; auth-history floats above weak-match via boost.
  const ids = result.rankedRecall.map((r) => r.id);
  assert.deepEqual(ids, ["unrelated", "auth-history", "weak-match"]);
});

test("gate-off parity: pure packReviewContext has no structuralDegradation field effect", () => {
  const result = packReviewContext({ diff: "", candidates: [c("x", 0.5)] });
  assert.equal(result.structuralDegradation, undefined);
  assert.equal(result.rankedRecall[0]!.boost, 0);
});

test("gate-off parity: deterministic ordering matches rankReviewCandidates directly", () => {
  const candidates = [c("b", 0.3, ["a.ts"]), c("a", 0.8), c("c", 0.3, ["a.ts"])];
  const packed = packReviewContext({ diff: "diff --git a/a.ts b/a.ts", candidates });
  const direct = rankReviewCandidates(candidates, ["a.ts"]);
  assert.deepEqual(
    packed.rankedRecall.map((r) => ({ id: r.id, boost: r.boost })),
    direct.map((r) => ({ id: r.id, boost: r.boost })),
  );
});

// ──────────────────────────────────────────────────────────────────────────
// 2. PROVIDER-FAILURE FALLBACK — ranking identical to pure packer +
//    structuralDegradation populated (rule 34 — never silent)
// ──────────────────────────────────────────────────────────────────────────

test("structural fallback (a) provider_unavailable: ranking == pure packer, degradation set", async () => {
  const candidates = [
    c("auth-history", 0.2, ["src/auth.ts"]),
    c("unrelated", 0.9, ["src/other.ts"]),
  ];
  const provider = providerReturning({
    ok: false,
    code: "provider_unavailable",
    detail: "binary not found",
  });
  const result = await packReviewContextStructural({
    diff: DIFF_TOUCHING_AUTH,
    candidates,
    provider,
  });
  // Ranking must be IDENTICAL to the pure packer (file-path-only).
  const pure = packReviewContext({ diff: DIFF_TOUCHING_AUTH, candidates });
  assert.deepEqual(
    result.rankedRecall.map((r) => ({ id: r.id, boost: r.boost })),
    pure.rankedRecall.map((r) => ({ id: r.id, boost: r.boost })),
  );
  // Degradation surfaced.
  assert.equal(result.structuralDegradation?.backend, "structural-context");
  assert.equal(result.structuralDegradation?.code, "provider_unavailable");
  assert.equal(result.structuralDegradation?.detail, "binary not found");
});

test("structural fallback (c) provider_timeout: ranking == pure packer, degradation code distinct", async () => {
  const candidates = [c("auth-history", 0.2, ["src/auth.ts"])];
  const provider = providerReturning({ ok: false, code: "provider_timeout" });
  const result = await packReviewContextStructural({
    diff: DIFF_TOUCHING_AUTH,
    candidates,
    provider,
  });
  const pure = packReviewContext({ diff: DIFF_TOUCHING_AUTH, candidates });
  assert.deepEqual(
    result.rankedRecall.map((r) => r.id),
    pure.rankedRecall.map((r) => r.id),
  );
  assert.equal(result.structuralDegradation?.code, "provider_timeout");
});

test("structural fallback (d) provider_malformed: ranking == pure packer, degradation code distinct", async () => {
  const candidates = [c("auth-history", 0.2, ["src/auth.ts"])];
  const provider = providerReturning({ ok: false, code: "provider_malformed" });
  const result = await packReviewContextStructural({
    diff: DIFF_TOUCHING_AUTH,
    candidates,
    provider,
  });
  assert.equal(result.structuralDegradation?.code, "provider_malformed");
  // No symbol expansion happened — touched files unchanged.
  assert.deepEqual(result.touchedFiles, ["src/auth.ts"]);
});

test("structural fallback: provider_error code surfaces", async () => {
  const provider = providerReturning({
    ok: false,
    code: "provider_error",
    detail: "exit 2",
  });
  const result = await packReviewContextStructural({
    diff: DIFF_TOUCHING_AUTH,
    candidates: [c("x", 0.5)],
    provider,
  });
  assert.equal(result.structuralDegradation?.code, "provider_error");
});

test("structural fallback: empty diff + failing provider → no boosts, degradation still set", async () => {
  const provider = providerReturning({ ok: false, code: "provider_unavailable" });
  const result = await packReviewContextStructural({
    diff: "",
    candidates: [c("x", 0.5, ["src/auth.ts"])],
    provider,
  });
  assert.equal(result.rankedRecall[0]!.boost, 0);
  assert.equal(result.structuralDegradation?.code, "provider_unavailable");
});

// ──────────────────────────────────────────────────────────────────────────
// 3. PROVIDER-SUCCESS EXPANSION — symbols widen the match set
// ──────────────────────────────────────────────────────────────────────────

test("structural success: symbol match floats a memory that shares NO file path", async () => {
  // Candidate mentions the SYMBOL but not the touched file path.
  const candidates = [
    c("symbol-memory", 0.1, ["AuthService.login"]),
    c("file-memory", 0.1, ["src/auth.ts"]),
    c("unrelated", 0.9, ["src/other.ts"]),
  ];
  const provider = providerReturning({
    ok: true,
    symbols: [{ symbol: "AuthService.login", path: "src/auth.ts" }],
  });
  const result = await packReviewContextStructural({
    diff: DIFF_TOUCHING_AUTH,
    candidates,
    provider,
  });
  // No degradation on success.
  assert.equal(result.structuralDegradation, undefined);
  // Both symbol- and file-matched memories get the boost; unrelated still wins.
  const symbolMem = result.rankedRecall.find((r) => r.id === "symbol-memory")!;
  const fileMem = result.rankedRecall.find((r) => r.id === "file-memory")!;
  assert.equal(symbolMem.boost, 0.5, "symbol name match yields the same boost as a file match");
  assert.equal(fileMem.boost, 0.5);
  assert.equal(result.rankedRecall[0]!.id, "unrelated");
});

test("structural success: only-file-matched baseline does NOT get a symbol boost", async () => {
  const candidates = [c("only-file", 0.1, ["src/auth.ts"])];
  const provider = providerReturning({
    ok: true,
    symbols: [{ symbol: "CompletelyUnrelated.symbol" }],
  });
  const result = await packReviewContextStructural({
    diff: DIFF_TOUCHING_AUTH,
    candidates,
    provider,
  });
  // The file match still boosts; the unrelated symbol adds nothing for this memory.
  assert.equal(result.rankedRecall[0]!.boost, 0.5);
});

test("structural success: empty symbol list behaves like pure packer (no degradation)", async () => {
  const candidates = [c("auth-history", 0.2, ["src/auth.ts"])];
  const provider = providerReturning({ ok: true, symbols: [] });
  const result = await packReviewContextStructural({
    diff: DIFF_TOUCHING_AUTH,
    candidates,
    provider,
  });
  assert.equal(result.structuralDegradation, undefined);
  const pure = packReviewContext({ diff: DIFF_TOUCHING_AUTH, candidates });
  assert.deepEqual(
    result.rankedRecall.map((r) => ({ id: r.id, boost: r.boost })),
    pure.rankedRecall.map((r) => ({ id: r.id, boost: r.boost })),
  );
});

test("structural success: multiple symbols each contribute to the boost cap", async () => {
  const candidate = c("multi", 0, ["login", "logout", "validateToken", "session"]);
  const provider = providerReturning({
    ok: true,
    symbols: [
      { symbol: "login" },
      { symbol: "logout" },
      { symbol: "validateToken" },
      { symbol: "session" },
    ],
  });
  const result = await packReviewContextStructural({
    diff: DIFF_TOUCHING_AUTH,
    candidates: [candidate],
    provider,
  });
  // Boost caps at MAX_BOOST (1.0) regardless of how many symbols match.
  assert.equal(result.rankedRecall[0]!.boost, 1.0);
});

test("structural success: ranking is deterministic (stable id tie-break preserved)", async () => {
  const candidates = [c("zeta", 0.5, ["x"]), c("alpha", 0.5, ["x"])];
  const provider = providerReturning({ ok: true, symbols: [{ symbol: "x" }] });
  const result = await packReviewContextStructural({
    diff: DIFF_TOUCHING_AUTH,
    candidates,
    provider,
  });
  assert.deepEqual(
    result.rankedRecall.map((r) => r.id),
    ["alpha", "zeta"],
  );
});

// ──────────────────────────────────────────────────────────────────────────
// AbortSignal is forwarded to the provider (rule 40)
// ──────────────────────────────────────────────────────────────────────────

test("structural: abort signal is forwarded to symbolsForDiff", async () => {
  let observed: AbortSignal | undefined;
  const provider: StructuralContextProvider = {
    id: "fake",
    async probe() {
      return { available: true };
    },
    async symbolsForDiff(_diff, opts) {
      observed = opts?.signal;
      return { ok: true, symbols: [] };
    },
  };
  const ac = new AbortController();
  await packReviewContextStructural({
    diff: "",
    candidates: [],
    provider,
    signal: ac.signal,
  });
  assert.equal(observed, ac.signal);
});
