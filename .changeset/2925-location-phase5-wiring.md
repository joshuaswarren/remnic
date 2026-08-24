---
"@remnic/core": patch
"@remnic/cli": patch
---

Wire the location subsystem into wearables, day summaries, and briefings (issue #2925, phase 5 of #2043). Wearable conversations whose provider supplied no location get the matched dominant-overlap place label — missing-only, never overwriting source values, and only when `location.enabled` and `location.tagging.enabled` are both on. Day summaries (`day_summary` with `includeLocation: true`) and briefings (`briefing` with `includeLocation: true`, CLI `--include-location`) append a labels-only `## Location context` section behind the same gates; without the request flag every output is byte-identical to a no-location build. Coordinates and raw location records never reach any of these outputs.
