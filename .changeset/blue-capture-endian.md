---
"@remnic/capture-audio": patch
"@remnic/capture-native-linux": patch
---

Reject fractional chunk durations before starting the audio helper, and write Linux 16-bit PCM WAV data in little-endian byte order on big-endian hosts.

Stability: stable
