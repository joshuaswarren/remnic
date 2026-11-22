---
"@remnic/core": patch
Stability: stable
---

Stability: stable

Recognize `inlineSourceAttributionFormatHistory` in extraction persist and
storage canonicalization (#3567). Facts cited under a previously configured
template are detected and stripped for dedup/hash even after the current
format reverts to the default, instead of being double-cited.
