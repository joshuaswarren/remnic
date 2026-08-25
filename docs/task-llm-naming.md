# Task LLM naming (issue #2967)

`FallbackLlmClient` in `packages/remnic-core/src/fallback-llm.ts` is the **primary** gateway/task-model path in `modelSource: "gateway"`. The class and file names stay for blast radius; logs and config keys do not.

## Current names

| Surface | Current | Legacy alias |
| --- | --- | --- |
| Config timeout for the gateway/task chain | `taskLlmTimeoutMs` | `localLlmTimeoutMs` (read only when the new key is absent) |
| Config: use the task chain when the local path fails | `taskLlmFallback` | `localLlmFallback` (read only when the new key is absent) |
| User-facing log prefix | `task LLM:` | `fallback LLM:` (removed from emitted logs) |

When both the new key and the legacy key are set, the new key wins. Legacy use logs a one-time warn per process.

`localLlmTimeoutMs` is still the timeout for the **local** LLM client. If only the legacy key is set, it also sizes the task/gateway chain, which is how the process behaved before this change.

## Grep the old strings

Historical logs and runbooks still mention:

- `fallback LLM:`
- `fallback LLM: timed out after`
- `fallback LLM: all`
- `fallback LLM: no models configured`
- `extraction fallback returned no parsed output`

Those prefixes are no longer emitted. Search current logs for `task LLM:`.

The TypeScript class remains `FallbackLlmClient`. New code may import `TaskLlmClient`, which is the same class.
