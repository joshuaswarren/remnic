---
"@remnic/core": patch
---

Wire IRC preference consolidation into recall: CompoundingEngine.buildPreferenceSection consolidates preference/correction memories (plus causal-behavior augmentation when enabled) and the recall pipeline emits a "preferences" enrichment section gated by ircEnabled, with an LCM conversation-history fallback.

Stability: stable
