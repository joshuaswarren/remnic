---
"@remnic/core": patch
---

`scripts/deploy/jarvis-ml/remnic-llm-proxy.py` pool files may now list several upstreams under `targets` (each `base`, `model`, `key`, `slots`). A chat call takes the first target with a free slot, a busy or failing target is skipped for `POOL_FAIL_COOLDOWN_S` (default 30 s), and a pool whose targets declare different model names is refused. Single-target `{base, model, key}` files are unchanged. Deploy-only script; nothing is deployed by this change.

Stability: stable
