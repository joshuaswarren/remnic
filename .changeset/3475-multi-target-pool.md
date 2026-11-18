---
"@remnic/core": patch
---

`scripts/deploy/jarvis-ml/remnic-llm-proxy.py` pool files may now list several upstreams under `targets` (each `base`, `model`, `key`, `slots`) — or, for embedding pools, `members` (each `name`, `url`, `weight`, `slots`). A call takes a weighted-random pick among targets with a free slot, a busy or failing target is skipped for `POOL_FAIL_COOLDOWN_S` (default 30 s), and a pool whose targets declare different model names is refused. `POST /v1/embeddings` routes to `EMBED_POOL_FILE` with `EMBED_TIMEOUT_S` (default 3 s) per member attempt; a member returning vectors with the wrong `dimensions` count is cooled down like a failing one. Single-target `{base, model, key}` files are unchanged. Deploy-only script; nothing is deployed by this change.

Stability: stable
