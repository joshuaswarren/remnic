---
"@remnic/core": patch
---

Honor `localLlmTimeoutMs` above 300s for local LLM chat completions (issue #2148). Node's global fetch runs on undici, which applies a default 300s `headersTimeout`; a non-streaming completion sends its response headers only once generation finishes, so any completion slower than five minutes failed with a bare `fetch failed` no matter how large the configured budget was — a deployment running a 16-minute budget saw every extraction die at ~300s intervals. The chat request now carries an undici `Agent` whose `headersTimeout`/`bodyTimeout` track the configured budget, so the documented timeout is honored end to end. The pool is cached per client and rebuilt when the budget changes; per-request budgets below the ceiling remain enforced by the existing abort signal.

A process-wide dispatcher installed by the host — a `ProxyAgent`, or a custom connect/TLS/DNS transport — is left in place rather than displaced, since swapping in our own pool would bypass it entirely. On those setups the 300s cap still applies, because only the dispatcher's owner can rebuild it with a wider budget; that is logged once at debug rather than failing silently.

The request transport moved out of `local-llm.ts` into a new `local-llm-transport.ts` (`ChatTransport`), keeping the client module focused on prompt/response semantics. Two cleanups came with the move: the request body is serialized once instead of twice, and the debug-only body dump was removed — it wrote full request bodies (which can contain user content) to a predictable, world-readable path, directly beneath a comment warning against exactly that. `log.debug` still reports the body length.
