---
"@remnic/core": minor
---

Session-end experience memories now inject through the existing procedure-recall slot after promotion (issue #2979 layer 2). They share `recallMaxProcedures`, stay out of injection while `pending_review`, and render as an `Experience.` preview when `sessionExperience.enabled` is on. Gate off still performs zero storage calls on session end and does not inspect experience attributes at recall.
