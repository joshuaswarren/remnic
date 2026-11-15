---
"@remnic/core": patch
---

Stop drain-claim inboxes growing by the whole buffer on every save, and stop listings parsing large inboxes. A live buffer owner now hands a claimed session over as only the turns that grew since its last hand-in (falling back to the whole entry whenever the inbox changed behind its back), and a claim listing no longer reads an inbox over 1 MiB while the claim body still has pending turns. This removes the regular 1 s event-loop stalls seen in the daemon (COS-666i). Existing oversized inboxes are not touched.

Stability: stable
