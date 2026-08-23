# Timeline

The narrative timeline turns recorded activity into day-shaped artifacts: day journals, timeline cards, and (through the markdown-vault publisher) published sections in your own notes.

## Journal sources

`activity.timeline.journal.source` decides where a day's journal text lives:

- `"memoryDir"` (default) — `journal/<YYYY-MM-DD>.md` under the memory directory (#1984 behavior). `remnic journal seed` scaffolds the day file from cards; once written, Remnic never rewrites it.
- `"vault"` — the user's vault daily note IS the journal (#1987). Remnic reads exactly one named section of exactly the daily note, resolved through the same path template the vault publisher uses (`activity.timeline.vault.dailyNotePath`). The section heading is `activity.timeline.vault.readback.journalSection` — arbitrary user-chosen text, matched exactly.

Setting `source: "vault"` requires `activity.timeline.vault.enabled: true` and a resolvable `dailyNotePath` and a non-empty `readback.journalSection`; config load fails naming every missing prerequisite at once.

### Vault read-back is read-only

Remnic never writes to the journal section — including `remnic journal seed`, which refuses with an explanation in vault mode. The vault note template owns scaffolding. `remnic journal show` prints the section with a provenance header naming the note file; `remnic journal edit-path` prints the note path. The #1985 publisher continues to own only its managed regions in the same file; publisher and read-back coexist byte-safely.

### Loop prevention

Before any vault journal text is treated as user content, every Remnic-owned region is stripped: all `<!-- remnic:*:start/end -->` marker pairs and (under the heading strategy) every configured publisher-owned heading section. A start marker with no end strips to the end of the section and records a warning; an end marker with no start (a pair split across the section boundary) strips everything before it in the section. Remnic must never re-ingest its own published output as journal text — the timeline → journal → extraction → memory → timeline loop is silent pollution otherwise. The strip is pure and property-tested.

Text nested under the journal heading by other tools or agents is NOT stripped — only Remnic-owned regions are. If another agent writes under your journal heading, that text counts as journal input; the fix is vault organization, not Remnic heuristics.

### Trust boundary

Vault notes are the user's most sensitive corpus: synced from many devices, editable by other tools and agents. Text only enters the memory pipeline when BOTH `activity.timeline.journal.source: "vault"` (explicit redirection) AND `activity.timeline.journal.extractionMode: "review"` (explicit extraction, review-only) are set. There is no auto mode by design.

With `"review"` set, `remnic journal extract --date <day>` runs the pass:

- Candidates land `pending_review` only — a journal-derived memory never reaches `active` without explicit review approval. A judge reject drops the candidate even in review mode.
- Provenance rides every candidate: tags `journal` and `journal-day:<date>`, `valid_at` pinned to the day, and `structuredAttributes.journalSource` (`"vault"` or `"memoryDir"`) so review UI and audits can tell sources apart.
- Standard sanitization applies before extraction; unsafe text extracts nothing.
- Change detection: a per-day content hash of the post-strip section text is stored in `<memoryDir>/state/timeline.json`. An unchanged day is never re-extracted; a day edited weeks later re-extracts exactly once per content change.
- After any candidate write, the search index is refreshed so the new candidates are discoverable.

Vault journal text is never used as a timeline observation source: the timeline's own published output lives in the same note, and journal reflections about the timeline would feed back into card generation.
