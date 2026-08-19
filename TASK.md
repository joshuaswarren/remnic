Implement the next slice of GitHub issue #2051 in this worktree (Remnic public repo). Branch is already `fix/2051-recap-window`.

# Context (already merged, do not rewrite)
`packages/remnic-core/src/activity/timeline/` already contains: `journal-recap.ts` (`renderDeterministicJournal`), `journal-recap-persist.ts`, `recap-export.ts`, `recap-markdown.ts`, `recap-date.ts` (`parseRecapDate`), `recap-tz.ts`, `recap-empty.ts`, `recap-card-count.ts`, `recap-card-id.ts`, `recap-sort-key.ts`.

# Target
NEW file `packages/remnic-core/src/activity/timeline/recap-window.ts` plus `recap-window.test.ts`, and one export line in `packages/remnic-core/src/activity/timeline/index.ts`.

Non-goals: do NOT modify `journal-recap.ts`, the persist module, or any CLI/MCP/HTTP surface. Do NOT grow an existing file (fileSizeGrandfather ratchets: extract, never grow).

# Change
Add a pure, deterministic clip helper that the recap renderers can share instead of each re-deriving day bounds:

```ts
export interface RecapWindowCard { id: string; startUtc: string; endUtc: string }
export interface ClippedRecapCard { id: string; startMs: number; endMs: number; durationMs: number }
export function clipCardsToRecapWindow(
  cards: readonly RecapWindowCard[],
  windowStartMs: number,
  windowEndMs: number,
): ClippedRecapCard[]
```

Rules (all load-bearing, each needs a test):
- Half-open `[windowStartMs, windowEndMs)` semantics: a card ending exactly at `windowStartMs` is excluded; a card starting exactly at `windowEndMs` is excluded. A card touching midnight must land in exactly one day.
- Clip each card to the window, then drop any card whose clipped duration is `<= 0`.
- Skip cards whose `startUtc`/`endUtc` do not parse to a finite epoch (never throw on one bad card).
- Throw a `RangeError` when `windowEndMs <= windowStartMs`.
- Sort output with a TOTAL comparator: `startMs` ascending, then `id` ascending; equal keys return 0 so the sort is stable and repeated calls are byte-identical.
- Empty input returns `[]` (not an error).

# Acceptance
`recap-window.test.ts` (node:test + `node:assert/strict`) must cover: empty input; exact-midnight boundary on both ends (each card in exactly one window); clipping a card that straddles the window; unparseable timestamps skipped; inverted window throws; deterministic order across two calls with duplicate `startMs`.

Assertions must be on non-empty expected data — no `assert.deepEqual(x, [])` as the only check for a behavior.

Run ONLY:
`NODE_OPTIONS=--conditions=remnic-source npx tsx --test packages/remnic-core/src/activity/timeline/recap-window.test.ts`
0 fail required.

Add a changeset under `.changeset/` (patch bump for `@remnic/core`).

Then: `git add -A && git commit -m "feat(activity): add clipCardsToRecapWindow half-open recap clip helper"` and `git push github fix/2051-recap-window`. Do NOT open a PR. Do NOT run the full suite, lint, or formatters. Never write home directory paths, hostnames, usernames, or memory content into the repo.
