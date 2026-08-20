---
"@remnic/core": patch
"@remnic/cli": patch
---

Fix five CodeQL code-scanning alerts. `remnic codegraph export-okf` and `remnic export okf` no longer print config-derived error messages: config-load failures print the config with secret-named keys replaced by `[redacted]` (matched by key name, recursively, so newly named key fields are covered without code changes) instead of the parse error text. Three regexes are rewritten to be linear on adversarial inputs — the location tag slug edge trim, the OKF first-heading match, and the converge peer-URL trailing-slash trim — with no behavior change for valid input.
