---
"@remnic/cli": patch
Stability: stable
---

Fixed the source-checkout CLI wrapper on Windows: `bin/remnic.cjs` (and the legacy `engram` wrapper) now resolve `tsx.cmd` instead of the extension-less bash shim in `node_modules/.bin`, so `remnic` from an unbuilt checkout launches instead of dying with a spawn error. POSIX still uses the extension-less shim. Closes #3038.
