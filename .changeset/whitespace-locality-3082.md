---
"@remnic/core": patch
---

Stability: stable

Collapse horizontal whitespace runs before injection screening. The rule patterns bound inter-word whitespace for ReDoS safety, so a long run of spaces could split a directive from its corroborator and screen clean (`must include<40 spaces>CANARY`); the terminal-URL locality window had the same blind spot past four whitespace characters. Frozen-corpus quarantine sets are byte-identical in both profiles.
