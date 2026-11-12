---
"@remnic/core": patch
---

Journal extraction now commits each new fact inside the same fact-dedup window that extraction and explicit capture use, and rechecks the fact index there. Before, an extraction run could commit the same new fact between the journal pass's check and its write, and the corpus then held both copies. A fact that lost the race is skipped and counted as skipped.

Stability: stable
