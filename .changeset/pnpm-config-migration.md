---
"@remnic/core": patch
---

Migrate `onlyBuiltDependencies` and the esbuild `overrides` pin from the root package.json `pnpm` field to `pnpm-workspace.yaml`. pnpm 10.32.1 no longer reads the `pnpm` field in package.json, so those settings were being silently ignored and pnpm emitted a `[WARN] The "pnpm" field in package.json is no longer read` line that broke `npm run preflight:quick`. The settings now live as top-level keys in `pnpm-workspace.yaml` per https://pnpm.io/settings, and the dead `pnpm` field has been removed.
