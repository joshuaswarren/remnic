---
"@remnic/core": patch
"@remnic/cli": patch
---

Persist parsed memory identities between reconciliation runs so warm `converge plan`/`watch` cycles skip the per-file read and frontmatter parse that dominated boot-scale manifest builds. The cache is keyed by content sha plus normalizer, identity-resolution, and citation-template versions, so a stale entry can only cost a cold re-parse; entries that parse without an identity persist too, so negative results are not re-read either. The support-passport exclusion classification is persisted alongside (keyed by stat identity), because that callback otherwise reads and parses every candidate file before the cache can help. Cache writes are serialized per path and merged with the current on-disk set, so overlapping streams cannot clobber each other, and unchanged runs skip the rewrite entirely. The cache lives under `.remnic/`, which snapshot enumeration excludes structurally, so convergence never transfers the cache itself.
