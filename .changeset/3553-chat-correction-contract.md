---
"@remnic/core": patch
---

Wire the chat executor's correction_plan/correction_apply tools to the Correction Contract (issue #1580 / PR #1664) instead of not-available stubs. Plans now go through CorrectionService with the caller's principal/namespace/sessionKey scope; the engine's "retrieve plan <id>" confirmation fast-path resolves the real pending plan via correctionListPending; apply runs with confirm: true since the engine only calls it after user confirmation.
Stability: stable
