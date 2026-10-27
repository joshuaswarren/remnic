---
"@remnic/core": patch
"@remnic/cli": patch
"@remnic/server": patch
"@remnic/plugin-pi": patch
"@remnic/plugin-claude-code": patch
"@remnic/plugin-codex": patch
---

Route every pure-liveness probe through the authenticated, readiness-gated `/engram/v1/live` endpoint — the server `--healthcheck` CLI, the connector daemon probe, remote CLI daemon status, the Claude Code and Codex hook recall/observe gates, and the Pi plugin startup probe. Slow diagnostic `/health` work no longer makes these probes falsely report a reachable daemon as unavailable and skip recall or observe. Daemons that predate the live route are still reachable: probes retry the legacy `/health` path only on 404, within the original single deadline; authentication and 503 `not_ready` answers are final and never re-probed. Detailed `/health` readers are unchanged (#3257).

Stability: stable
