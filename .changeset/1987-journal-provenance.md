---
"@remnic/core": patch
---

Add the exported `buildJournalMemoryProvenance` helper for journal-derived memories: given a journal source validated through the journal-source parser (`"file"` or `"vault"`) and a `YYYY-MM-DD` calendar day, it returns the exact tags `["journal", "journal-day:<date>"]`, `structuredAttributes.journalSource` set to the source (string values only, so vault-sourced journal candidates are distinguishable from file-sourced ones), and `validAt` pinned to the day start in UTC (`<date>T00:00:00.000Z`). Pure: no I/O, no clock. Caller wiring into journal memory generation is a later slice. Part of #1987
