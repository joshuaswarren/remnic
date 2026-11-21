---
"@remnic/cli": patch
"@remnic/hermes-provider": patch
---

Keep the fetch deadline armed until the response body is read. The Hermes provider's requests and the CLI's remote-daemon reads (health, status, recall, xray) now time out when a daemon sends headers and then stalls the body, instead of waiting with no bound (#3534).

Stability: stable
