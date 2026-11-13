---
"@remnic/core": patch
---

LCM summarize now sizes the prompt's summary target and the `max_tokens` completion budget by the text it actually sends to the model (the first 12,000 characters), not by the whole batch. A long leaf or rollup batch previously asked for more than 16,384 completion tokens for a prompt of about 3k tokens. Endpoints with an output cap, including the bundled Hermes bridge, rejected that call with HTTP 400, and the node fell back to the aggressive or deterministic summary. Batches that fit in one call are unchanged. Closes #3407.

Stability: stable
