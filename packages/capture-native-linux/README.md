# @remnic/capture-native-linux

Linux platform package for the Remnic native capture helper, `remnic-capture-helper`.
It records desktop audio on PipeWire for `@remnic/capture-audio` and reads windows on Hyprland for
`@remnic/capture-screen`. It speaks the same command line and the same JSON output as the macOS
helper, so the two daemons need no Linux-specific code beyond resolving this package.

Install with `npm install @remnic/capture-native-linux`. `@remnic/capture-audio` and
`@remnic/capture-screen` find it on Linux with no `REMNIC_CAPTURE_HELPER_BIN` setting.

## Requirements

- Node 22.12 or newer.
- Audio: PipeWire with `pw-record` and `pw-dump` on the `PATH` (package `pipewire`, or `pipewire-bin` on Debian).
- Screen: a Hyprland session (`hyprctl`), `python3` with the `gi` bindings, and `at-spi2-core`
  (`python-gobject` on Arch). Linux screen capture uses AT-SPI; composited-screen OCR is unsupported.

The helper is plain JavaScript plus one Python file for the accessibility bus, with no npm dependencies, so one package serves every CPU architecture.

## Subcommands

```
remnic-capture-helper audio-capture --channel mic|system|both --chunk-seconds N --out <dir> [--device <id>]
remnic-capture-helper device-enumerate
```

`audio-capture` writes 16 kHz mono 16-bit WAV chunks (mode 0600, in a 0700 directory) named
`<channel>-<uuid>.wav`, and prints one JSON line per finished chunk on stdout:

```json
{"path":"/…/mic-….wav","channel":"mic","startedAtUtc":"…Z","endedAtUtc":"…Z","device":"alsa_input…"}
```

- `mic` records the default microphone, or the node named by `--device`.
- `system` records what the default sink plays (the sink's monitor). `--device` does not apply to it.
- `both` records the two as separate chunk streams. Each event is `mic` or `system`, never `both`.
- Chunks are cut by sample count from one continuous stream per channel, so they do not gap or overlap.
- On SIGTERM or SIGINT the helper stops the recorders, writes the last partial chunk (when it holds at
  least 0.1 s) and exits 0. If a recorder dies on its own, the helper exits 1 and says why on stderr.

`device-enumerate` prints `{"devices":[{"id","name","kind","isDefault"}]}` once. `kind` is `input` for
sources and `output` for sinks; `id` is the PipeWire node name, which `--device` accepts.

### Screen

```
remnic-capture-helper ax-snapshot [--frontmost | --pid N | --window ID] [--window-only] [--title T] [--max-nodes N]
remnic-capture-helper ocr-window [--frontmost | --window ID] [--title T]
```

`ax-snapshot` prints `{app, windowTitle, windowId, browserUrl?, tree}` for the focused window, the window of a
process, or the window `--window` names (`windowId` is the Hyprland address). `tree` comes from the
accessibility bus (AT-SPI). A password field keeps only its role: the AT-SPI reader never asks for its text,
name or description or for anything under it, so none of it reaches the helper's own process either.
`--window-only` prints `{app, windowTitle, windowId, browserUrl?}` and reads no node name or
text; a caller applies its deny list to that before it asks for the tree. `--title T` reads the tree only while
the window still has the title T the caller checked; a window retitled since gets its facts with the new title
and a one-node tree with no page URL, so the caller skips the window instead of reading it. An app that is not on the
accessibility bus gives its window and a one-node tree with no text, and the reason goes to stderr. The reader reads only the
frame whose name equals the window's title. A process whose frames do not match (a retitled window, two windows with one
title) gives the same empty tree, never another window's content.

`ocr-window` keeps the window visibility and title checks, then exits 1 with an unsupported-path error.
It never invokes `grim` or `tesseract`. A composited crop has no frame-bound window identity:
another window or a notification can appear inside the crop, even when both surrounding queries show the target.
Asynchronous window events cannot establish which surface owned those pixels. A pre-read title mismatch
returns empty text and the new title without acquisition, as before.

Limits you can measure on your own machine:

- The accessibility bus is off by default (`org.a11y.Status IsEnabled` is false) and toolkits expose nothing
  until it is on. This helper does not change that desktop-wide setting. Turn it on with
  `busctl --user set-property org.a11y.Bus /org/a11y/bus org.a11y.Status IsEnabled b true`.
  Without accessibility text, automatic capture skips the window with `ocr-unavailable`.
- Chromium needs `--force-renderer-accessibility`; Qt needs `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1` and
  exposes the text of a QML field only when the app sets `Accessible`.
  Windows without accessible text, including terminals such as foot, are not captured on Linux.

## Tests

`npm test` runs against fake `pw-record`, `pw-dump`, `hyprctl`, `python3`, `grim` and `tesseract` programs and a
fake Hyprland event socket, so it needs no sound hardware and no desktop session. The Python reader and the real tools are checked by hand on a desktop; the pull request that added them lists the run.
