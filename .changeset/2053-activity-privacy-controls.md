---
"@remnic/cli": patch
---

Extend `remnic activity-privacy` with three actions. `delete` reads
{"scope","relPath","capturedAtMs"} JSON lines on stdin and prints the
retention deletion plan; the master `--enabled false` gate refuses
outright and non-activity-owned paths are always refused, never deleted.
`redact` drops listed keys from one JSON object on stdin. `gates`
resolves the five activity feature gates under the master switch, so a
master opt-out is visible as every gate forced off. Dry-run only; no
files are removed. Part of #2053.
