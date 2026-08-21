---
"@remnic/core": patch
---

Address the two second-round reviewer findings on the wearable cross-source fusion foundation (PR #1849 / issue #1810):

1. `reconstruct`: only roll an earlier heading end clock into the next calendar day when the implied wrap duration (start -> midnight -> end) is within a plausible single-conversation bound (12h). A near-24h implied span (e.g. 14:00 -> 13:00) is almost certainly a malformed/ordinary earlier clock rather than a midnight crossing, so it stays on the same date with endIso < startIso and the existing cluster clamp collapses it to the start instead of spanning the day and broadly clustering unrelated neighbors. Valid cross-midnight wraps (short or long-but-plausible) still roll forward.

2. Escaped segment text is an internal serialization detail. A shared decode primitive (`unescapeSegmentText`) and `decodeTranscriptBody` now live in `day-store` and are used by the fusion reconstruct path AND every user-facing view/search/index surface (`dayTranscript`, `searchTranscripts` scan + indexed snippet), so escaped newlines/backslashes never leak into transcript display or search. The fusion reader still decodes each segment exactly once during parse and legacy transcripts keep round-tripping their original text.
