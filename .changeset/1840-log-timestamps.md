---
"@remnic/core": patch
---

Prefix log lines with an ISO 8601 timestamp by default so daemon log events can be correlated with external facts (client disconnects, deploys, proxy changes) during incident triage. Opt out with `REMNIC_LOG_TIMESTAMPS=false` (also accepts `0`/`no`/`off`) or `initLogger(backend, debug, { timestamps: false })`; unrecognized env values fall through to the default (on). Closes #1840.
