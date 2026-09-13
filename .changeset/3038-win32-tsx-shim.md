---
"@remnic/cli": patch
Stability: stable
---

Fixed the source-checkout CLI wrapper on Windows: `bin/remnic.cjs` (and the legacy `engram` wrapper) now launch the installed `tsx` JavaScript CLI with Node instead of the `node_modules/.bin` shim. Windows `.cmd` shims cannot be `execFile`'d, so the old fallback spawned a bash script and died. POSIX and Windows now share the same no-shell path. Closes #3038.
