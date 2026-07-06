/**
 * recall-handles.ts — injection-time memory handles (issue #1582).
 *
 * Every injected memory gets a stable short handle — `[m:4f2a]` — so a user
 * (or the agent) can react to ONE specific memory in-band ("[m:4f2a] is
 * stale", thumbs-down, "correct that") without a context switch to a CLI or
 * console. The handle is derived from the memory **id** (never the content),
 * so it is stable across edits/versioning.
 *
 * This module is PURE — no I/O, no side effects, no state. It owns:
 *   - {@link handleFor} — deterministic 4-hex handle from a memory id.
 *   - {@link renderHandle} / {@link renderHandlesForInjection} — render the
 *     `[m:xxxx]` token for one memory (or a whole injection set, extending to
 *     6 chars on intra-injection collision).
 *   - {@link parseHandles} — extract handle tokens from prose.
 *   - {@link normalizeHandle} / {@link isHandleToken} — classify a string.
 *   - {@link resolveHandle} — map a handle back to a memory id against the
 *     session's recent recall snapshots (hit / not-found / ambiguous).
 *
 * Design rules honored (issue #1582 design + pitfalls):
 *   - Handles are derived from the id only — never hashed with content, never
 *     persisted into memory files or rawContent (rule 23). Rendering happens
 *     at injection time only.
 *   - Resolution is per-session and snapshot-scoped — there is NEVER a global
 *     handle→id map (collision space too small globally, leaks across
 *     principals — rule 42). Misses are tagged, never guessed (rule 34/51).
 *   - The formatter is allocation-light: a string append at render time, no
 *     per-memory object churn, because it runs on every recall.
 */

import { createHash } from "node:crypto";

/**
 * Default handle width in hex characters (4 → 65 536-handle space).
 * Per-injection sets are ~10–40 memories, so in-context collisions are
 * vanishingly rare; {@link renderHandlesForInjection} widens the colliding
 * member to {@link HANDLE_EXTENDED_WIDTH} when two ids in ONE injection would
 * collide.
 */
export const HANDLE_DEFAULT_WIDTH = 4;

/**
 * Width used to disambiguate two ids that collide at the default width within
 * a single injection. 6 hex chars → ~16 M-handle space, which is comfortably
 * beyond per-injection set sizes.
 */
export const HANDLE_EXTENDED_WIDTH = 6;

/** Minimum/maximum accepted hex widths for a rendered/parsed handle. */
export const HANDLE_MIN_WIDTH = 4;
export const HANDLE_MAX_WIDTH = 8;

/**
 * Regex matching a rendered handle token anywhere in prose: `[m:` followed by
 * 4–8 lowercase hex chars and a closing `]`. Malformed tokens (`[m:xyz!]`,
 * `[m:abc]` with uppercase, missing bracket) are intentionally NOT matched.
 * Used by {@link parseHandles} and the sanitizer.
 */
export const HANDLE_REGEX = /\[m:[0-9a-f]{4,8}\]/g;

/**
 * Memory ids are `<category>-<timestamp>-<suffix>` (e.g. `fact-1770469224307-eelr`,
 * `artifact-...`, plus parent-`-chunk-N` variants). Entity reconstructions and
 * other non-memory `.md` rows use bare names (`Widget`) that must NOT receive a
 * handle — citing one would resolve to a basename no storage can load. This
 * pattern gates handle rendering/recording to plausible memory ids only
 * (issue #1582, codex review).
 */
export const MEMORY_ID_PATTERN = /^[a-z]+-\d+-[a-z0-9-]+$/;

/**
 * Derive the deterministic handle hex for a memory id at a given width.
 *
 * `handleFor(id) === handleFor(id)` always, and `handleFor(id, w)` is a prefix
 * of `handleFor(id, w+1)` (both slice the same sha256 hex digest), so widening
 * for collision-disambiguation never changes the shorter prefix.
 *
 * @param memoryId  Stable memory id (e.g. `fact-1770469224307-eelr`).
 * @param width     Hex width. Defaults to {@link HANDLE_DEFAULT_WIDTH}.
 *                   Clamped to [4, 8]; the digest has 64 hex chars available.
 */
export function handleFor(memoryId: string, width: number = HANDLE_DEFAULT_WIDTH): string {
  const w = clampWidth(width);
  return createHash("sha256").update(memoryId).digest("hex").slice(0, w);
}

function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return HANDLE_DEFAULT_WIDTH;
  return Math.min(HANDLE_MAX_WIDTH, Math.max(HANDLE_MIN_WIDTH, Math.floor(width)));
}

/**
 * Render the `[m:xxxx]` token for one memory id. Width override is for the
 * collision-extension path in {@link renderHandlesForInjection}; callers that
 * render a single handle in isolation should omit it.
 */
export function renderHandle(memoryId: string, widthOverride?: number): string {
  return `[m:${handleFor(memoryId, widthOverride ?? HANDLE_DEFAULT_WIDTH)}]`;
}

/**
 * Append a handle to a memory line, allocation-light. When `widthOverride` is
 * omitted the default-width handle is used; pass the widened width from
 * {@link renderHandlesForInjection} for a colliding member.
 *
 *   appendHandle("API rate limit is 1000 rpm.", "fact-1-abc")
 *   // → "API rate limit is 1000 rpm. [m:4f2a]"
 */
export function appendHandle(line: string, memoryId: string, widthOverride?: number): string {
  const handle = renderHandle(memoryId, widthOverride);
  // Single trailing space before the handle; collapse a double space if the
  // line already ended in whitespace so output stays clean.
  const trimmed = line.replace(/\s+$/, "");
  return `${trimmed} ${handle}`;
}

/**
 * Result of {@link renderHandlesForInjection}: for each memory id, the width
 * used (default 4, or 6 when widened to break an intra-injection collision)
 * and the rendered token. Ordered for stable iteration.
 */
export interface InjectionHandleEntry {
  memoryId: string;
  width: number;
  handle: string;
}

/**
 * Build handles for a whole injection set, widening to 6 chars when two ids
 * collide at the default width within THIS set (so each rendered token is
 * unique in context). Idempotent for the same input.
 *
 * The collision case is vanishingly rare (~10–40 memories per injection), but
 * widening guarantees a user can always point at exactly one memory in-band.
 */
export function renderHandlesForInjection(
  memoryIds: readonly string[],
): InjectionHandleEntry[] {
  const entries: InjectionHandleEntry[] = [];
  // Group ids by their default-width handle so EVERY member of a colliding
  // group widens — not just the later one. Widening only the second id would
  // leave the first rendering a 4-char token whose resolution is ambiguous
  // against the group: a user citing that displayed 4-char handle hits both
  // ids and cannot resolve (codex review). Widening all members guarantees
  // each rendered token is unique at its own width.
  const idsByDefaultHandle = new Map<string, string[]>();
  for (const memoryId of memoryIds) {
    if (!memoryId) continue;
    const defaultHandle = handleFor(memoryId, HANDLE_DEFAULT_WIDTH);
    const group = idsByDefaultHandle.get(defaultHandle);
    if (group) group.push(memoryId);
    else idsByDefaultHandle.set(defaultHandle, [memoryId]);
  }
  // rendered token → memoryId, to guarantee uniqueness even after widening.
  const tokenToId = new Map<string, string>();

  for (const memoryId of memoryIds) {
    if (!memoryId) continue;
    const defaultHandle = handleFor(memoryId, HANDLE_DEFAULT_WIDTH);
    const group = idsByDefaultHandle.get(defaultHandle) ?? [memoryId];
    let width = group.length > 1 ? HANDLE_EXTENDED_WIDTH : HANDLE_DEFAULT_WIDTH;
    let token = `[m:${handleFor(memoryId, width)}]`;
    // Guard against a pathological collision at the widened width too (extremely
    // unlikely for real memory ids): keep widening up to HANDLE_MAX_WIDTH.
    let guard = width + 1;
    while (tokenToId.has(token) && tokenToId.get(token) !== memoryId && guard <= HANDLE_MAX_WIDTH) {
      width = guard;
      token = `[m:${handleFor(memoryId, width)}]`;
      guard += 1;
    }
    tokenToId.set(token, memoryId);
    entries.push({ memoryId, width, handle: token });
  }
  return entries;
}

/**
 * Extract every handle token from prose, in order of appearance. Returns the
 * full rendered tokens (e.g. `[m:4f2a]`) so callers can locate them in text.
 * Malformed tokens are ignored. Duplicates are preserved (a user may cite the
 * same memory twice).
 *
 *   parseHandles("see [m:4f2a] (also [m:1b9e]) — not [m:xyz!]")
 *   // → ["[m:4f2a]", "[m:1b9e]"]
 */
export function parseHandles(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const out: string[] = [];
  // Reset lastIndex because HANDLE_REGEX is /g and may be reused.
  HANDLE_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HANDLE_REGEX.exec(text)) !== null) {
    out.push(match[0]);
  }
  return out;
}

/**
 * Strip every handle token from text, collapsing the spacing it introduced.
 * Used by the sanitizer so handles observed back into the pipeline never
 * become memory content (issue #1582 hygiene §2).
 *
 *   stripHandles("API limit 1000 rpm. [m:4f2a]") → "API limit 1000 rpm."
 */
export function stripHandles(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  // Remove the token and the single preceding space that {@link appendHandle}
  // added, then tidy any double space left behind.
  // \\s? (not \\s*): the renderer appends exactly one preceding space, and a
  // bounded quantifier avoids the polynomial-ReDoS flag on uncontrolled input.
  // A stray run of spaces is collapsed by the following line.
  return text
    .replace(/\s?\[m:[0-9a-f]{4,8}\]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/g, "");
}

/**
 * Normalize a handle token (or bare hex) to its lowercase hex core, or `null`
 * when the input is not a handle. Accepts both the rendered `[m:4f2a]` form
 * and the bare `m:4f2a` / `4f2a` form a user might type.
 *
 *   normalizeHandle("[m:4f2a]") → "4f2a"
 *   normalizeHandle("m:4f2a")   → "4f2a"
 *   normalizeHandle("4f2a")     → "4f2a"
 *   normalizeHandle("fact-1")   → null
 */
export function normalizeHandle(token: string): string | null {
  if (typeof token !== "string" || token.length === 0) return null;
  const trimmed = token.trim().toLowerCase();
  // [m:4f2a]
  const bracketed = /^\[m:([0-9a-f]{4,8})\]$/.exec(trimmed);
  if (bracketed) return bracketed[1] ?? null;
  // m:4f2a
  const prefixed = /^m:([0-9a-f]{4,8})$/.exec(trimmed);
  if (prefixed) return prefixed[1] ?? null;
  // bare 4f2a — only treat as a handle when it is pure hex in the width range,
  // so we don't mis-classify a real memory id that happens to be 4 hex chars.
  const bare = /^([0-9a-f]{4,8})$/.exec(trimmed);
  if (bare) return bare[1] ?? null;
  return null;
}

/**
 * Whether a string looks like a handle token (rendered or bare). Cheaper
 * boolean form of {@link normalizeHandle} for callers that only need to branch.
 */
export function isHandleToken(token: string): boolean {
  return normalizeHandle(token) !== null;
}

/**
 * A flattened id-or-handle reference: either a raw memory id or the hex core
 * of a handle. {@link resolveMemoryIdOrHandle} produces this so the snapshot
 * lookup only runs for actual handles.
 */
export interface ParsedIdOrHandle {
  /** The original reference as supplied by the caller. */
  raw: string;
  /** `true` when `raw` is a handle that still needs snapshot resolution. */
  isHandle: boolean;
  /** For a handle, its hex core; for a raw id, the id itself. */
  value: string;
}

/**
 * Classify a single caller reference as id-or-handle.
 */
export function parseIdOrHandle(ref: string): ParsedIdOrHandle {
  const hex = normalizeHandle(ref);
  if (hex !== null) {
    return { raw: ref, isHandle: true, value: hex };
  }
  return { raw: ref, isHandle: false, value: ref };
}

/**
 * A flattened view of the memory-id sets a session has recently recalled.
 * Each entry is one past recall's admitted memory ids (newest first).
 * Resolution never sees raw {@link LastRecallSnapshot}s — callers flatten to
 * this so the pure resolver has no dependency on the snapshot type.
 */
export interface RecallSnapshotIds {
  memoryIds: readonly string[];
}

/**
 * Result of resolving a handle against recent recall snapshots.
 * - `{ ok: true, memoryId }` — exactly one match within the lookback window.
 * - `{ ok: false, reason: "not_found" }` — no memory id produced this handle
 *   within the window (misses are acceptable and tagged, never guessed).
 * - `{ ok: false, reason: "ambiguous", candidates }` — two DIFFERENT memory
 *   ids in the window collide on the same handle; the caller must disambiguate
 *   (rule 34/51: never guess).
 */
export type ResolveHandleResult =
  | { ok: true; memoryId: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "ambiguous"; candidates: string[] };

/**
 * Resolve a handle hex (or a rendered token / bare form) to its memory id
 * against the session's recent recall snapshots.
 *
 * @param handle     A handle token, bare hex, or `m:hex` form.
 * @param snapshots  Recent recall snapshots for the session, newest first.
 *                   Only the first `depth` entries are searched.
 * @param depth      How many snapshots (newest-first) to search. Defaults to
 *                   {@link DEFAULT_HANDLE_SNAPSHOT_DEPTH}.
 */
export function resolveHandle(
  handle: string,
  snapshots: readonly RecallSnapshotIds[],
  depth: number = DEFAULT_HANDLE_SNAPSHOT_DEPTH,
): ResolveHandleResult {
  const hex = normalizeHandle(handle);
  if (hex === null) {
    return { ok: false, reason: "not_found" };
  }
  // A handle resolves when a memory id's handle is a PREFIX of `hex` (handles
  // widened to 6 chars for collision still match their own 4-char core, and a
  // user citing the short form must still resolve the widened memory).
  const width = hex.length;
  const limit = Math.max(0, Math.min(depth, snapshots.length));
  const matches = new Set<string>();
  for (let i = 0; i < limit; i += 1) {
    const snap = snapshots[i];
    if (!snap) continue;
    for (const memoryId of snap.memoryIds) {
      if (!memoryId) continue;
      if (handleFor(memoryId, width) === hex) {
        matches.add(memoryId);
      }
    }
  }
  if (matches.size === 0) {
    return { ok: false, reason: "not_found" };
  }
  if (matches.size === 1) {
    return { ok: true, memoryId: matches.values().next().value as string };
  }
  return { ok: false, reason: "ambiguous", candidates: [...matches] };
}

/**
 * Default snapshot lookback depth for handle resolution (issue #1582 config
 * `recall.handleSnapshotDepth`). Older-than-N snapshots are not searched and a
 * miss is tagged rather than widening the window.
 */
export const DEFAULT_HANDLE_SNAPSHOT_DEPTH = 5;
