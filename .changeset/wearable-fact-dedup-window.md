---
"@remnic/core": patch
---

Wearable fact writes (extracted facts and provider-native imports) now commit inside the same fact-dedup window that extraction and explicit capture use, and recheck the fact index there. Before, an extraction run could commit the same new fact between the wearable sync's check and its write, and the corpus then held both copies. A fact that lost the race is counted as skipped and is not reported as created or imported.

Stability: stable
