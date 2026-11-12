---
"@remnic/core": patch
---

The Google Drive live connector no longer waits forever for the host secret resolver. The wait now ends when the sync aborts or after 30 seconds, and the error names the field and never the reference. A resolver that returns no value now says the host secret resolver may be unavailable. The manifest SecretRef schema now requires a non-empty `source`.

Stability: stable
