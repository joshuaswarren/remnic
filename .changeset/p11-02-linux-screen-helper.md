---
"@remnic/capture-native-linux": minor
"@remnic/capture-screen": minor
---

`@remnic/capture-native-linux` now has `ax-snapshot` (AT-SPI over Hyprland) and `ocr-window` (`grim` piped to `tesseract`, nothing written to disk), so `@remnic/capture-screen` runs on a Wayland desktop. `ax-snapshot` gains `--window-only` (window facts, no tree) and `--window ID`. `@remnic/capture-screen` now asks the helper for the window facts first, applies the deny list to them, and reads the tree or the pixels only of a window that passes; the scheduler no longer reads the tree on every poll. A helper that exits with status 2 on `--window-only` (the macOS helper) keeps the old order.

Stability: stable
