---
"@remnic/capture-native-linux": patch
---

Check every audio output path component before recording. Refuse symlinks, including suffixed forms, and parents that let other users replace the private output directory.

Stability: stable
