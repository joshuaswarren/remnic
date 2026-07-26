---
"@remnic/core": patch
"@remnic/plugin-openclaw": patch
---

Move inline explicit-capture processing into core so embedded OpenClaw uses the same strict validation, sealed persistence, review fallback, provider provenance, and bounded replay dedupe seam that daemon observe will use. Unsupported inline namespaces queue under the server-resolved session namespace rather than selecting their own review scope.
