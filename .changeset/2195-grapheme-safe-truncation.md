---
"@remnic/core": patch
"@remnic/cli": patch
---

fix(surfaces): grapheme-safe truncation and display-width table padding (#2195)

- Add `truncateGraphemeSafe` (Intl.Segmenter grapheme granularity with a code-point fallback) next to `truncateCodePointSafe` in `@remnic/core` whitespace helpers. It returns the longest prefix that fits a UTF-16 budget without splitting a surrogate pair or a grapheme cluster (ZWJ emoji, flags, Hangul jamo runs, combining marks).
- Migrate the UTF-16-slicing truncation sites to it: `entity-retrieval.ts` `compactLine` and the entity-hints trim, the memory/search/cluster/topics transcript previews in `packages/remnic-core/src/cli.ts`, and the recall section truncation (including the token-budget binary search, which now walks grapheme segments) in `orchestration/recall-section-coordinator.ts`.
- Add `displayWidth` (East_Asian_Width Wide/Fullwidth = 2, combining marks = 0) and `padEndDisplay`, and use them for the CLI topic/importance tables and the bench output metric columns so CJK rows stay aligned. Closes #2195.
