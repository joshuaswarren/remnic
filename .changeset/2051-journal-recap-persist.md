---
"@remnic/core": minor
---

Persist deterministic daily journal recaps through the existing journal write ownership (Part of #2051). Writes `journal/<YYYY-MM-DD>.md` only when the file is absent, unless force is set. Body is the deterministic recap renderer. AI mode stays later.
