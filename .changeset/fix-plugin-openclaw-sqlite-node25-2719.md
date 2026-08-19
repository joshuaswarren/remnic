---
"@remnic/core": patch
---

Surface an actionable recovery hint when the better-sqlite3 native binding cannot load (issue #2719). `better-sqlite3` publishes prebuilds for LTS Node only, so a newer runtime leaves the package with no loadable binding and every SQLite-backed path failed with a bare "Could not locate the bindings file" at first use. `nativeBindingRecoveryHint` recognizes that failure (and NODE_MODULE_VERSION / ELF-header mismatches), then names the running Node major, the ABI, and the exact `npm rebuild better-sqlite3 --build-from-source` command; the LCM observe-enqueue error path appends it. The postinstall repair script also prints the same hint when a rebuild fails or the rebuilt binding still does not load. An unrelated error yields no hint, so existing messages read unchanged.
