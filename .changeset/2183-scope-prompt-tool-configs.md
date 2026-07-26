---
"@remnic/core": patch
---

Stop teaching the extraction scope-classification prompt that "tool configurations" are global knowledge. Tool, command, and CLI-flag instructions tied to a specific agent integration are now classified as "project", because the same tool name means different things in different agent integrations (a "search" tool may search repository code in one agent and the web in another); when a durable tool instruction is worth keeping, the fact text must name the originating agent. The extractor now also surfaces the resolved source connector at the top of the conversation so the model can qualify tool rules by agent, and the MemoryScope doc no longer lists tool configurations under global. Part of #2183.
