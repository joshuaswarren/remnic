---
"@remnic/core": patch
---

Ignore macOS AppleDouble (`._*`) and `.DS_Store` files during entity startup, memory scans, and offline sync so Finder metadata from Mac-to-Linux copies cannot crash the daemon or replicate.

Stability: stable
