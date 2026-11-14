---
"@remnic/capture-native-linux": minor
"@remnic/capture-audio": patch
---

Add `@remnic/capture-native-linux`, a Linux desktop audio capture helper over PipeWire. It has the same `audio-capture` and `device-enumerate` contract as the macOS helper. `@remnic/capture-audio` now resolves it on Linux. The helper only runs when the user turns capture on, so a fresh install records nothing.

Stability: stable
