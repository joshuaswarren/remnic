---
"@remnic/core": patch
---

Stability: stable

Stop the console TUI refresh timer when a test assertion fails, and remove unrelated disk reads from the test fixtures. Runtime behavior is unchanged. Fixes #3496.
