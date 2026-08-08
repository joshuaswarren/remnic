# Contributors

Thanks to everyone who works on Remnic, once called `openclaw-engram`.

## Maintainer

- [@joshuaswarren](https://github.com/joshuaswarren). Creator, architect, and lead maintainer. Designed the memory model, the recall and extraction pipeline, the multi-host adapter split, and the à-la-carte packaging contract.

## Community contributors

- [@100menotu001](https://github.com/100menotu001). First community PR. Synced QMD after `memory_store`. Scoped update and embed to one collection.
- [@MrGPUs](https://github.com/MrGPUs). Added `openaiBaseUrl` for OpenAI-compatible hosts. Added `encoding_format` for vLLM and LiteLLM. Put entity facts in the extract prompt. Built compaction reset with BOOT.md. Switched the OpenClaw hook to `prependSystemContext`, which keeps bootstrap files intact. Reworked the recall pipeline with a configurable inject order and a budget.
- [@KenFab](https://github.com/KenFab). Fixed the `/v1` prefix for local LLM chat calls.
- [@earlvanze](https://github.com/earlvanze). Added the OpenClaw memory runtime shim. Fixed the `registerCommand` check. Built the admin dashboard and its container. Split dashboards from harnesses. Filled in Codex plugin metadata.
- [@ramarivera](https://github.com/ramarivera). Added the Pi recall-timeout circuit breaker. Capped startup probes. Made MCP output schemas object-rooted.
- [@kopertop](https://github.com/kopertop). Added the Claude Code market manifest. Put auth on the health probe. Added namespace targeting to the hooks.
- [@rmichelena](https://github.com/rmichelena). Sent gateway task defaults through `taskModelChain`. Resolved OAuth providers. Routed LCM through the task model chain. Reconciled the day-summary cron.
- [@dfein38347g](https://github.com/dfein38347g). Moved Pi to one context inject at session start, to keep the KV cache stable.
- [@geekboy1011](https://github.com/geekboy1011). Added QMD Docker support.

## Agent contributors

Remnic is built with a lot of agent help, and that work is credited, not
hidden. Commits co-authored by Claude and Codex run through the whole history.
Some community PRs land the same way, with a contributor's own coding agent as
the commit author. Those are credited to the person who opened the PR.

Human and AI-assisted work both count here.
