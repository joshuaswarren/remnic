---
"@remnic/core": patch
---

Omit `span` from the extraction provider JSON schema when span-mode is off so structured-output responses cannot smuggle spans. On and shadow keep the same schema as before. Closes #2952.
