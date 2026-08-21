---
"@remnic/cli": patch
---

Stop logging anything derived from the config file when a config load fails. The commands print the error class and the config path only; `parseConfig` error text (which embeds raw values) is still withheld, and the key-name report added in the previous change is removed because CodeQL treats the config text as sensitive once a credential is parsed out of it, so no derived output can clear `js/clear-text-logging`.
