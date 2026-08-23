---
"@remnic/core": patch
---

Diagnose and bound the briefing legacy full-read fallback (issue #2779). Every briefing memory read now logs one discriminator line — `mode=windowed|full-read-fallback durationMs=N count=M` — so a slow windowed scan, a storage adapter without `readMemoriesWindow()` support, and a daemon running pre-window code are distinguishable from the daemon log alone. The legacy full-read fallback (storage doubles predating windowed reads) is now raced against a 30s budget and fails open with an empty read instead of blocking past the 60s MCP client timeout on large corpora. Real StorageManager paths already use windowed reads; no production adapter hits the fallback.
