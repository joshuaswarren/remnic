---
"@remnic/core": patch
---

Add `checkVaultJournalPrerequisites`: given the caller-resolved config
values, reports EVERY unmet vault journal read-back prerequisite
(`vault.enabled`, `vault.dailyNotePath`, `vault.readback.journalSection`)
in one single-line message, instead of failing on the first one hit.
`vault.enabled` counts as satisfied only for boolean `true`; path and
section only for non-blank strings. Internal helper exported from the
activity surface — not yet wired into config parsing; that wiring is a
later slice of #1987.
Part of #1987.
