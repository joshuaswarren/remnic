---
"@remnic/plugin-openclaw": patch
"@joshuaswarren/openclaw-engram": patch
---

Stability: beta

Shorten ten wordy descriptions in the OpenClaw plugin manifest so it has room under the 250,000-byte pack limit again (it was 100 bytes from the limit, so any new config key failed the pinned-OpenClaw build). Behavior, defaults and key names are unchanged.
