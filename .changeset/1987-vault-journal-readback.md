---
"@remnic/core": minor
"@remnic/cli": minor
"@remnic/plugin-openclaw": minor
---

Vault daily-note journal read-back (#1987). `activity.timeline.journal.source: "vault"` reads the journal for a day from the `activity.timeline.vault.readback.journalSection` heading of the vault daily note instead of `journal/<date>.md`; `timeline.journal.extractionMode: "review"` adds a review-only extraction pass (library surface in `@remnic/core`; maintenance wiring follows). Read-back is strictly read-only, strips every Remnic-owned region before treating text as journal content (loop prevention, fail-closed on split/unclosed marker regions), and records `journalSource` provenance on every candidate. **Breaking config rename:** the previously inert `timeline.journal.source: "file"` value and `timeline.journal.heading` key are rejected — use `"memoryDir"` and `vault.readback.journalSection`; the vault-mode prerequisite error names the replacement. The plugin-openclaw entry covers the manifest-only `configSchema` updates (journal source/extractionMode enums, `vault.readback` block) mirrored into the shim and root manifests, which otherwise ride along unreleased until the next plugin bump.
