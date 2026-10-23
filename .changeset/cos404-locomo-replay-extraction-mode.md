---
"@remnic/cli": patch
---

`remnic bench run locomo` and `remnic bench published --name locomo` accept `--replay-extraction-mode <skip|await>`. The default stays `skip` (LCM-first, extractor not called), so existing LoCoMo numbers do not change. `await` runs the configured extractor on every replayed session, which extractor-model comparisons need. It requires the remnic adapter with `--runtime-profile real` or `openclaw-chain` (no `--quick` or `--matrix`). Other values and non-LoCoMo targets are rejected.

Stability: stable
