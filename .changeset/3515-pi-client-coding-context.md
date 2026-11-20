---
"@remnic/plugin-pi": patch
---

plugin-pi: resolve the session's coding context on the pane host and POST it to `/engram/v1/coding-context`. Remote panes could never attach a coding context because the daemon ran `resolveGitContext` against its own filesystem, where a remote pane's cwd does not exist. The plugin now resolves locally at session start (chained behind the startup probe), re-posts when the resolved root or branch changes mid-session, and leaves server-side cwd resolution as the same-host fallback. (#3515)
