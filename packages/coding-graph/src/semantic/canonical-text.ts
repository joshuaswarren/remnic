/**
 * Canonical-text builder for symbol embeddings (issue #1556).
 *
 * Rule 23/38 — ONE canonical form. The exact string that is embedded is
 * the exact string that is hashed for the embedding cache. Two formatting-
 * variant fixtures of the same function MUST produce the same canonical
 * text; the cache-hash test asserts this end to end.
 *
 * The canonical form (per the issue design):
 *   `signature + doc comment + first N lines of body`,
 * normalized (sorted-key serialization where structured, stable truncation).
 *
 * Normalization strategy: ALL whitespace (including newlines) is collapsed
 * to single spaces BEFORE signature/body split. This absorbs every
 * formatting variant (indentation, brace placement, trailing whitespace,
 * tabs vs spaces) so two semantically-identical functions produce IDENTICAL
 * canonical text. The "first N lines" budget is then applied as a stable
 * TOKEN budget over the collapsed text — stable because token count is
 * formatting-independent.
 *
 * IMPORTANT: this module takes pre-extracted text spans, not raw source.
 * The caller (the indexer) slices `[startByte, endByte)` from disk and
 * passes the raw symbol text. Canonicalization here is about producing a
 * stable embedding input from that raw text, not about re-parsing.
 */
import { createHash } from "node:crypto";

import type { SymbolIR } from "@remnic/core";

import { DEFAULT_CANONICAL_BODY_LINES } from "./config.js";

/**
 * Input to the canonical-text builder. `rawText` is the symbol's on-disk
 * source slice `[startByte, endByte)`. `docComment` is the leading
 * comment block immediately above the symbol, if the caller extracted one
 * (the parser does not currently emit doc comments on SymbolIR, so this
 * is optional and may be empty/undefined — the canonical form degrades
 * gracefully to `signature + body`).
 */
export interface CanonicalTextInput {
  readonly symbol: SymbolIR;
  /** Raw source text of the symbol span. */
  readonly rawText: string;
  /** Optional leading doc comment (/** … *\/ or // … lines). */
  readonly docComment?: string;
  /** Body token budget (default {@link DEFAULT_CANONICAL_BODY_LINES}). */
  readonly maxBodyLines?: number;
}

/**
 * Collapse ALL whitespace runs (including newlines) to single spaces and
 * trim. This is the universal normalization pass: it absorbs indentation,
 * brace placement, trailing whitespace, tabs vs spaces, and line-ending
 * differences. After this pass, two formatting variants of the same
 * function are byte-identical.
 */
export function collapseWhitespace(text: string): string {
  return text
    // Insert spaces around punctuation so a,b and a, b canonicalize identically.
    .replace(/([{}()<>\[\],;:?!=+\-*/%&|^~])/g, " $1 ")
    // Collapse all whitespace runs (including those introduced above) to single spaces.
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Line-oriented whitespace collapse (preserves line structure). Used when
 * line boundaries matter (e.g. the "first N lines" budget needs real
 * lines). Collapses intra-line whitespace runs but keeps newlines.
 */
export function collapseWhitespaceKeepLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Split normalized symbol text into signature + body at the first body-
 * open marker (`{`, `=>`, `:` preceded by a non-type context). The split
 * is CHARACTER-level on the fully-whitespace-normalized text, so a
 * same-line function `function f() { return 1; }` and a brace-newline
 * variant `function f()\n{ return 1; }` both split at the same `{`.
 *
 * Returns `{ signature, body }` — both whitespace-normalized. The
 * signature includes the marker char so the canonical form is stable.
 */
function splitSignatureBody(normalized: string): { readonly signature: string; readonly body: string } {
  // Find the first body-open marker. `{` is the universal one; `=>` covers
  // arrow functions; `:` covers type/enum members where the "body" is the
  // type expression. Order matters: check multi-char markers first.
  const markers = ["{", "=>"];
  let cutIdx = Infinity;
  for (const m of markers) {
    const idx = normalized.indexOf(m);
    if (idx >= 0 && idx < cutIdx) cutIdx = idx;
  }
  if (cutIdx === Infinity) {
    // No body marker — treat the whole text as signature (e.g. `type Foo = string`).
    return { signature: normalized, body: "" };
  }
  // Signature is everything up to and INCLUDING the marker.
  const signature = normalized.slice(0, cutIdx + 1).trim();
  const body = normalized.slice(cutIdx + 1).trim();
  return { signature, body };
}

/**
 * Extract a coarse signature string from raw symbol text. The text is
 * fully whitespace-normalized first, then split at the first body-open
 * marker. The returned signature is stable across all formatting variants
 * of the same function.
 */
export function extractSignatureLine(
  rawText: string,
  _kind: SymbolIR["kind"],
): string {
  const normalized = collapseWhitespace(rawText);
  return splitSignatureBody(normalized).signature;
}

/**
 * Extract the body (everything after the signature/header marker) from
 * raw symbol text, truncated to the first `maxBodyLines` tokens. Tokens
 * are whitespace-delimited words/operators in the normalized body text —
 * this is a STABLE budget (formatting-independent) unlike line-based
 * truncation. `maxBodyLines` is the config field name; it functions as a
 * token budget here (each "line" ≈ one significant token).
 *
 * `maxBodyLines <= 0` means unlimited (return the full normalized body).
 */
export function extractBodyText(rawText: string, maxBodyLines: number): string {
  const normalized = collapseWhitespace(rawText);
  const body = splitSignatureBody(normalized).body;
  if (maxBodyLines <= 0 || body.length === 0) return body;
  const tokens = body.split(/\s+/);
  return tokens.slice(0, maxBodyLines).join(" ");
}

/**
 * Build the canonical embedding text for a symbol.
 *
 * The form (rule 23/38 — ONE form, every consumer):
 *   KIND:<kind>\nQNAME:<qualifiedName>\nSIG:<signature>\n[DOC:<doc>]\nBODY:<body>
 *
 * `kind` and `qualifiedName` are included as stable prefix lines so two
 * functions with identical bodies but different names (the "renamed
 * variable" clone fixture) embed close but not identically — the qualified
 * name differentiates them at the embedding level while the body dominates
 * the similarity. The cache hash, by contrast, is over the FULL canonical
 * text including the name, so a rename invalidates the cache (rule 37).
 *
 * Normalization:
 *   - ALL whitespace collapsed (indentation/brace-style/newlines absorbed)
 *   - body truncated to maxBodyLines tokens (stable budget)
 */
export function buildCanonicalText(input: CanonicalTextInput): string {
  const { symbol, rawText, docComment, maxBodyLines } = input;
  const budget = maxBodyLines ?? DEFAULT_CANONICAL_BODY_LINES;
  const signature = extractSignatureLine(rawText, symbol.kind);
  const body = extractBodyText(rawText, budget);
  const doc = docComment ? collapseWhitespace(docComment) : "";
  const parts = [
    `KIND:${symbol.kind}`,
    `QNAME:${symbol.qualifiedName}`,
    `SIG:${signature}`,
  ];
  if (doc.length > 0) parts.push(`DOC:${doc}`);
  parts.push(`BODY:${body}`);
  return parts.join("\n");
}

/**
 * The cache key for a canonical text. This is sha256 over the EXACT
 * canonical text string (rule 23 — the embedded string equals the hashed
 * string). When the canonical text changes (e.g. a rename edits the
 * qualified name, or the body changes), the hash changes, and:
 *   1. the cached vector is invalidated (re-embedded), and
 *   2. any SIMILAR_TO edge derived from it is recomputed.
 *
 * This is the single chokepoint for cache invalidation (rule 37). Every
 * layer that persists a vector persists THIS hash alongside it; every
 * re-index compares THIS hash to decide whether to re-embed.
 */
export function canonicalTextHash(canonicalText: string): string {
  return createHash("sha256").update(canonicalText, "utf8").digest("hex");
}

/**
 * Convenience: build canonical text AND its hash in one call. The hash is
 * over the returned text — callers that store both MUST store the exact
 * `text` alongside the `hash` (never re-derive the text from disk and hash
 * separately, or a formatter run between the two would silently
 * re-embed — rule 37).
 */
export function buildCanonicalTextAndHash(
  input: CanonicalTextInput,
): { readonly text: string; readonly hash: string } {
  const text = buildCanonicalText(input);
  return { text, hash: canonicalTextHash(text) };
}
