---
"@remnic/core": patch
---

Stability: stable

Park unresolvable entity canonical-id mappings (both files gone, or a Type
that now normalizes to a different target) instead of throwing during
directory init, so the daemon can boot. Drop parks whose canonical file is
also gone rather than reviving them into an infinite rescan.
