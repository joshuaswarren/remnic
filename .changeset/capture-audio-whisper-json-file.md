---
"@remnic/capture-audio": patch
---

Read the whisper-cli transcript from a private temporary file instead of stdout. whisper-cli opens `/dev/stdout` for `--output-file -`, which fails on the socket Node gives a child process, so every chunk failed with `whisper-cli returned malformed JSON` and no transcript was stored.

Stability: stable
