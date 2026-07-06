/**
 * Canonical-text builder tests (issue #1556 step 1 — prove-fail-before).
 *
 * Rule 23/38: ONE canonical form. Two formatting-variant fixtures of the
 * same function MUST produce the same canonical text; the embedded string
 * equals the hashed string (one assertion).
 *
 * Rule 37: cache invalidation. When canonical text changes (rename / body
 * edit), the hash changes.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCanonicalText,
  buildCanonicalTextAndHash,
  canonicalTextHash,
  collapseWhitespace,
} from "./canonical-text.js";
import type { SymbolIR } from "@remnic/core";

function fn(qname: string, rawText: string): SymbolIR {
  return {
    kind: "function",
    name: qname.split(".").pop() ?? qname,
    qualifiedName: qname,
    span: { startByte: 0, endByte: rawText.length },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Rule 23/38: ONE canonical form — formatting variants hash identically.
// ──────────────────────────────────────────────────────────────────────────

test("canonical text: whitespace-only variants produce identical text", () => {
  const variantA = `function add(a, b) {\n    return a + b;\n}`;
  const variantB = `function  add(a,b){\n\treturn a+b;\n}`;
  const sym = fn("mod.add", variantA);
  const textA = buildCanonicalText({ symbol: sym, rawText: variantA });
  const textB = buildCanonicalText({ symbol: sym, rawText: variantB });
  assert.equal(textA, textB, "indentation/spacing variants must canonicalize identically");
});

test("canonical text: brace-style variants produce identical text", () => {
  const sameLine = `function foo(x) { return x * 2; }`;
  const newLine = `function foo(x)\n{\n  return x * 2;\n}`;
  const sym = fn("mod.foo", sameLine);
  assert.equal(
    buildCanonicalText({ symbol: sym, rawText: sameLine }),
    buildCanonicalText({ symbol: sym, rawText: newLine }),
  );
});

test("canonical text: the embedded string equals the hashed string (rule 23)", () => {
  const raw = `function bar(n) { return n + 1; }`;
  const sym = fn("mod.bar", raw);
  const { text, hash } = buildCanonicalTextAndHash({ symbol: sym, rawText: raw });
  // The hash is over the EXACT text returned — no transformation gap.
  assert.equal(hash, canonicalTextHash(text));
  // And a different text produces a different hash.
  const other = buildCanonicalTextAndHash({ symbol: fn("mod.baz", raw), rawText: raw });
  assert.notEqual(hash, other.hash);
});

// ──────────────────────────────────────────────────────────────────────────
// Rule 37: cache invalidation — rename / body change changes the hash.
// ──────────────────────────────────────────────────────────────────────────

test("canonical hash: rename changes the hash (cache invalidation)", () => {
  const raw = `function f() { return 42; }`;
  const before = buildCanonicalTextAndHash({ symbol: fn("mod.oldName", raw), rawText: raw });
  const after = buildCanonicalTextAndHash({ symbol: fn("mod.newName", raw), rawText: raw });
  assert.notEqual(before.hash, after.hash, "a rename must invalidate the cache");
});

test("canonical hash: body change changes the hash", () => {
  const rawA = `function f() { return 1; }`;
  const rawB = `function f() { return 2; }`;
  const before = buildCanonicalTextAndHash({ symbol: fn("mod.f", rawA), rawText: rawA });
  const after = buildCanonicalTextAndHash({ symbol: fn("mod.f", rawB), rawText: rawB });
  assert.notEqual(before.hash, after.hash);
});

test("canonical hash: unchanged symbol is stable (idempotent)", () => {
  const raw = `function stable() { console.log("hi"); }`;
  const a = buildCanonicalTextAndHash({ symbol: fn("mod.stable", raw), rawText: raw });
  const b = buildCanonicalTextAndHash({ symbol: fn("mod.stable", raw), rawText: raw });
  assert.equal(a.hash, b.hash);
  assert.equal(a.text, b.text);
});

// ──────────────────────────────────────────────────────────────────────────
// collapseWhitespace unit
// ──────────────────────────────────────────────────────────────────────────

test("collapseWhitespace: tabs/newlines/multiple-spaces → single space", () => {
  assert.equal(collapseWhitespace("\t\thello   world\t"), "hello world");
  assert.equal(collapseWhitespace("a\n\n\n\nb"), "a b");
  assert.equal(collapseWhitespace("  line one \n line two  "), "line one line two");
});

// ──────────────────────────────────────────────────────────────────────────
// Body truncation respects maxBodyLines
// ──────────────────────────────────────────────────────────────────────────

test("canonical text: body truncated to maxBodyLines (token budget)", () => {
  const raw = `function big() { ${Array.from({ length: 50 }, (_, i) => `const x${i} = ${i};`).join(" ")} }`;
  const sym = fn("mod.big", raw);
  const text4 = buildCanonicalText({ symbol: sym, rawText: raw, maxBodyLines: 4 });
  const textAll = buildCanonicalText({ symbol: sym, rawText: raw, maxBodyLines: 0 });
  const body4 = text4.split("BODY:")[1]!.trim();
  const bodyAll = textAll.split("BODY:")[1]!.trim();
  assert.ok(body4.split(/\s+/).length <= 4, `truncated body should have <=4 tokens, got ${body4.split(/\s+/).length}`);
  assert.ok(bodyAll.split(/\s+/).length > 4, "full body should have more than 4 tokens");
});
