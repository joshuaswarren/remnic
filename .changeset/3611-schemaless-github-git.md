---
"@remnic/core": patch
Stability: stable
---

Marketplace `git` sources again accept scheme-less `github.com/owner/repo` and route it to the GitHub manifest resolver; the #3628 clone path treated that form as a local path and failed. Refs #3611.
