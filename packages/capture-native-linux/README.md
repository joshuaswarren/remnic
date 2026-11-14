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
- Screen: a Hyprland session (`hyprctl`), `grim` and `tesseract` with the `eng` language data, and for the
  accessibility tree `python3` with the `gi` bindings and `at-spi2-core` (`python-gobject` on Arch).

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
remnic-capture-helper ax-snapshot [--frontmost | --pid N | --window ID] [--window-only] [--max-nodes N]
remnic-capture-helper ocr-window [--frontmost | --window ID]
```

`ax-snapshot` prints `{app, windowTitle, windowId, browserUrl?, tree}` for the focused window, the window of a
process, or the window `--window` names (`windowId` is the Hyprland address). `tree` comes from the
accessibility bus (AT-SPI). A password field keeps only its role, so no text of it or of anything under it
leaves the helper. `--window-only` prints `{app, windowTitle, windowId, browserUrl?}` and reads no node name or
text; a caller applies its deny list to that before it asks for the tree. An app that is not on the
accessibility bus gives its window and a one-node tree, and the reason goes to stderr.

`ocr-window` prints `{"text": "..."}`. The helper takes the window's rectangle from the screen with `grim` and
pipes it to `tesseract`, so no image is written to disk. An unknown window exits 1.

Limits you can measure on your own machine:

- The accessibility bus is off by default (`org.a11y.Status IsEnabled` is false) and toolkits expose nothing
  until it is on. This helper does not change that desktop-wide setting. Turn it on with
  `busctl --user set-property org.a11y.Bus /org/a11y/bus org.a11y.Status IsEnabled b true`. Without it the
  tree is the window title, the capture daemon falls back to OCR, and OCR needs no setting.
- Chromium needs `--force-renderer-accessibility`; Qt needs `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1` and
  exposes the text of a QML field only when the app sets `Accessible`. Terminals such as foot are not on the bus,
  so they go through OCR.
- `grim` crops the composited screen. A window that another window overlaps, or that is not on a visible
  workspace, is refused, so the helper never reads someone else's pixels. A desktop notification drawn over the
  window is not a window the helper can see: its text can appear in the OCR text.

## Tests

`npm test` runs against fake `pw-record`, `pw-dump`, `hyprctl`, `python3`, `grim` and `tesseract` programs, so it needs no sound hardware and no desktop session. The Python reader and the real tools are checked by hand on a desktop; the pull request that added them lists the run.
