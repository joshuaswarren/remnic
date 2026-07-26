---
"@remnic/core": patch
---

Surface the already-persisted `sourceConnector` on recalled memories so an agent can tell a recalled rule originated from a different integration (issue #2183). Recalled memory lines append an `[agent: <connector>]` suffix (e.g. a Pi `search` tool-rule surfacing inside OpenClaw is labeled `[agent: pi]`).

The connector is captured by the recall rerank stage from the same frontmatter it already loads — no new per-result file read — on EVERY recall branch (the default memory-worth path and TrustScore, hot QMD / embedding / cold archive / recent scan), and threaded to the shared `formatQmdResults` renderer parallel to the existing `trustByPath` epistemic-hedge map. The map is keyed by namespace-composite identity so two same-path memories in different namespaces cannot bleed a connector across namespaces.

The label is an additive, lossless annotation (it hides nothing), so it renders whenever a connector is known — no config gate. The connector is validated against a strict allow-list before rendering (it reaches model-visible context), so a malformed `sourceConnector` (newline, instruction text) is skipped rather than injected.
