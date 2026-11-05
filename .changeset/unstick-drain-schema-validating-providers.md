---
"@remnic/core": patch
---

Unstick the extraction backlog drain on schema-validating providers.

Providers that reject the structured-output schema itself — a 400 "invalid
params, Mismatch type string with value array" quoting a schema fragment
(e.g. MiniMax's strict parser on the nullable `type` unions zod emits in
draft-7) — never name `response_format`, so the schema-rejection path did not
strip the format: every drain attempt re-sent the identical payload and the
provider circuit breaker opened. Those errors now match the schema-rejection
matcher, and the rejection is learned per model and persisted in the
ModelRegistry (`structuredOutput: "none"`), so later requests and restarted
runtimes send the compatible no-response_format shape from the start. A
schema-carrying success persists `structuredOutput: "native"`; providers that
accept the schema keep structured output unchanged.

The backlog scheduler also skips submission entirely while the shared
provider breaker is OPEN inside its cooldown window — a full attempt reads
the claim, rebuilds the buffer and re-renders chunks before the breaker fails
it fast, which is pure churn during a stall. Claims stay durable and the
breaker's single half-open probe keeps recovery automatic once the window
lapses.

Stability: stable
