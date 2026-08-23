---
"@remnic/core": patch
"@remnic/cli": patch
---

Persist parsed memory identities between reconciliation runs so warm `converge plan`/`watch` cycles skip the per-file read and frontmatter parse that dominated boot-scale manifest builds. The cache is keyed by content sha plus normalizer, identity-resolution, and citation-template versions, so a stale entry can only cost a cold re-parse. It is stored under `.remnic/`, which snapshot enumeration excludes structurally, so convergence never transfers the cache itself.
