---
"@remnic/capture-native-linux": minor
"@remnic/capture-screen": minor
---

`@remnic/capture-native-linux` adds automatic AT-SPI screen capture over Hyprland. `ax-snapshot` supports window facts without a tree, window IDs, title checks and node limits. The screen daemon applies its deny list before requesting window text. Linux `ocr-window` now refuses composited-screen acquisition: asynchronous events cannot establish frame-bound ownership of a crop. Windows without accessible text are skipped with `ocr-unavailable`; no screenshot or OCR tool runs. The macOS helper keeps its existing capture behavior.

Bound the URL search apart from the text node limit. Skip hidden frames and password fields before the URL search.
Reject AT-SPI targets on hidden or unknown workspaces. Linux live capture stops with `url-policy-unavailable` when URL deny rules exist.
Separate URL and text requests cannot prove a page stayed allowed. Without URL rules, the helper still reads AT-SPI text on its own.

Stability: stable
