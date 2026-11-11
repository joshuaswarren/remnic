---
"@remnic/core": patch
Stability: stable
---

Each record on `GET /engram/v1/recall/timings` now ties to its request and shows where a slow recall spent its time. `requestId` is the server-generated id returned as `x-request-id` (a client-supplied id is never used), `outcome` is `ok`, `error` or `aborted`, and `httpTotalMs` is the monotonic total for the attempt; exactly one record is written per executed recall, including denials and client disconnects. Seven phase-2 awaits (harmonic retrieval, graph snapshot, intent snapshot, compression guidelines, compounding, questions, query-aware prefilter) add `phase2<Name>Ms` and `phase2<Name>Status` (`ok`, `timeout`, `error` or `skipped`); the three awaits on promises started earlier also add `phase2<Name>TotalMs`. Await times overlap and are not additive. The fields are numeric or enum values only, and the recall response body and its deadlines are unchanged. Refs #1830.
