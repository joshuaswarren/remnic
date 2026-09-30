---
"@remnic/core": patch
"@remnic/cli": patch
"@remnic/hermes-provider": patch
---

Add storageCorpusVersionsAtRecallStart to recall responses. It lists every searched namespace and, when standalone memory context is read, the default storage namespace too. Each value is the storage corpus sentinel captured before its read; it does not prove that QMD has applied the write (issue #3154).

Stability: stable
