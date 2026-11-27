---
"@remnic/core": patch
---

Validate a capsule's taxonomy `schemaVersion` against the known registry (`CAPSULE_TAXONOMY_VERSIONS`, currently `taxonomy-v1`) instead of accepting any non-empty string. Import and export now refuse an unknown taxonomy version with an error naming the registry. Closes #3572.

Stability: stable
