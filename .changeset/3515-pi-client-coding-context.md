---
"@remnic/plugin-pi": patch
"@remnic/core": patch
---

Stability: stable

plugin-pi: resolve the session's coding context on the pane host and POST it to `/engram/v1/coding-context`. Remote panes could never attach a coding context because the daemon ran `resolveGitContext` against its own filesystem, where a remote pane's cwd does not exist. The plugin now resolves locally at session start (chained behind the startup probe), re-posts when the resolved root or branch changes mid-session, re-posts again if a daemon outage may have wiped the binding, serializes syncs per session so the newest resolution always posts last, and leaves server-side cwd resolution as the same-host fallback. `@remnic/core` gains a `./coding/git-context` leaf export so the plugin imports the shared resolver without pulling the barrel. `setCodingContext` now binds set and clear to the caller's transport principal when namespaces are enabled, marks caller-supplied roots `remote` so daemon surfaces never open them as local paths (`codingContextLocalRoot` degrades them to the projectId, matching projectTag contexts), and accepts those markers only from the transport boundary, never the request body. Fixes #3515.
