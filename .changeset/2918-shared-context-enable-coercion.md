---
"@remnic/core": patch
---

Fix `sharedContextEnabled` parsing to accept the same boolean forms as `sharedContextAllowBindingAuthority`: real booleans plus the CLI/config strings `true|false|1|0|yes|no|on|off` via the shared `coerceBool` coercer. Previously a strict `=== true` check silently ignored `--config sharedContextEnabled=true` and any config file carrying the string `"true"`, leaving the feature off for deployments that believed they had enabled it; after this change those deployments activate on upgrade. An unrecognized value (e.g. `"garbage"` or a typo) warns and keeps the default `false` — malformed input never silently enables the feature. Closes #2918.
