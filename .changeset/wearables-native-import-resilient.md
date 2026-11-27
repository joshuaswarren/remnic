---
"@remnic/core": patch
---

Wearable sync no longer aborts when the native-memory import fails. A provider rejection at that stage (expired scope grant, API outage) is now recorded as a sync warning and the run completes, so day transcripts stay stored and the sync watermark keeps advancing; the import retries on the next sync. Previously the unhandled error aborted the whole run before the watermark was saved, freezing the source at its last fully clean sync even though newer transcripts were already on disk. Closes #3694.
