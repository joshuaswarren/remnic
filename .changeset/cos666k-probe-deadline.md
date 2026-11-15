---
"@remnic/core": patch
---

The single half-open probe of the extraction provider breaker is now bounded at 15 minutes: a probe that gets no answer in time is cancelled and counts as a provider failure, so the breaker re-opens instead of holding every claim drain until the provider answers or times out (measured in production: up to 55 minutes).

Stability: stable
