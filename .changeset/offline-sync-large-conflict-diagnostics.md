---
"@remnic/core": patch
"@remnic/cli": patch
---

Fix offline sync stalls on large and volatile runtime-state files.

The CLI now avoids JSON hydration for oversized conflict copies, records
metadata-only conflicts when the incoming body is intentionally skipped, streams
large direct hydration through the existing chunk/staging writer, and defers
files that change mid-transfer so one volatile state file cannot abort the
whole cycle. Sync JSON output now reports compact counts instead of dumping the
full baseline, request timeouts cover response bodies, and successful local
pushes can checkpoint before a later pull timeout.

Offline local-delta scans now reuse the saved baseline for unchanged files,
hashing only candidate changes instead of re-reading the whole cache every
watch tick. The access HTTP server also logs unexpected 500s with method/path
context so future sync failures are diagnosable from daemon logs.
