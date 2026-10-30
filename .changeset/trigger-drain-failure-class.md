---
"@remnic/core": patch
"@remnic/plugin-openclaw": patch
"@joshuawarren/openclaw-engram": patch
---

Stability: stable

Trigger-drain chunk drops now follow what the extraction model did. A retained failure carries its failure class on the run result, and the drain no longer counts provider outages or auth failures toward dropping a chunk. The local extraction path separates a local model that answers with something unusable or an HTTP 400, 413 or 422 (the chunk's own problem, counted) from an unreachable, overloaded, misrouted or auth-failing endpoint (not counted). Adds the tests that tie a real run to the drain: the failure class on the run result and the retention window reaching the buffer.
