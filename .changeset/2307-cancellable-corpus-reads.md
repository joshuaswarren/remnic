---
"@remnic/core": patch
---

Thread cancellation into the shared full-corpus read primitives. `readAllMemories`, `readAllEntityFiles`, `readAllArtifactsCached`, and the artifact source-status snapshot now accept an optional `abortSignal` and stop at their directory, batch, and attempt boundaries, so an abandoned or timed-out recall no longer leaves a whole-tree scan running. A cancelled read never publishes a partial corpus to any cache, and a coalesced `readAllMemories` scan is protected once a second reader joins it (issue #2307).
