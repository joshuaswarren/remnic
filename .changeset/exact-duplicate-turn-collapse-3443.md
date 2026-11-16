---
"@remnic/core": patch
---

Stability: stable

Collapse exact-duplicate turns (same role and content, within one extraction scope) before the extraction LLM call (issue #3443): each drain run's window is deduped to first occurrences before chunk planning, chunks are packed with unique turns and each carries its duplicates as marked copies that ride the same chunk, so the model sees each text once. Clearing and drops remove representative and duplicates together; on failure all identities stay retained. Raw turns in buffers and claims are never altered or deleted. Expected effect on the sampled backlog: about 17.6 percent fewer turns and 16.5 percent fewer characters sent to the model; larger in burst sessions.
