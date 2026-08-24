---
"@remnic/core": minor
---

Wire `runTimelineCardAnalysis` into the production timeline regenerate path behind `activity.timeline.analysis.enabled`. Sync and CLI surfaces share one flow: deterministic cards persist on analysis failure, unchanged evidence does not re-run the provider, local analysis honors `analysis.model`, and provider/model metadata is rejected at parse/manifest time if it would fail the 120-character runtime record.
