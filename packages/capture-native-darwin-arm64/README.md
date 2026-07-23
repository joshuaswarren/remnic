# @remnic/capture-native-darwin-arm64

macOS Apple Silicon (arm64) platform package for the unified Remnic native
capture helper, `remnic-capture-helper`. One binary serves both the audio
capture pipeline (#1897) and the screen-activity pipeline (#1899).

## What this package provides

- `helperBinaryPath` — an absolute path to the packaged `bin/remnic-capture-helper`
  binary, resolved relative to the installed package:

  ```js
  import { helperBinaryPath } from "@remnic/capture-native-darwin-arm64";
  ```

## The binary is built by CI, not committed

`bin/remnic-capture-helper` is a compiled macOS Mach-O executable produced by
the `capture-native-helper` GitHub Actions workflow on a real macOS arm64
runner (`swift build -c release` against `packages/capture-native-darwin-helper`).
It is **not** committed to the repository and is **not** buildable on Linux.

Until CI stages the binary into `bin/`, `helperBinaryPath` still resolves to the
path it *will* occupy; the package `test` script tolerates its absence and skips
the executable check with a note.

## Subcommands

```
remnic-capture-helper audio-capture --channel mic|system|both --chunk-seconds N --out <dir> [--device <id>]
remnic-capture-helper device-enumerate
remnic-capture-helper ax-snapshot [--frontmost | --pid <n>] [--max-nodes N]
remnic-capture-helper ocr-window [--frontmost | --window <id>]
```
