# Contributors

Thanks to everyone who contributes to Remnic (formerly `openclaw-engram`).

## Maintainer

- [@joshuaswarren](https://github.com/joshuaswarren) (Joshua Warren) - creator, architect, and lead maintainer. Designed the memory model (facts, entities, profile, corrections), the recall/extraction pipeline, the multi-host adapter architecture, and the à-la-carte packaging contract.

## Community Contributors

- [@100menotu001](https://github.com/100menotu001) - first community PR: QMD sync after `memory_store`, with update/embed scoped to the collection
- [@MrGPUs](https://github.com/MrGPUs) - `openaiBaseUrl` config for OpenAI-compatible providers, `encoding_format` for vLLM/LiteLLM embeddings, richer entity-aware extraction prompts, and compaction reset with BOOT.md injection
- [@KenFab](https://github.com/KenFab) - consistent `/v1` prefix handling for local LLM chat completions endpoints
- [@earlvanze](https://github.com/earlvanze) (Earl Co) - OpenClaw memory runtime capability shim, `registerCommand` validator compatibility fix, Remnic admin dashboard controls and container, dashboard/harness provider separation, admin console bearer-token autofill, and Codex plugin discovery metadata
- [@ramarivera](https://github.com/ramarivera) (Ramiro Rivera) - Pi plugin recall-timeout circuit breaker, startup Remnic probe capping, and object-rooted MCP tool output schemas
- [@kopertop](https://github.com/kopertop) (Chris Moyer) - Claude Code marketplace manifest, authenticated health probe, and namespace targeting in Claude Code hooks
- [@rmichelena](https://github.com/rmichelena) - routing gateway task defaults through `taskModelChain`
- [@dfein38347g](https://github.com/dfein38347g) - single context injection at Pi session start for KV cache stability
- [@geekboy1011](https://github.com/geekboy1011) (Tim Keller) - QMD Docker integration
- Craig Froelich - QMD sync triggering after `memory_store` and hybrid BM25 + vector search / recall optimization merges

## Agent Contributors

Remnic is developed with heavy agent assistance, and those contributions are
credited rather than hidden. Commits co-authored by Claude (Opus and Sonnet),
Codex, and operator-run agents such as `Sysop Agent` and `GPUCodeBot` appear
throughout the history - notably the day-summary cron, model fallback chain,
and OAuth provider resolution work.

We appreciate both human and AI-assisted contributions that improve
reliability, usability, and documentation.
