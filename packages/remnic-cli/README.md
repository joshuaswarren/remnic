# @remnic/cli

CLI for Remnic memory and context -- init, query, daemon management, connectors, curation, and more.

Part of [Remnic](https://github.com/joshuaswarren/remnic), open-source memory and context for user-aware agents.

## Install

```bash
npm install -g @remnic/cli
```

This installs the `remnic` command (and a legacy `engram` forwarder).

## Quick start

```bash
remnic init                     # Create remnic.config.json
export OPENAI_API_KEY=sk-...
export REMNIC_AUTH_TOKEN=$(openssl rand -hex 32)
remnic daemon start             # Start background server
remnic status                   # Verify it's running
remnic query "hello" --explain  # Test query with tier breakdown
```

## Commands

| Command | Description |
|---------|-------------|
| `remnic init` | Create a config file |
| `remnic daemon start/stop/status` | Manage the background server |
| `remnic query <text>` | Search memories |
| `remnic doctor` | Diagnose configuration issues |
| `remnic connectors install <name>` | Connect Claude Code, Codex CLI, Replit, etc. |
| `remnic curate` | Interactive memory curation |
| `remnic dedup` | Find and merge duplicate memories |
| `remnic sync` | Diff-aware sync with external sources |
| `remnic offline prepare/sync/status/watch` | Use a local memory cache and sync with a remote Remnic daemon |
| `remnic spaces` | Manage memory namespaces |
| `remnic bench list` | List published benchmark packs |
| `remnic bench datasets status/download` | Check or download local benchmark datasets |
| `remnic bench runs list/show/delete` | Manage stored benchmark result files |
| `remnic bench run` | Run one or more published benchmark packs |
| `remnic bench compare` | Compare two stored benchmark results |
| `remnic bench baseline` | Save or list named benchmark baselines |
| `remnic bench export` | Export a stored benchmark result as JSON, CSV, or HTML |
| `remnic bench providers discover` | Auto-detect local provider backends |
| `remnic bench publish --target remnic-ai` | Build the Remnic.ai benchmark feed from stored results |

Run `remnic --help` for the full command list.

Offline mode is intended for laptops that need Remnic on flights, cruises, or
other disconnected stretches. Point agents at the laptop daemon, then run
`remnic offline watch` to sync with the home daemon whenever it is reachable.
See [Offline Mode](../../docs/guides/offline-mode.md).

## Benchmarks

The phase-1 benchmark surface is exposed through `remnic bench`, with `remnic benchmark`
kept as a compatibility alias.

```bash
remnic bench list
remnic bench run --quick longmemeval --runtime-profile baseline
remnic bench datasets status
remnic bench datasets download longmemeval
remnic bench datasets download --all
remnic bench runs list
remnic bench runs show candidate-run --detail
remnic bench runs delete candidate-run
remnic bench run --quick longmemeval
remnic bench run longmemeval --dataset-dir ~/datasets/longmemeval
remnic bench run longmemeval --runtime-profile real --remnic-config ~/.config/remnic/config.json
remnic bench run longmemeval --runtime-profile real --system-provider openai --system-model gpt-5.4-mini
remnic bench run longmemeval --runtime-profile openclaw-chain --openclaw-config ~/.openclaw/openclaw.json --gateway-agent-id memory-primary
remnic bench run longmemeval --matrix baseline,real,openclaw-chain
remnic bench compare base-run candidate-run
remnic bench baseline save main candidate-run
remnic bench baseline list
remnic bench export candidate-run --format csv --output ./candidate.csv
remnic bench export candidate-run --format html --output ./report.html
remnic bench providers discover
remnic bench publish --target remnic-ai
remnic benchmark run --quick longmemeval
```

`--quick` uses the lightweight benchmark path with a single-item limit so you can
smoke-test the harness without running a full benchmark pass. When a benchmark
ships a bundled smoke fixture, `--quick` uses that tracked fixture by default;
full runs need a real benchmark dataset. In a repo checkout the CLI will use
`evals/datasets/<benchmark>` automatically; in packaged installs pass
`--dataset-dir <path>` explicitly.

Package-backed benchmark runs also write `MANIFEST.json` in the results
directory. The manifest records result artifact hashes, dataset file hashes,
fixed seeds, runtime profile/model configuration, git state, QMD collection
names, selected benchmark environment keys, and config-file hashes. Secret
argument values are redacted.

`remnic bench datasets download` currently manages the published benchmark
datasets for `ama-bench`, `memory-arena`, `amemgym`, `longmemeval`, `locomo`,
`beam`, `personamem`, `membench`, and `memoryagentbench`. Internal Remnic
benchmarks keep their bundled or repo-managed fixtures.

## Connecting agents

Once the daemon is running, connect any supported agent:

```bash
remnic connectors install claude-code   # Claude Code (hooks + MCP)
remnic connectors install codex-cli     # Codex CLI (hooks + MCP)
remnic connectors install replit        # Replit (MCP only)
```

All agents share the same memory store.

## License

MIT
