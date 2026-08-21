---
"@remnic/core": patch
---

Surface the already-persisted `sourceConnector` on recalled memories so an agent can tell a recalled rule originated from a different integration (issue #2183). Recalled memory lines append an `[agent: <connector>]` suffix (e.g. a Pi `search` tool-rule surfacing inside OpenClaw is labeled `[agent: pi]`).

The connector rides on the `QmdSearchResult` object itself — hydrated at the single point a result meets its loaded memory (`filterSearchResultsByRecallSafety`), so it flows through every recall branch (hot QMD, embedding fallback, cold archive, and any future path that obtains the memory) and the shared `formatQmdResults` renderer reads it directly. There is no per-branch side-channel map to forget to populate.

The label is an additive, lossless annotation (it hides nothing), so it renders whenever a connector is known — no config gate, no kill switch. The value reaches model-visible context, so it is validated against the canonical persisted-ID charset and TRUNCATED (with an explicit marker, so attribution survives) past a shared display bound; a malformed value (newline, instruction text) is rejected, never injected.
