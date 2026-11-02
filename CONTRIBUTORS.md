# Contributors

Thanks to everyone who works on Remnic, once called `openclaw-engram`.

## Maintainer

- [@joshuaswarren](https://github.com/joshuaswarren). Creator, architect, and lead maintainer. Designed the memory model, the recall and extraction pipeline, the multi-host adapter split, and the à-la-carte packaging contract.

## Community contributors

- [@100menotu001](https://github.com/100menotu001). First community PR. Synced QMD after `memory_store`. Scoped update and embed to one collection.
- [@MrGPUs](https://github.com/MrGPUs). Added `openaiBaseUrl` for OpenAI-compatible hosts. Added `encoding_format` for vLLM and LiteLLM. Put entity facts in the extract prompt. Built compaction reset with BOOT.md. Switched the OpenClaw hook to `prependSystemContext`, which keeps bootstrap files intact. Reworked the recall pipeline with a configurable inject order and a budget. Moved extraction to chat completions for OpenAI-compatible endpoints.
- [@KenFab](https://github.com/KenFab). Fixed the `/v1` prefix for local LLM chat calls.
- [@earlvanze](https://github.com/earlvanze). Added the OpenClaw memory runtime shim. Fixed the `registerCommand` check. Built the admin dashboard and its container. Split dashboards from harnesses. Filled in Codex plugin metadata.
- [@ramarivera](https://github.com/ramarivera). Added the Pi recall-timeout circuit breaker. Capped startup probes. Made MCP output schemas object-rooted. Scoped MCP writes to the project from cwd. Made the Codex hooks cross-platform and wrote the Windows docs.
- [@kopertop](https://github.com/kopertop). Added the Claude Code market manifest. Put auth on the health probe. Added namespace targeting to the hooks.
- [@rmichelena](https://github.com/rmichelena). Built the task-specific gateway model chain. Sent gateway task defaults through it. Resolved OAuth providers. Routed LCM through the task model chain. Reconciled the day-summary cron.
- [@dfein38347g](https://github.com/dfein38347g). Made Pi recall once, on the first prompt, then inject that same cached context every turn. Keeps the KV cache prefix stable.
- [@Fancyhe1](https://github.com/Fancyhe1). Authored the `prependSystemContext` switch that preserves bootstrap files in the OpenClaw hook.
- [@RichardHojunJang](https://github.com/RichardHojunJang). Added the policy-bound Hermes LLM bridge plugin. Made Hermes follow the persisted model. Bounded startup QMD collection checks.
- [@geekbozu](https://github.com/geekbozu). Added QMD Docker support.

## Agent contributors

Remnic is built with a lot of agent help, and that work is credited, not
hidden. Commits co-authored by Claude and Codex run through the whole history.
Some community PRs land the same way, with a contributor's own coding agent as
the commit author. Those are credited to the person who opened the PR.

Human and AI-assisted work both count here.

## Contributor accounts (generated registry)

The list below is generated weekly by `.github/workflows/contributors.yml`
from the GitHub API (non-anonymous commit authors plus merged pull-request
authors; maintainer, bot and coding-agent accounts excluded). The curated
sections above are maintained by hand and never touched by automation.

<!-- BEGIN GENERATED CONTRIBUTORS (contributors.yml; do not hand-edit) -->

- [@100menotu001](https://github.com/100menotu001)
- [@cursoragent](https://github.com/cursoragent)
- [@dfein38347g](https://github.com/dfein38347g)
- [@earlvanze](https://github.com/earlvanze)
- [@Fancyhe1](https://github.com/Fancyhe1)
- [@geekbozu](https://github.com/geekbozu)
- [@KenFab](https://github.com/KenFab)
- [@kopertop](https://github.com/kopertop)
- [@MrGPUs](https://github.com/MrGPUs)
- [@ramarivera](https://github.com/ramarivera)
- [@RichardHojunJang](https://github.com/RichardHojunJang)
- [@rmichelena](https://github.com/rmichelena)
_Linked GitHub accounts only. Anonymous (unlinked) commit authors are
enumerable through the API (anon=true) but are identified there only by
name/email, which this registry does not publish; credit them by hand in
the sections above where known._

<!-- END GENERATED CONTRIBUTORS -->
