---
"@remnic/core": patch
---

Harden the review loop after a five-PR parallel run: preflight now names a missing local install so cross-package resolution errors are not read as defects, a stream rule keeps PR bodies out of expanding heredocs, and the test-quality checklist requires proving each new regression actually discriminates.
