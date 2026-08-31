---
"@remnic/belief-ledger": patch
---

Stability: stable

Alias `FallbackLlmLedgerAdapterOptions` to `FallbackLlmOptions` so tsup DTS keeps the full option surface and no longer drops `temperature`/`maxTokens`.
