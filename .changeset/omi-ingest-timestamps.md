---
"@remnic/connector-omi": patch
---

Stability: stable

Keep Omi conversation text ingestible when segment offsets are out of range, without inventing timestamps or discarding the rest of a page. Accept the Developer API's nullable conversation timestamps and transcript arrays, and omit null end times from normalized conversations.
