---
"@remnic/cli": patch
"@remnic/import-chatgpt": patch
---

`remnic import chatgpt --file <export>.zip` now reads the raw ChatGPT data-export ZIP. You no longer unzip it by hand. The CLI picks `memory.json`, `memories.json`, `user.json` and `conversations.json` from any folder in the archive and passes them to the ChatGPT parser as one bundle. Stored and deflated entries are read and CRC-checked; ZIP64 and encrypted archives are refused with a named error. Other importers and `.tgz` files still ask you to unpack first. Refs #3542.

Stability: stable
