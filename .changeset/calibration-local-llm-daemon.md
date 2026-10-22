---
"@remnic/core": patch
---

Calibration consolidation uses the configured local LLM when the gateway model chain is empty. The standalone daemon has no `gatewayConfig`, so `calibrationEnabled` previously built a gateway client, saw no models, and skipped at debug level. Skips now log at warn or info. `calibrationEnabled` stays default-off.

Stability: alpha
