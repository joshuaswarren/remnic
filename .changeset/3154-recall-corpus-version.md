---
"@remnic/core": patch
"@remnic/cli": patch
---

Add storageCorpusVersionsAtRecallStart to recall responses. It lists each searched namespace with its storage corpus sentinel value captured before retrieval; it does not claim those writes are present in the downstream QMD index (issue #3154).

Stability: stable
