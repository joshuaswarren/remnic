---
"@remnic/cli": patch
"@remnic/hermes-provider": patch
---

Give fetch-based daemon clients one deadline covering connect, headers and body (issue #3534). `daemonFetch` now buffers the response body while its abort timer is still armed and hands callers a fully-read response, and the hermes-provider `request()` keeps its timer armed through `response.json()`/`parseErrorResponse` instead of clearing it at headers. A daemon front that sends headers and then stalls or trickles the body can no longer hold either call open-ended.

Stability: stable
