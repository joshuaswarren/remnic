---
"@remnic/core": minor
Stability: stable
---

Wire the chat executor's `correction_plan` / `correction_apply` tools to the Correction Contract (#1580) plan/apply pipeline instead of returning a not-available stub, and expose the tools in chat sessions whenever the correction feature gate is on. Closes #3553.
