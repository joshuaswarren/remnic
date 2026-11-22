---
"@remnic/core": patch
Stability: stable
---

Marketplace `git` sources now resolve `marketplace.json` by shallow-cloning the remote, so SSH, GitLab, self-hosted, `file://`, and local-path sources work; previously only GitHub-HTTPS-shaped inputs resolved via raw-URL delegation. Flag-shaped sources are rejected before clone. Refs #3611.
