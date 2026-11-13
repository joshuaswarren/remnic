# @remnic/capture-native-linux

Linux platform package for the Remnic native capture helper, `remnic-capture-helper`.
It records desktop audio on PipeWire for `@remnic/capture-audio`. It speaks the same
command line and the same JSONL output as the macOS helper, so the audio daemon needs no
Linux-specific code beyond resolving this package.

Install with `npm install @remnic/capture-native-linux`. `@remnic/capture-audio` finds it on
Linux with no `REMNIC_CAPTURE_HELPER_BIN` setting.

## Requirements

- Node 22.12 or newer.
- PipeWire with `pw-record` and `pw-dump` on the `PATH` (package `pipewire`, or `pipewire-bin` on Debian).

The helper is plain JavaScript with no dependencies, so one package serves every CPU architecture.

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

Screen subcommands (`ax-snapshot`, `ocr-window`) are not part of this package yet.

## Tests

`npm test` runs against fake `pw-record` and `pw-dump` programs, so it needs no sound hardware.
