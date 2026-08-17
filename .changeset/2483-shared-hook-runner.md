---
"@remnic/plugin-claude-code": patch
"@remnic/plugin-codex": patch
---

Extract one shared hook runner used by both the Claude Code and Codex host plugins (issue #2483). Each package now ships the byte-identical `hooks/bin/remnic-hook-core.cjs` (canonical source: `scripts/hook-runner/remnic-hook-core.cjs`, kept in sync by `npm run sync:hook-runner` and enforced in CI) plus a thin wrapper that sets the client id, token connector priority, log names, and Codex-only events. The Claude Code hook inherits `REMNIC_DAEMON_URL`/`ENGRAM_DAEMON_URL` routing (including `https://` remotes, reverse-proxy path prefixes, and the explicit-but-invalid URL fail-open behavior) that the Codex runner already had, so a Claude Code host can reach a remote/central daemon.
