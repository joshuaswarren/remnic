---
"@remnic/cli": patch
Stability: stable
---

`remnic import <adapter> --file export.zip` now extracts the archive to a temp
dir and imports the detected export files (memory.json, conversations.json,
…) through the bundle-detection path — no manual unzip step (issue #3542).
