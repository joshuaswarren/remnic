---
"@remnic/core": minor
"@remnic/plugin-openclaw": patch
"@joshuaswarren/openclaw-engram": patch
---

Publish pending fixes that have been on `main` since the last npm release (`@remnic/core@1.0.3`, `@remnic/plugin-openclaw@1.0.6`, `@joshuaswarren/openclaw-engram@9.3.5`). Users installing from npm currently hit issues #548 and #549 because the code that fixes them is on `main` but not in a published release.

`@remnic/core` — **minor** (one user-visible behavior change plus several fixes):

- Flip `recallDirectAnswerEnabled` default to `true` so the observation-mode direct-answer tier runs out of the box — annotates `LastRecallSnapshot.tierExplain` for the CLI/HTTP/MCP explain surfaces (#544, #518 slice 8a).
- Gate local-LLM thinking-mode suppression behind the new `localLlmDisableThinking` config (default `true`); backend-detected so the `chat_template_kwargs` field is only sent to LM Studio / vLLM and never trips strict OpenAI-compat backends with 400s (#550, issue #548).
- Log extraction-queue aborts at `debug`, not `error`. Session-transition cancellations are intentional deduplication and were being misreported as failures next to the successful extraction log (#552, issue #549). The orchestrator's private abort helpers now route through the shared `abort-error.ts` module for uniform `isAbortError` classification.
- Add the contradiction-scan maintenance cron on top of temporal supersession (#553).
- Several smaller fixes: openclaw-chain benchmark gateway path (#547), Cursor Bugbot configuration integration (#546).

`@remnic/plugin-openclaw` — **patch**: schema + UI metadata updates in `openclaw.plugin.json` for the new/changed config keys (`recallDirectAnswerEnabled` default flip, new `localLlmDisableThinking`, contradiction-scan cron toggles).

`@joshuaswarren/openclaw-engram` (legacy shim) — **patch**: mirror of the plugin-openclaw manifest updates so operators on the legacy plugin id get the same fixes and defaults.

No API breaks. Users installing after this release pick up all of the above automatically; operators who need to restore prior behavior can set `recallDirectAnswerEnabled: false` or `localLlmDisableThinking: false` via config.
