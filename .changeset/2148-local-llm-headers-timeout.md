---
"@remnic/core": patch
---

Honor `localLlmTimeoutMs` above 300s for local LLM chat completions (issue #2148). Node's global fetch runs on undici, which applies a default 300s `headersTimeout`; a non-streaming completion sends its response headers only once generation finishes, so any completion slower than five minutes failed with a bare `fetch failed` no matter how large the configured budget was — a deployment running `localLlmTimeoutMs: 960000` saw every extraction die at ~300s intervals. The chat request now carries an undici `Agent` whose `headersTimeout`/`bodyTimeout` track the configured budget, so the documented timeout is honored end to end. The pool is cached per client and rebuilt when the budget changes; per-request budgets below the ceiling remain enforced by the existing abort signal.

The request transport moved out of `local-llm.ts` into a new `local-llm-transport.ts` (`ChatTransport`), keeping the client module focused on prompt/response semantics and keeping the file under its structural ratchet. Two incidental fixes came with the move: the request body is serialized once instead of twice, and the debug-only body dump now writes to `<tmpdir>/remnic-last-request.json` with `0600` permissions instead of a world-readable, pre-rename `/tmp/engram-last-request.json`.
