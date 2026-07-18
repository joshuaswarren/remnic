# Remnic

[![npm version](https://img.shields.io/npm/v/@remnic/cli)](https://www.npmjs.com/package/@remnic/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-pink)](https://github.com/sponsors/joshuaswarren)

Open-source, local-first memory and context for AI agents. One memory store, every agent.

- **Your files, your machine.** Every memory is a plain markdown file with YAML frontmatter on your disk. No database, no cloud dependency, no subscription. `cat`, `grep`, edit, and version-control your memory with the tools you already use.
- **One memory across every tool.** OpenClaw, Claude Code, Codex CLI, Cursor, ChatGPT (developer mode), Hermes, Replit, Pi, omp, and any MCP client read and write the same store. Tell one agent a preference; every agent knows it.
- **Automatic extraction and recall.** Remnic watches conversations, distills durable knowledge, and injects the right context back when it is needed.
- **Sharp retrieval.** Hybrid search (BM25 + vector + reranking) over rebuildable indexes, with graph recall, memory-worth scoring, and per-result provenance you can inspect.
- **MIT licensed.** Free, open, and built to be forked.

## Why Remnic

Most agents do not fail because they lack another prompt. They fail because they do not understand the user, the project, the boundaries, or what "good" means in context. Every session starts from zero: the agent forgets your name, your projects, the decisions you already made, and the bugs you already debugged. You re-explain the same context over and over, and the agent still repeats the same mistakes.

There is a useful split in AI memory between **memory backends** (extract facts, store vectors, retrieve relevant ones) and **context substrates** (human-readable context that accumulates and compounds across sessions). Most tools pick one camp. Remnic does both:

- **The files are the source of truth.** The hybrid search index is downstream of your markdown, fully rebuildable from disk, never authoritative itself.
- **Recall stays sharp.** Three retrieval tiers, opt-in graph traversal, memory-worth scoring that filters low-value facts before they reach the model, and temporal supersession that keeps stale facts out.
- **It compounds.** Background consolidation merges duplicates, promotes recurring themes, and snapshots page versions on every overwrite. The longer you use it, the better it gets, and you can always read exactly what it knows.

| Without Remnic | With Remnic |
|---|---|
| Re-explain who you are and what you are working on | The agent recalls your identity, projects, and preferences automatically |
| Repeat context for every task | Entity knowledge surfaces people, projects, tools, and relationships on demand |
| Lose debugging and research context between sessions | Past root causes, dead ends, and findings are recalled, so work is not repeated |
| Manually restate preferences every session | Preferences persist across sessions, agents, and projects |
| A context-switching tax when you resume work | Session-start recall brings you back up to speed |
| Built-in agent memory that does not scale | Hybrid search, lifecycle management, namespaces, and governance |
| Third-party memory services that cost money and hold your data | Everything stays local: your filesystem, your rules |

## Quick start

### Prerequisites

- [Node.js](https://nodejs.org/) 22.12 or newer.
- A model provider for extraction (an OpenAI API key, the OpenClaw gateway model chain, or a [local LLM](docs/guides/local-llm.md)). Retrieval-only mode needs none of these.
- Optional but recommended: [QMD](https://github.com/tobi/qmd) for the highest-quality hybrid search. Without it, Remnic falls back to embedding search and then recency-ordered reads.

### Any agent (standalone)

Install the CLI, start the daemon, and verify it is running.

```bash
npm install -g @remnic/cli       # installs `remnic` (plus the legacy `engram` forwarder)
remnic init                      # write remnic.config.json
export OPENAI_API_KEY=sk-...     # extraction provider (or route to a local LLM)
export REMNIC_AUTH_TOKEN=$(openssl rand -hex 32)
remnic daemon start              # start the background server
remnic status                    # confirm it is running
remnic query "hello" --explain   # test a query with the tier breakdown
```

`remnic query --explain` prints which retrieval tier produced each result and why, so you can watch the memory pipeline work on your very first query. Run `remnic doctor` any time to check your setup, then connect a tool from the table below. Full five-minute walkthrough: [docs/guides/quickstart.md](docs/guides/quickstart.md).

### OpenClaw (native plugin)

OpenClaw gets the deepest integration: a memory-slot plugin that recalls every session and observes every response.

```bash
openclaw plugins install clawhub:@remnic/plugin-openclaw   # install the plugin
remnic openclaw install                                    # wire the memory slot in openclaw.json
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway    # restart the OpenClaw gateway (macOS)
remnic doctor                                              # verify every check passes
```

`remnic openclaw install` writes `plugins.entries["openclaw-remnic"]` and sets `plugins.slots.memory = "openclaw-remnic"` in `~/.openclaw/openclaw.json`. Without the slot, OpenClaw skips plugin registration and no hooks fire, so `remnic doctor` checks the slot explicitly and points you at the fix. After the restart, confirm the plugin is live:

```bash
grep "gateway_start fired" ~/.openclaw/logs/gateway.log
```

A matching line means Remnic is active and hooks are firing. (The `[engram]` log prefix remains during the v1.x compatibility window.)

Prefer to let the agent do it? Tell any OpenClaw agent: *"Install the @remnic/plugin-openclaw plugin and configure it as my memory system."* It runs the install, updates `openclaw.json`, and restarts the gateway for you. Comprehensive install and first-run guide, including QMD setup: [docs/getting-started.md](docs/getting-started.md).

## Works with your tools

One store, many front doors. Each integration reads and writes the same memory on your machine, so a preference you state in one tool is available in all of them.

| Tool | Integration | Recall / observe | Docs |
|------|-------------|------------------|------|
| OpenClaw | Native memory-slot plugin | Every session / every response | [docs/plugins/openclaw.md](docs/plugins/openclaw.md) |
| Claude Code | Native hooks + MCP | Every prompt / every tool use | [docs/plugins/claude-code.md](docs/plugins/claude-code.md) |
| Codex CLI | Native hooks + MCP + memory extension | Every prompt / every tool use | [docs/plugins/codex.md](docs/plugins/codex.md) |
| ChatGPT (developer mode) | MCP + OAuth 2.1 on your own server | On demand | [docs/integration/chatgpt.md](docs/integration/chatgpt.md) |
| Cursor | Generic MCP client | On demand | [docs/integration/connector-setup.md](docs/integration/connector-setup.md) |
| Hermes | Python `MemoryProvider` | Every LLM call / every turn | [docs/plugins/hermes.md](docs/plugins/hermes.md) |
| Replit | MCP | On demand | [docs/plugins/replit.md](docs/plugins/replit.md) |
| Pi Coding Agent | Native extension + MCP + compaction | Every turn / every turn | [docs/integration/pi.md](docs/integration/pi.md) |
| Oh My Pi (omp) | Native extension + MCP | Every turn / every turn | [docs/integration/omp.md](docs/integration/omp.md) |
| Any MCP client | HTTP or stdio MCP | On demand | [docs/integration/connector-setup.md](docs/integration/connector-setup.md) |

Once the daemon is running, register each tool with a single command:

```bash
remnic connectors install codex-cli     # token + connector state + memory extension
remnic connectors install claude-code   # token + connector state
remnic connectors install pi            # token + connector state
remnic connectors install omp           # token + connector state
remnic connectors install replit        # token + connector state
```

Each install mints a host-specific auth token and records Remnic-side connector state; for some hosts (such as Codex CLI) it also materializes the memory extension. How much of the host itself gets configured varies — Claude Code and Hermes, for example, need a few manual wiring steps documented in their plugin guides. See the [connector setup guide](docs/integration/connector-setup.md) for every tool, exactly what its install automates, its config snippet, and multi-tenant setups.

Over MCP, Remnic exposes a rich tool surface beyond store and recall: entity lookup, memory correction, temporal recall, X-ray provenance, daily briefing, work-board, and continuity tools among them. Hosted clients call these directly, and the standalone HTTP endpoint (`remnic daemon start` or `@remnic/server`) serves the same tools. See the [HTTP + MCP API reference](docs/api.md).

## How it works

Remnic runs a continuous three-phase loop around every agent conversation:

```
  Recall   ->  Before a conversation, inject the relevant memories into context
  Buffer   ->  After each turn, accumulate content until a trigger fires
  Extract  ->  Periodically, distill structured memories with an LLM and write them to disk
```

- **Recall** ranks your stored memories against the incoming context and injects a budgeted slice back into the prompt. Extraction and rerank can run through the OpenClaw gateway model chain, OpenAI (Responses API), or a local LLM. See [docs/guides/cost-control.md](docs/guides/cost-control.md).
- **Buffer** accumulates conversation turns until a size or time trigger fires, so extraction runs on meaningful spans rather than on every message.
- **Extract** distills durable knowledge, runs it through an importance judge, and writes accepted memories to disk. The search index is then rebuilt from those files.

```mermaid
flowchart LR
  A[Agent session] -->|recall| B[Memory store<br/>markdown + YAML]
  A -->|buffer turns| C[Extraction]
  C -->|write memories| B
  B -->|index| D[Hybrid search<br/>BM25 + vector + rerank]
  D -->|rank + explain| A
```

Each memory is a portable markdown file with YAML frontmatter, so it stays git-friendly and readable with no database required:

```yaml
---
id: decision-1738789200000-a1b2
category: decision
confidence: 0.92
tags: ["architecture", "search"]
---
Use the port/adapter pattern for search backends so alternative engines
can replace the default index without changing core logic.
```

Categories include `fact`, `decision`, `preference`, `correction`, `relationship`, `principle`, `commitment`, `skill`, and `rule`. Files are organized on disk under your configured memory directory:

```
<memoryDir>/
  facts/       extracted facts, decisions, preferences, corrections, ...
  entities/    people, projects, tools, and their relationships
  profile.md   the accumulated user profile
```

The search index lives separately and is rebuildable from these files at any time. The full storage model and retrieval flow are in [docs/architecture/overview.md](docs/architecture/overview.md).

## Feature highlights

**Core memory.** LLM extraction that separates durable knowledge from conversational noise, entity tracking for people, projects, tools, and relationships, a full write/consolidate/expire lifecycle, and importance gating that drops low-value facts before they are ever stored. See [docs/architecture/memory-lifecycle.md](docs/architecture/memory-lifecycle.md).

**Search.** Six pluggable backends behind one interface: QMD, [Orama](https://oramasearch.com/), LanceDB, Meilisearch, a remote adapter, and a no-op. QMD is the default and highest-quality option, combining BM25, vector, and reranking. Any backend is rebuildable from your markdown at any time. See [docs/search-backends.md](docs/search-backends.md).

**Memory OS.** [Namespaces](docs/namespaces.md) for multi-agent and multi-tenant isolation (opt-in via `namespacesEnabled`, default `false`), hot/cold [tiering](docs/retention-policy.md) driven by a value-score model, background consolidation via the ["dreams" surface](docs/dreams.md), opt-in [graph reasoning](docs/architecture/graph-reasoning.md) with Personalized PageRank, and transparent AES-256-GCM [at-rest encryption](docs/encryption.md) (opt-in via `secureStoreEnabled`, default `false`).

**Lossless Context Management.** Archive full session transcripts and recall them losslessly through the daemon recall envelope, for when a summary is not enough. Opt-in via `lcmEnabled`, default `false`. See [docs/guides/lossless-context-management.md](docs/guides/lossless-context-management.md).

**Trust and boundaries.** Scoped memory, provenance on every fact, correction handling, and boundary principles that decide when an agent should ask instead of act. See [docs/user-aware-agents.md](docs/user-aware-agents.md).

**Import your memory.** Seven optional importers pull existing memory from the tools you already use. The base CLI never bundles them; install only what you need, and every run supports `--dry-run` for a zero-write preview.

| Source | Package | Adapter |
|--------|---------|---------|
| ChatGPT | `@remnic/import-chatgpt` | `remnic import --adapter chatgpt` |
| Claude | `@remnic/import-claude` | `remnic import --adapter claude` |
| Gemini | `@remnic/import-gemini` | `remnic import --adapter gemini` |
| mem0 | `@remnic/import-mem0` | `remnic import --adapter mem0` |
| Supermemory | `@remnic/import-supermemory` | `remnic import --adapter supermemory` |
| WeClone | `@remnic/import-weclone` | `openclaw engram bulk-import --source weclone` |
| lossless-claw | `@remnic/import-lossless-claw` | `remnic import-lossless-claw` |

See [docs/importers.md](docs/importers.md) for input formats, provenance metadata, and the full privacy breakdown.

**Live connectors: Google Drive and Notion.** Beyond one-time imports, Remnic can *continuously* sync external sources into memory. The Google Drive and Notion connectors poll for changed documents on a schedule and ingest them incrementally — connect once (`remnic connectors run google-drive` / `remnic connectors run notion` for a manual sync, `remnic connectors status` to inspect), and your docs stay searchable alongside everything else your agents know. Gmail and GitHub connectors run on the hosted scheduler as well. Setup, OAuth, and polling details: [docs/live-connectors.md](docs/live-connectors.md).

**Wearables.** Three optional connectors ingest AI-wearable recordings, clean and speaker-label the transcripts, apply your personal corrections, store searchable per-day transcript files, and create memories under strict per-source trust gates: `@remnic/connector-limitless` (Limitless Pendant), `@remnic/connector-bee` (Bee bracelet), and `@remnic/connector-omi` (Omi necklace). See [docs/wearables.md](docs/wearables.md).

**Glass-box tooling.** [Recall X-ray](docs/xray.md) shows which retrieval tier produced each result and why, the [daily briefing](docs/guides/daily-briefing.md) surfaces active entities and open commitments, and the [operator console](docs/console.md) gives live engine introspection with trace record and replay.

**Benchmarks.** Memory quality is measured, not asserted. [MemCorrect](docs/benchmarks/memcorrect.md) checks whether a backend recalls the right fact, accepts a correction, and stops serving the stale one. The [full benchmark suite](docs/benchmarks.md) covers the rest, with reproducible artifacts and leaderboard safety.

**More capabilities.** A few of the deeper features, each with its own guide:

- [Procedural memory](docs/procedural-memory.md) — multi-step runbooks captured from your work (on by default outside the `conservative` preset).
- [Temporal recall](docs/temporal-recall.md) — `valid_at` / `invalid_at` fact lifecycle and an `as_of` recall filter.
- [Pattern reinforcement](docs/pattern-reinforcement.md) — cross-session pattern detection with a recall boost for reinforced primitives.
- [Shared context](docs/shared-context.md) — cross-agent shared intelligence for multi-agent teams.
- [Coding-agent memory](docs/coding-agent.md) — repo conventions, review behavior, and ask-before rules for coding tools.

## OpenAI Build Week: Remnic Relay

**Remnic Relay is memory that can heal an agent team.** It exposes incompatible
beliefs, binds a failing outcome to stale memory, requires a human-approved
correction, retires the old decision, and proves a transcript-free cold agent
used the replacement to turn the same hidden contract green.

Run the complete judge experience from this checkout with Node 22.12+—no
dependency install, build, account, credential, dataset download, model call,
or network access required. The synthetic mission fixture is already committed
under `fixtures/remnic-relay/` and verified in place:

```bash
npm run relay:demo
```

The committed Mission Control replay is bound to an isolated live mission:
four distinct Codex one-shot threads ran `gpt-5.6-terra` as Scout, stale
Builder, Resolver, and cold Builder. One human-approved correction changed the
hidden contract from failed to passed in 84.829 seconds and used 5.8096 locally
accounted Codex units. The run used synthetic fixtures and a fresh isolated
Remnic store, never production data; Sol was disabled. Verify the hashes,
causal chain, usage, UI binding, privacy receipt, and measured 165-second demo
script with:

```bash
npm run relay:judge
npm run relay:judge:clean-room
```

Codex collaborated throughout the in-window extension: it modeled and built
the Relay event/API contract, designed Mission Control, implemented the Linux
isolation and bounded MCP/network surfaces, converted review findings into
adversarial tests, sealed the GPT-5.6 evidence, and built the no-install judge
package. The user made the key product and safety calls: pivot to Relay, keep
performance work separate, use only a cleared synthetic Remnic instance, use
Codex CLI event credits instead of API billing, prefer Terra, prohibit Sol,
cap the mission at four calls, and require human approval plus current-head
PR-loop review.

Remnic's core memory engine, adapters, benchmark framework, and general console
predate Build Week. The [submission ledger](HACKATHON.md) separates that prior
work from every new Relay phase with dated commits and PRs. See the exact
[judge guide](docs/remnic-relay/JUDGE-GUIDE.md),
[claim ledger](docs/remnic-relay/CLAIMS.md),
[demo script](docs/remnic-relay/DEMO-SCRIPT.md), and
[Devpost draft](docs/remnic-relay/DEVPOST.md).

## Privacy and your data

Local-first is a trust feature, not a tagline.

- **Everything lives on your disk** as markdown you can inspect, edit, back up, and version-control. There is no Remnic cloud and no account.
- **Retrieval never needs the network.** Recall runs entirely against your local files and index.
- **Extraction uses the provider you choose.** When Remnic distills a memory, it calls whatever model provider you configured. To keep every byte on-device, route extraction to a [local LLM](docs/guides/local-llm.md) or use `--dry-run` on imports to preview without writing.
- **Sensitive tools see what you surface.** When a hosted client such as ChatGPT calls Remnic's tools, the content it reads and writes also passes through that client's pipeline. Treat what you expose accordingly.
- **Keep user data out of git.** Paths that contain memory content (`facts/`, `entities/`, `profile.md`) should never be committed. Enable [at-rest encryption](docs/encryption.md) if the disk itself is untrusted.

## Architecture

Remnic is a [pnpm](https://pnpm.io/) monorepo of **25+ published packages**. The engine is host-agnostic; every integration is a thin adapter over it, so standalone Remnic is always first-class and adapter work follows each host's upstream SDK rather than recreating host behavior inside Remnic.

```text
                        @remnic/core
             (extraction, storage, search,
              graph, trust, consolidation)
                            |
        +-------------------+-------------------+
        |                   |                   |
   @remnic/cli        @remnic/server       plugins
   (remnic bin)       (HTTP + MCP)      openclaw, claude-code,
                                        codex, pi, hermes
                            |
                     a la carte add-ons
              import-* (7 importers) + connector-*
                    (3 wearable sources)
```

- **Engine:** `@remnic/core` (the framework-agnostic memory engine), `@remnic/cli` (the standalone `remnic` binary), and `@remnic/server` (HTTP + MCP server).
- **Plugins:** native adapters for OpenClaw, Claude Code, Codex, and Pi, plus Hermes shipped as `remnic-hermes` on PyPI.
- **A la carte:** seven `@remnic/import-*` importers and three `@remnic/connector-*` wearable connectors, installed only when you need them.
- **Benchmarks:** `@remnic/bench` provides the published suites and CI regression gates.

The complete package map, dependency graph, and publish order are in [docs/architecture/monorepo-structure.md](docs/architecture/monorepo-structure.md).

## Configuration

Remnic is zero-config by default: `remnic init` writes a working `remnic.config.json` and every subsystem ships a sensible default. When you need control, there are hundreds of options grouped under four presets, selectable with a single `memoryOsPreset` key:

- `conservative` — minimal footprint, extraction judge and heavier features off.
- `balanced` — the general-purpose default.
- `research-max` — every quality feature enabled, highest cost.
- `local-llm-heavy` — tuned for local-model extraction and rerank.

Extraction routing (`gateway`, OpenAI, or a local LLM), recall budget, search backend, lifecycle, namespaces, and encryption are all configurable. Every setting, its default, and operator guidance live in [docs/config-reference.md](docs/config-reference.md).

## Self-hosting and operators

Running Remnic for a team or across machines? `remnic daemon start` hands off to launchd or systemd when a service is installed, and `@remnic/server` exposes the same memory over HTTP + MCP for remote agents. Namespaces isolate tenants, and the standalone server supports multi-tenant, multi-harness setups.

- [Standalone server guide](docs/guides/standalone-server.md) — multi-tenant setup and connecting multiple harnesses.
- [Deployment topologies](docs/integration/deployment-topologies.md) — localhost, LAN, remote, and containerized layouts.
- [Operations](docs/operations.md) — backups, exports, hourly summaries, and logs.

## Documentation

The complete, organized docs hub lives at **[docs/README.md](docs/README.md)**. Starting points by journey:

- **Start here:** [Quickstart](docs/guides/quickstart.md) - [Getting started](docs/getting-started.md) - [CLI reference](docs/cli.md)
- **Connect your tools:** [Connector setup](docs/integration/connector-setup.md) - [ChatGPT](docs/integration/chatgpt.md) - [Plugins index](docs/plugins/README.md) - [Deployment topologies](docs/integration/deployment-topologies.md)
- **Configure:** [Config reference](docs/config-reference.md) - [Search backends](docs/search-backends.md) - [Local LLM](docs/guides/local-llm.md) - [Cost control](docs/guides/cost-control.md)
- **Operate:** [Operations](docs/operations.md) - [Retention policy](docs/retention-policy.md) - [Import / export](docs/import-export.md) - [Standalone server](docs/guides/standalone-server.md)
- **Internals:** [Architecture overview](docs/architecture/overview.md) - [Retrieval pipeline](docs/architecture/retrieval-pipeline.md) - [Memory lifecycle](docs/architecture/memory-lifecycle.md) - [HTTP + MCP API](docs/api.md)

## FAQ

**Do I need OpenClaw?** No. Remnic runs standalone through `@remnic/cli` and connects to any tool over MCP or HTTP. OpenClaw simply gets the deepest native integration.

**Does it work offline or without an API key?** Retrieval works with no provider at all. Extraction needs a model, but you can route it to a [local LLM](docs/guides/local-llm.md) to keep everything on-device.

**Where is my data?** In markdown files under your configured memory directory. Nothing leaves your machine except during extraction with a remote provider, or when a hosted client reads memories through Remnic's tools.

**How much does it cost?** The software is MIT and free. Your only cost is your chosen extraction provider, which is zero when you use a local LLM.

**Do I need QMD?** No, but it gives the best search. Without it, Remnic falls back to embedding search and then recency-ordered reads.

**Can multiple agents share one memory?** Yes. Every connected tool reads and writes the same store, and [namespaces](docs/namespaces.md) isolate tenants when you want separation.

**Is it production-ready?** Remnic is extensively tested with CI regression gates and a published benchmark suite. See [docs/benchmarks.md](docs/benchmarks.md) for the evidence.

**I was using Engram.** Everything still works. See [Engram to Remnic](#engram-to-remnic) below for the migration path.

## Engram to Remnic

Engram is now Remnic. Canonical packages live under the `@remnic/*` scope, and OpenClaw installs use [`@remnic/plugin-openclaw`](https://www.npmjs.com/package/@remnic/plugin-openclaw). The legacy `engram` CLI name, the `openclaw engram` command namespace, and the `/engram/v1/...` HTTP paths remain available as a compatibility surface during the rename window. Migrating an existing install? Run `remnic openclaw migrate-engram --yes`, which backs up the legacy extension, installs the new plugin, preserves your `memoryDir`, and switches the memory slot. Full steps: [Engram to Remnic migration guide](docs/guides/openclaw-engram-to-remnic.md).

## Community and roadmap

- [Feature roadmap (GitHub Project)](https://github.com/users/joshuaswarren/projects/1) — current priority order, blockers, and next work.
- [Issues](https://github.com/joshuaswarren/remnic/issues) — report a bug or request a feature.
- [Contributing](CONTRIBUTING.md) — how to build Remnic and open a pull request.

## Support

Every bit of support helps keep Remnic alive and free. If you are able, [sponsor on GitHub](https://github.com/sponsors/joshuaswarren) or send a Lightning donation to `joshuaswarren@strike.me` to directly fund continued development and new integrations.

[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-pink?style=for-the-badge)](https://github.com/sponsors/joshuaswarren)

If financial support is not an option, you can still make a big difference: [star the repo](https://github.com/joshuaswarren/remnic), share it, or recommend it to a colleague. Word of mouth is how most people find Remnic.

## Contributing

Contributions from humans and AI-assisted contributors are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the preflight gate, and PR expectations. Deeper references: [docs/development/contributing.md](docs/development/contributing.md) and [docs/CONVENTIONS.md](docs/CONVENTIONS.md).

## License

[MIT](LICENSE)
