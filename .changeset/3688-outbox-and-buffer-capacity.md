---
"@remnic/core": patch
"@remnic/plugin-pi": patch
Stability: stable
---

The two capacity bounds that protect lane turns during an extraction outage are now raised or configurable. The daemon's per-session retained-turn cap default rises 200 -> 2000 (the knob `bufferMaxTurnsPerSession` already existed; its default refused live captures within hours of a wedge, 270,885 captures in the observed outage). The client's durable observe outbox bound becomes the `observeOutboxMaxEntries` config knob, default 5000. It is the in-memory hot-file spill threshold: entries beyond it spill to disk segments, so raising it delays that spill rather than increasing total retention; nothing is evicted while the daemon is down or slow.
