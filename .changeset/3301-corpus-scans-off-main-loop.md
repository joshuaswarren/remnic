---
"@remnic/core": patch
Stability: stable
---

Run the daemon's periodic corpus maintenance scans (recall-corpus path walk, entity-entry fingerprint, corpus watermark freshness stat) in a worker thread instead of on the main event loop, and drop the per-entry `realpath` the walk performed on every markdown file. Main-thread time per corpus walk drops from seconds to milliseconds on a 134k-file corpus, so observe, recall and the extraction queue stop starving behind the scans. Results are unchanged: the worker and the inline walk produce identical path lists, fingerprints and stat sweeps.
