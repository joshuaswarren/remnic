---
"@remnic/core": patch
---

Use a shared NFC-normalized, script-aware token estimate for chunking, recall budgets, transcript formatting, LCM accounting, extension rendering, local LLM usage, and Codex materialization (issue #2188). Japanese and other wide-script content now consumes about one estimated token per code point instead of one token per four characters.
