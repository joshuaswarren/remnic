---
name: remnic-ratchet-baseline-only-decreases
description: "scripts/ratchet-baseline.json counters may only decrease; raising one hides new structural debt"
condition:
  - '\d'
globs:
  - "**/scripts/ratchet-baseline.json"
interruptMode: never
---

Advisory: you are editing `scripts/ratchet-baseline.json`. These
counters are debt ceilings enforced by `check-ratchets.mjs` and they may
only stay equal or DECREASE. Raising a number to make CI pass defeats
the ratchet and lets structural debt grow silently — reviewers rejected
exactly this in PRs #1593, #1603, #1605, #1623, #1705, #1803, #1815.

Before committing this edit, verify:

1. Every changed number is lower than (or equal to) the previous value.
2. If a number must go UP, that is a reviewed exception: state the
   justification in the PR description and get explicit approval —
   never bundle a silent ratchet raise into an unrelated change.
3. The values match reality at your HEAD (run the ratchet check
   locally); a stale baseline fails CI in both directions.
