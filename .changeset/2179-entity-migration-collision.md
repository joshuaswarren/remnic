---
"@remnic/core": patch
---

Entity canonical-id migration no longer aborts startup on an unresolvable id
collision. A legacy file whose normalized id collides with an existing
canonical file (or two legacy files claiming one canonical id) is skipped with
both files preserved and one aggregated warning, instead of throwing during
directory initialization and crash-looping the daemon.
