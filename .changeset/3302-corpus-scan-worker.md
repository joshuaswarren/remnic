---
"@remnic/core": patch
Stability: stable
---

Run the corpus maintenance scans (recall-corpus path walk, entity-entry fingerprint, corpus watermark freshness stat) in a worker thread, and yield to the event loop while building the watermark census, so a corpus-sized scan no longer starves observe, recall and the extraction queue. The worker entry is plain JavaScript generated from its TypeScript source; the same implementation runs inline when no worker can start. Results are unchanged.
