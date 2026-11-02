# Accessibility

Remnic keeps facts, choices, and unfinished work available across AI sessions. It can help when you need to resume work or repeat less context. People with ADHD or autism may have those needs. You do not need a diagnosis to use Remnic or give feedback.

Joshua is the only verified user represented here. GitHub activity does not tell us who uses Remnic or whether it helps them.

## Features you can use

| Need | Feature | Default and limits |
|---|---|---|
| Resume work | Session-start recall brings back project context and preferences. | Needs a supported host hook. An MCP connection alone does not add this hook. |
| Find open work | [Daily briefing](docs/guides/daily-briefing.md) lists active threads and commitments. | On by default. Calendar input needs setup. Model follow-ups are on by default when a provider is available. Set `briefing.llmFollowups` to `false` to turn them off. |
| Check or correct a memory | Read the Markdown files. Correction tools show a plan before they apply it. | Correction and its confirmation step are on by default. Edits outside Remnic need the normal index update before search reflects them. |
| See why a memory appeared | [Recall X-ray](docs/xray.md) shows scores, filters, sources, and the context budget. | It explains how search worked. It does not prove that a memory is right. |
| Share support preferences | [What Helps Me](docs/support-passport.md) lets you review cards, share them for a set time, and revoke access. | Off by default. Manual cards need no model. Helpers see only the card revisions you approved, not your whole memory store. |

What Helps Me is a self-advocacy tool. It is not a medical record, care plan, diagnosis tool, or emergency guide.

## Access and test limits

The What Helps Me app has keyboard controls, visible focus, text labels, and reduced-motion support. Its existing tests cover four screen widths. They reject serious or critical Axe findings. See the [accessibility checks](docs/support-passport.md#accessibility-checks).

These tests cover one app. They are not a whole-product WCAG audit or screen-reader certification. They do not prove a health benefit. This docs change did not run a new access or usability study.

## Local-only use and privacy

Remnic stores memories as Markdown on your disk. It also keeps local indexes and other state. That does not stop models, clients, search services, or other tools from sending data elsewhere.

For local-only use, check each route:

1. Use `modelSource: "plugin"` for the [local LLM path](docs/guides/local-llm.md). With `modelSource: "gateway"`, the gateway controls the main extraction route.
2. Check the model server and its exact model ID. A server on your LAN is another machine. Its name does not prove where the model runs.
3. Set `taskLlmFallback: false` to stop fallback from the local task route. The default is `true`. The older `localLlmFallback` key applies only when the new key is absent. The `local-llm-heavy` preset does not turn fallback off.
4. Check embeddings, reranking, briefing follow-ups, search, clients, connectors, and sharing on their own. Turn off routes you do not want. `openaiApiKey: false` stops Remnic from inheriting `OPENAI_API_KEY` for its direct provider. It does not change a host client's model routes.
5. Test the setup with a separate memory store before you use private data. A config check, `doctor` output, or a working endpoint is not proof of model use or no network traffic.

Read the [config reference](docs/config-reference.md), [search guide](docs/search-backends.md), and [deployment guide](docs/integration/deployment-topologies.md) before you connect another client or machine. Hosted clients process the memories they receive under their own policies. A revoked share cannot erase copies someone made.

### Local-model checks, 2026-11-02 UTC

This task did not prove same-machine local inference on Omarchy or Apple Silicon. The independent check covered a Linux x86_64 host. It stopped when a file access check failed. No model request or workaround ran.

| Check | Status | Result |
|---|---|---|
| Linux x86_64 and a running model service | Measured | Passive check at 2026-11-02 01:02:30 UTC. No model response. |
| Process file access | Measured | The executable check returned `PermissionError` (`errno 13`) and exited with status 1. |
| Exact executable, loaded model, and API model ID | Not measured | The access failure stopped this check. |
| Installed Remnic and same-machine x86_64 inference | Not measured | No Remnic model call ran. An x86_64 client calling a different architecture would not count. |
| Cloud fallback refusal on local model failure | Not measured | Source checks did not test runtime behavior. |
| Ollama, llama.cpp Vulkan, and Apple Silicon inference | Not measured | No runtime check ran for these paths. |

The source check used commit `baffee2c22e02104fa934cb07836b620d491480d`, core 9.69.85. It does not verify an installed runtime or the current release.

## Joshua's experience

[Paragraph reserved for Joshua. Intentionally empty; no personal account has been supplied for this document.]

## Give feedback

[Open an issue](https://github.com/joshuaswarren/remnic/issues/new) with the task, barrier, and change that would help. Share your operating system, client, or assistive tool if you want to. A diagnosis is optional.

GitHub issues and discussions are public. Leave out private memories, credentials, and health details you do not want public. Remove private content from logs before posting. You can describe a barrier without sharing your personal history.
