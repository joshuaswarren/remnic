# FrontierMemory 1.0 status

Evaluation blocked on 2026-10-22. Zero of 15 tasks attempted. No Remnic or no-memory score exists.

- Plan: [eval-plan.md](eval-plan.md).
- Draft PR: pending creation; this field will be replaced after GitHub returns its URL.
- Results: [Markdown](results-2026-10-22.md) and [JSON](results-2026-10-22.json).

## Blockers

The public [submission page](https://www.frontiermemory.com/submit/) requires contact with the benchmark authors. It provides no executable harness, README, or task download. GitHub repository search returned zero results for `FrontierMemory`.

This process has no `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `LETTA_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`, or `OPENROUTER_API_KEY`. Execution stopped at credential preflight. No credentials were fetched elsewhere.

## Scores and remaining work

The published harness range is 13.3% to 73.3% across all 15 tasks. Remnic has no measured score to compare against it. Every task and the no-memory condition remain unrun. The result files distinguish missing measurements from failed tasks.

No harness checkout, adapter, temporary daemon, memory store, or benchmark worker was created. No production memory service, shared index, fleet model endpoint, or unrelated experiment was used.

## Requirements for a full run

1. Supply official harness access, its README, trajectories, task environments, and verifiers.
2. Supply the required provider keys in the execution environment and approve the chosen paid configuration.
3. Provide the sandbox runtime required by the README; Docker is not on the current PATH.
4. Implement and verify the standalone Remnic adapter with isolated temporary state and default recall settings.
5. Run all 15 matched task pairs and reference conditions; export every outcome and provider cost.

For Remnic plus no-memory, the provisional task-only estimate is $23.10 to $84.00. Generation, embeddings, sandboxes, references, and retries cost extra. Thirty trials need an assumed 2.5 to 15 hours on one worker; adding the allowed generation maximum gives 8.5 to 21 hours. Neither runtime nor Remnic cost has been measured. The plan explains the arithmetic and separate reference rerun requirements.

Keep the PR draft. Do not self-merge or mark it ready.
