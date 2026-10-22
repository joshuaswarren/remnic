# FrontierMemory 1.0 evaluation plan

## Execution state

Blocked before setup or task execution on 2026-10-22. No benchmark score exists for Remnic from this evaluation.

The public [benchmark site](https://www.frontiermemory.com/) links “Run the benchmark” to a [contact-only submission page](https://www.frontiermemory.com/submit/). That page supplies no harness repository, README, task bundle, or runner command. GitHub repository search for `FrontierMemory` returned `total_count: 0`. This does not prove that no private harness exists.

The current process has no `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `LETTA_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`, or `OPENROUTER_API_KEY`. Execution stops here. Do not retrieve credentials from another process, account store, service, or host.

## Versions and setup

| Component | Observed version or state |
| --- | --- |
| Remnic source | `main` at `4cd7e54c70e94b1899ead3cd95285c183ca8638a` |
| `@remnic/core` | `10.0.7` |
| `@remnic/server` | `10.0.7` |
| Node.js | `v22.23.1` |
| Workspace package manager | `pnpm@10.32.1` |
| FrontierMemory | Public 1.0 descriptions; executable release and SHA unavailable |
| QMD | No executable on this process's PATH; no index opened |
| Docker | No executable on this process's PATH |
| Harness checkout | Not created; no verified download URL |
| Standalone daemon | Not started because credentials are missing |

After access is supplied, install the harness outside the Remnic checkout and follow its actual README. Pin its commit, dataset checksum, container images, model identifiers, and runner versions before execution. Do not substitute another memory benchmark.

## Remnic configuration under test

Use standalone core/server from the pinned main commit. Keep all recall settings at their defaults. Do not override recall scope, result counts, token budgets, planner mode, or recall deadlines.

Use a new `mktemp -d` root, a new local authentication token, and a loopback port distinct from the normal daemon. Every trial condition gets fresh state. Never reuse an existing daemon, memory directory, token, or QMD index. Disable access to operator services through a minimal child environment.

QMD is unavailable in this environment. The planned alternative is the built-in Orama backend, documented in [search backends](../../search-backends.md#orama). Configure only `searchBackend: "orama"` plus storage isolation. Without an embedding provider, Orama uses BM25; record that limitation if it occurs. Do not label BM25 as hybrid retrieval. Backend selection is the sole retrieval-related departure from defaults allowed by this plan.

The isolated config will contain a `remnic` block with `memoryDir`, `workspaceDir`, `searchBackend: "orama"`, and `oramaDbPath`, all rooted under the temporary directory. The `server` block will bind `127.0.0.1:14319`. Pass the new token through `REMNIC_AUTH_TOKEN` rather than committing it. Set `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, and `XDG_DATA_HOME` under the same temporary root. Pass only the explicitly selected model provider's key.

These are source-confirmed launch and probe forms, not commands executed in this evaluation:

```bash
node scripts/pnpm.mjs --filter @remnic/core build
node scripts/pnpm.mjs --filter @remnic/server build
node packages/remnic-server/bin/remnic-server.js \
  --config "$RUN_ROOT/remnic.config.json" --host 127.0.0.1 --port 14319
curl --fail --max-time 15 http://127.0.0.1:14319/engram/v1/health \
  -H "Authorization: Bearer $REMNIC_AUTH_TOKEN"
```

Launch only after constructing the isolated environment and config described above. Confirm the selected backend and storage roots from the actual instance. Stop the owned process and remove its temporary data after exporting permitted results. No daemon-management command that could target a normal installation belongs in this evaluation.

## Experimental design

1. Obtain the official trajectories, task environments, verifier, and runner README. Keep verifier answers and gold memories out of memory generation.
2. Run the official no-memory condition with a fresh task environment. Use the same task model, effort, seed, and verifier for Remnic.
3. Feed the supplied trajectories through Remnic's normal observation and extraction paths. Persist the memory before task execution and retain default recall behavior.
4. Run matched Remnic trials, initially one worker. At most two workers may run. Order tasks by official resource and cost metadata, cheapest first.
5. Export every attempted task, including errors, failed verifications, timeouts, usage, and costs. Compare only matched conditions and report partial coverage explicitly.

The adapter is not implemented. Its ingestion, flush, recall injection, and task boundaries must follow the obtained harness contract. Do not invent a runner CLI or claim an integration exists before exercising it.

During generation and task execution, disable browsing and online solution lookup. Public task descriptions and published memories must not become evaluation inputs. This preparation inspected the Word2Vec results page for cost context; the task agent must receive only official permitted inputs.

## Baselines and comparison

The [release report](https://www.frontiermemory.com/blog/v1/) defines full-pass rate across 15 tasks, one attempt each. It reports the better of two task-model scores at maximum effort. Preserve individual task-model results rather than silently selecting a favorable partial subset.

| Published reference condition | Full-pass rate |
| --- | ---: |
| Letta Dream, Opus memory/task pair | 73.3% |
| Prime Agent, Opus memory/task pair | 60.0% |
| Claude Managed Agents, Opus memory/task pair | 33.3% |
| Hermes Agent, Opus memory/task pair | 26.7% |
| Letta Dream, Sol memory/task pair | 60.0% |
| OpenAI Agents SDK, Sol memory/task pair | 40.0% |
| Hermes Agent, Sol memory/task pair | 20.0% |
| Prime Agent, Sol memory/task pair | 13.3% |

These are external reference scores, not local baseline runs. No local no-memory score exists. Obtain the harness's no-memory switch and reference-system commands before rerunning them. A partial Remnic score cannot establish a ranking against these complete 15-task results.

## Cost and runtime estimates

No provider call or paid benchmark resource was used. Benchmark provider spend is $0.00.

The release report lists $0.77 mean task cost for its Sol memory/Letta configuration and $2.80 for its Opus configuration. It excludes memory generation. Multiplying those published means gives the following planning estimates, not quotes or observed Remnic costs:

| Scope | Task cost estimate, USD |
| --- | ---: |
| One task, one condition | 0.77 to 2.80 |
| One matched task, no-memory plus Remnic | 1.54 to 5.60 |
| Fifteen tasks, one condition | 11.55 to 42.00 |
| Fifteen matched tasks, two conditions | 23.10 to 84.00 |

Memory generation, embedding, sandbox hosting, reference reruns, and retries are extra and currently unpriced. No-memory costs may differ from memory-assisted costs. The [Word2Vec page](https://www.frontiermemory.com/tasks/build-word2vec-pipeline/) reports $0.05 for one max-effort Sol task using Opus-generated Letta memory; that is not a Remnic or no-memory estimate.

For scheduling only, assume 5 to 30 minutes per task trial until measured. Thirty matched trials require 2.5 to 15 hours with one worker. The benchmark permits up to six hours for memory generation; allowing that maximum gives 8.5 to 21 hours, excluding setup. These are planning assumptions, not measured runtimes. Per-task ordering and estimates require the actual task manifests.

Rerunning all five named reference systems adds 75 trials for one configuration each. At the same scheduling assumption, those trials add 6.25 to 37.5 hours on one worker, plus each system's memory generation. Their total cost is unknown until configurations and provider rates are fixed. Reproducing every published model/effort combination is larger still.

## Exact commands and missing prerequisites

The following read-only preflight commands were executed:

```bash
gh api 'search/repositories?q=FrontierMemory&per_page=20' \
  --jq '{total_count,items:[.items[].full_name]}'
node -e 'for(const k of ["OPENAI_API_KEY","ANTHROPIC_API_KEY","LETTA_API_KEY","GOOGLE_API_KEY","GEMINI_API_KEY","OPENROUTER_API_KEY"]) console.log(k+"="+(process.env[k]?"SET":"MISSING"))'
```

The search returned zero repositories. Every listed key was missing. No official setup, baseline, Remnic, or verifier command can be supplied yet: the runner README and interface are unavailable. Recording invented commands would not make the evaluation reproducible.

A full run needs official harness access, task assets and verifiers, supported sandbox tooling, provider credentials already in the execution environment, and approval for the selected paid configuration. No contact message was sent. Keep the pull request draft; do not self-merge or mark it ready.
