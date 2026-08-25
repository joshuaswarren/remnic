---
"@remnic/core": patch
---

Fix `sharedContextEnabled` parsing to accept the same boolean forms as `sharedContextAllowBindingAuthority`: real booleans plus the CLI/config strings `true|false|1|0|yes|no|on|off` via the shared `coerceBool` coercer. Previously a strict `=== true` check silently ignored `--config sharedContextEnabled=true` and any config file carrying the string `"true"`, leaving the feature off for deployments that believed they had enabled it; after this change those deployments activate on upgrade. The coerced boolean is reused for the default recall-pipeline `shared-context` section (no second parse); a custom `recallPipeline` keeps the operator's section `enabled`. An unrecognized value (e.g. `"garbage"` or a typo) warns and keeps the default `false` — malformed input never silently enables the feature. Closes #2918.
