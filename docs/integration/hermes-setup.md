# Hermes Integration Guide

> **This guide has moved.** The Hermes MemoryProvider plugin documentation now lives in the main plugin reference.

See:

- **[Hermes plugin reference](../plugins/hermes.md)** — full setup, configuration, and troubleshooting
- **[remnic-hermes README](https://github.com/joshuaswarren/remnic/blob/main/packages/plugin-hermes/README.md)** — quick-start on GitHub
- **[remnic-hermes on PyPI](https://pypi.org/project/remnic-hermes/)** — package install
- **[Hermes Agent upstream repo](https://github.com/NousResearch/hermes-agent)** — canonical host runtime
- **[Hermes Agent docs](https://hermes-agent.nousresearch.com)** — current upstream documentation

## Quick install

```bash
pip install --upgrade remnic-hermes
remnic connectors install hermes
```

Then restart Hermes to pick up the new plugin.

`remnic-hermes` v1.0.4 includes the full Remnic parity surface in Hermes: automatic MemoryProvider recall/observation, daemon-side LCM recall enrichment, session reset scoping, and explicit `remnic_*` tools for recall debugging, LCM search, memory CRUD, continuity, identity, governance, work boards, shared context, compounding, day summaries, briefings, context checkpoints, and profiling. Legacy `engram_*` aliases are still registered during the compatibility window.

## Which Hermes plugin slot Remnic uses

Remnic registers as a Hermes **`memory_provider`** plugin. **Remnic does not need to register as a Hermes `context_engine`** — that slot replaces Hermes' built-in `ContextCompressor` and is for compressing the agent's own outgoing history. All Remnic capabilities, including Lossless Context Management (LCM), are delivered through the `memory_provider` hook (`pre_llm_call`) and the recall envelope returned by the daemon.

If guidance you encounter (including AI-generated review of the install) tells you LCM requires `register_context_engine`, that guidance is wrong. See the [Hermes plugin reference](../plugins/hermes.md#which-hermes-plugin-slot-remnic-uses) for the full explanation.
