---
"@remnic/core": patch
---

Add a built-in `codex-subscription` LLM provider so extraction and
consolidation can run on a Codex subscription (ChatGPT OAuth) login instead
of an OpenAI API key or codex-openai-proxy. Reference it in any gateway-mode
model chain, e.g. `taskModelChain: { "primary": "codex-subscription/gpt-5.5" }`.
Requests run through the `codex` CLI (sandboxed, ephemeral, tools/plugins
disabled) with the ambient `OPENAI_API_KEY`/`OPENAI_BASE_URL` stripped so the
subscription login authenticates. The provider never reads, accepts, or logs
tokens; missing, expired, or revoked logins fail fast with `codex login`
guidance, timeouts surface as `TimeoutError`, and caller aborts keep their
original reason. Existing API-key providers and defaults are unchanged.
Closes #2784.
