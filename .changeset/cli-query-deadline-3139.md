---
"@remnic/cli": patch
---

Bound `remnic query` end to end with the same 30 second deadline the briefing command uses, so a stalled startup fails fast with a readable timeout error instead of hanging until the client gives up. Under `--json` the timeout is reported as a JSON error line on stderr and the exit code stays non-zero. Part of #3139.

Stability: stable
