---
"@remnic/connector-reitti": minor
"@remnic/core": minor
---

Add the optional `@remnic/connector-reitti` location provider (issue #2045): a read-only Reitti API client and normalizer for the core location pipeline. Uses only current-user `/api/v1/timeline` and `/api/v1/visits` endpoints, supports both documented token header forms (one configured mode, never both), distinguishes empty days from auth/rate-limit/server/network/timeout/JSON/size/schema failures, honors `AbortSignal`, bounds response size, and never logs tokens. Registers through the core location registry; `@remnic/core` gains a `./location` subpath export so adapters consume the provider contract without growing the frozen root index. Closes #2045.
