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

test("gate-off parity: pure packReviewContext boosts only on touched file paths", () => {
  const candidates = [
    c("auth-history", 0.2, ["src/auth.ts"]),
    c("unrelated", 0.9, ["src/other.ts"]),
    c("weak-match", 0.1, ["auth.ts"]),
  ];
  const result = packReviewContext({ diff: DIFF_TOUCHING_AUTH, candidates });
  assert.equal(result.touchedFiles.length, 1);
  assert.equal(result.touchedFiles[0], "src/auth.ts");
  assert.equal(result.structuralDegradation, undefined);
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
  const pure = packReviewContext({ diff: DIFF_TOUCHING_AUTH, candidates });
  assert.deepEqual(
    result.rankedRecall.map((r) => ({ id: r.id, boost: r.boost })),
    pure.rankedRecall.map((r) => ({ id: r.id, boost: r.boost })),
  );
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
// ──────────────────────────────────────────────────────────────────────────

test("structural success: symbol match floats a memory that shares NO file path", async () => {
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
  assert.equal(result.structuralDegradation, undefined);
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
