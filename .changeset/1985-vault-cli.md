---
"@remnic/cli": minor
"@remnic/core": patch
---

Add `remnic vault-publish apply --file --name --content` to replace a marked vault region. Missing markers exit 1 with `no_marker`. Missing files are not created. Part of #1985.
