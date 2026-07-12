---
"@remnic/core": patch
"@remnic/server": patch
---

fix(storage): surface present-but-unopenable memory projection (#1829)

A better-sqlite3 addon built for the wrong Node ABI throws on load; the
readonly projection open caught it and returned the SAME null a missing file
returns, so every memory list silently fell back to a 190K-file full-corpus
scan. Split the open path: a missing index stays a quiet fallback, but a file
that exists yet cannot open now logs its real (path-free, rate-limited) error
via `log` and is exposed by `remnic doctor` as a `memory_projection` check
(absent/openable = ok, unopenable = error with rebuild guidance). The doctor
probe now also validates the projection schema after opening: a file that
opens but has its tables missing or is corrupt reports a distinct
`present-but-invalid` state (doctor error with rebuild hint) instead of ok.
Added a startup driver-load probe (`probeBetterSqlite3Driver`) in the server
that logs loudly when the native binding fails to load under the running
process without crashing. The full-scan fallback is preserved unchanged.
