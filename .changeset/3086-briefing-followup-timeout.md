---
"@remnic/core": patch
---

Cap briefing LLM follow-up generation at 8s so a stalled local judge/gateway cannot block `remnic_briefing` past the MCP caller timeout (issue #3086). The briefing still returns windowed recall.

Stability: stable
