---
"@remnic/capture-screen": patch
---

capture-screen: pin OCR to the ax-snapshot window id (#2141)

`captureFromSnapshot` now targets `ocr-window --window <id>` with the stable
window id returned by `ax-snapshot` instead of `--frontmost`, closing the
focus-change TOCTOU where OCR read a different window than the one the
captured app/windowTitle describe. `AxSnapshot` carries an optional
`windowId` (string; a numeric CGWindowID is coerced); helpers that do not
emit one keep the previous frontmost behavior, still guarded by the deny
preflight.
