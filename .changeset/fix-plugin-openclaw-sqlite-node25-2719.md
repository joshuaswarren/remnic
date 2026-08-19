---
"@remnic/plugin-openclaw": patch
---

Ship `ensure-better-sqlite3.mjs` in the plugin tarball and run it via `postinstall`, so a plugin-only install repairs the native binding when `better-sqlite3` has no prebuild for the running Node ABI (e.g. Node 25 / ABI 141). Both script copies now print an actionable recovery command (`npm rebuild better-sqlite3 --build-from-source`) with the running Node major and ABI when verification and rebuild fail.
