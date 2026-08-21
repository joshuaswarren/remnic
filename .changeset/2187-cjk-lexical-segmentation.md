---
"@remnic/core": patch
---

Fix CJK/Thai lexical segmentation in the Orama backend (issue #2187).

The Orama index now uses a custom tokenizer that expands space-free script runs (Han, Hiragana, Katakana, Thai) into character n-grams — the same segmentation strategy as the query-side recall tokenizer — so Japanese/Chinese/Thai phrase queries match lexically without embeddings. Other non-Latin scripts are indexed as whole words instead of being dropped. Latin tokenization is unchanged, so existing English indexes stay term-compatible; indexes written by older versions are detected via a persisted tokenization-version marker and rebuilt in place on first open (vectors preserved). Gated by `oramaCjkSegmentation` (default on). LanceDB's FTS limitation is documented explicitly, and `docs/search-backends.md` gains a "Non-English content" section.
