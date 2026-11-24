---
"@remnic/core": patch
"@remnic/cli": patch
Stability: alpha
---

Install docs now pin `@remnic/*` dist tags to `alpha` in every documented install command, `pnpm add` commands are pinned as well, the runtime hints a user sees when an optional package is missing name `@alpha`, and the install-tag agreement gate scans `pnpm add` alongside `npm install`/`npm i` so documented installs cannot drift back to bare specs.
