---
"@remnic/core": patch
Stability: stable
---

`HourlySummarizer` accepts an optional `llmClients` constructor argument typed as the subset of the LLM client surface it calls (`chatCompletion`, `parseWithSchema`). Production behavior is unchanged; the seam replaces `as any` private-field stubbing in `summarizer-shutdown.test.ts`. Refs #3570.
