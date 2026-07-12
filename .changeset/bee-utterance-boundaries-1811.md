---
"@remnic/core": patch
"@remnic/connector-bee": patch
---

fix(wearables): preserve Bee utterance boundaries and carry end timestamps (#1811)

Bee conversation utterances now map `start`/`end` to `WearableTranscriptSegment`
timing (falling back to `spoken_at` for the start), and a new opt-in cleanup
toggle `preserveUtteranceBoundaries` stops `mergeSameSpeaker` from collapsing
segments whose speaker label is generic/low-confidence (e.g. "Unknown", empty).
The Bee source defaults to boundary preservation, so a conversation of many
`Unknown`-labeled utterances stays as many segments instead of one mega-segment;
other connectors keep their existing merge behavior unless explicitly configured.
