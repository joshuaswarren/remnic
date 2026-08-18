# CLI reference

The complete reference for the standalone `remnic` command-line interface. Every command here is part of the `@remnic/cli` package and runs against your local memory store — no account, no cloud. For the OpenClaw-hosted `openclaw engram` surface, see [OpenClaw-hosted commands](#openclaw-hosted-commands) at the end.

## Install

```bash
npm install -g @remnic/cli
```

This installs two binaries: `remnic` (canonical) and `engram` (a legacy forwarder kept during the rename window — every command below works under either name). You can pin the binary the auto-runner uses with `REMNIC_CLI_BIN` (or the legacy `ENGRAM_CLI_BIN`).

New to Remnic? Start with the [quickstart](guides/quickstart.md), then come back here for the full command surface.

## Conventions

- Most commands accept `--json` for machine-readable output.
- Configuration is resolved in this order:
  1. `REMNIC_CONFIG_PATH` environment variable (`ENGRAM_CONFIG_PATH` is still honored during the compatibility window)
  2. `./remnic.config.json` in the current directory
  3. `~/.config/remnic/config.json` (default)
- Placeholders use `<angle-brackets>`. Optional arguments use `[square-brackets]`.
- Run any command with `--help` for its full option list.

Remnic ships 35 top-level command names (`benchmark` is a compatibility alias of `bench`), grouped below by what you reach for them.

## Setup & health

| Command | What it does |
|---------|--------------|
| `remnic init` | Create `remnic.config.json` in the current directory |
| `remnic migrate [--rollback] [--json]` | Run — or with `--rollback`, undo — the first-run Engram-to-Remnic migration |
| `remnic status [--json]` | Show server/daemon status and health |
| `remnic doctor` | Diagnose the install (Node version, config, API key, memory dir, daemon) |
| `remnic config` | Print the resolved configuration |
| `remnic daemon <start\|stop\|restart\|install\|uninstall\|status>` | Manage the background HTTP server. `install`/`uninstall` register or remove the OS service; `start`/`stop`/`restart`/`status` control a running one |
| `remnic token <generate\|list\|revoke> [connector-id]` | Manage bearer tokens for the access server |
| `remnic onboard [dir] [--json]` | Analyze a project directory (language detection, doc discovery, ingestion plan) |

```bash
remnic init
remnic daemon start
remnic status
remnic doctor
```

## Daily use

| Command | What it does |
|---------|--------------|
| `remnic query <text> [--json] [--explain]` | Query memories. `--explain` adds a per-tier latency and source breakdown |
| `remnic xray <query> [--format text\|markdown\|json] [--budget <chars>] [--namespace <ns>] [--out <path>]` | Run a recall with X-ray capture and print the unified tier + audit + MMR + filter snapshot |
| `remnic briefing [--since <window>] [--focus <filter>] [--save] [--format markdown\|json]` | Generate a daily context briefing |
| `remnic review <list\|approve\|dismiss\|flag> [id]` | Manage the review inbox |
| `remnic curate <path> [--json]` | Curate files into memory with duplicate and contradiction detection |
| `remnic sync <run\|watch> [--source <dir>]` | Diff-aware filesystem sync into memory |
| `remnic dedup [--json]` | Find duplicate memories |
| `remnic tree <generate\|watch\|validate> [--output <path>] [--categories <list>] [--max-per-category <n>] [--no-entities] [--no-questions] [--json]` | Build and validate the workspace context tree |

`remnic query` is the everyday entrypoint. Use `--explain` to see where a slow answer spends its time:

```bash
remnic query "what did we decide about the pricing model?" --explain
```

`remnic briefing` windows accept `yesterday`, `today`, `NNh`, `NNd`, or `NNw`; focus filters accept `person:<name>`, `project:<name>`, or `topic:<name>`:

```bash
remnic briefing --since 7d --focus project:acme-webshop --format markdown --save
```

## Connectors & integrations

| Command | What it does |
|---------|--------------|
| `remnic connectors <list\|install\|remove\|doctor\|marketplace\|status\|run> [id]` | Manage host adapters and live connectors |
| `remnic openclaw <install\|upgrade\|migrate-engram>` | Wire Remnic into OpenClaw, upgrade the plugin, or migrate a legacy `openclaw-engram` install |
| `remnic oauth <pending\|approve\|deny> [--format <fmt>] [--yes]` | Manage pending OAuth authorizations (used by the ChatGPT MCP connector) |
| `remnic wearables <status\|check\|sync\|transcript\|search\|memories\|speakers\|corrections\|fuse\|fused>` | Pull, clean, and store wearable transcripts (Limitless / Bee / Omi) |
| `remnic location <status\|check\|sync\|backfill\|day>` | Location day sync from registered providers (issue #2047; e.g. a self-hosted Reitti instance) |

`connectors install <id>` writes the config a host tool needs to talk to Remnic. Built-in adapter ids include `claude-code`, `codex-cli`, `cursor`, `cline`, `github-copilot`, `roo-code`, `windsurf`, `amp`, `pi`, `omp`, `replit`, `generic-mcp`, `weclone`, and `hermes`. `connectors status` and `connectors run` operate on *live* connectors (background sync sources) rather than host adapters. `connectors marketplace <generate|validate|install>` manages Codex marketplace manifests.

```bash
remnic connectors list
remnic connectors install claude-code
remnic connectors status
```

`remnic openclaw` subcommands take the usual safety flags: `--yes`/`--force` to skip prompts, `--dry-run` to preview, plus `--memory-dir`, `--config`, `--version`, `--plugin-dir`, `--legacy-plugin-dir`, and `--no-restart`.

`remnic wearables speakers` has its own `list|self|set|remove` actions and `corrections` has `list|add|remove`; `fuse`/`fused` merge and read cross-source fused transcripts for a day. Each source ships as an à la carte connector package (for example `npm install @remnic/connector-limitless`).

`remnic location` runs the same shared runner as the MCP/HTTP location surfaces. Credentials for built-in providers come from the environment (`REITTI_BASE_URL`, `REITTI_TOKEN`, optional `REITTI_AUTH_MODE=x-api-token|bearer`); an absent provider package reports `provider-not-registered` instead of failing. `sync` covers `location.syncDays` ending yesterday (or `--date`/`--days`), `backfill --from --to` is capped at 90 days, and coordinates are never stored or printed unless `location.retainCoordinates` is enabled.

## Memory management

| Command | What it does |
|---------|--------------|
| `remnic space <list\|switch\|create\|delete\|push\|pull\|share\|promote\|audit>` | Manage personal, project, and team memory spaces. `create` accepts `--parent <id>` |
| `remnic versions <list\|show\|diff\|revert> <page-path> [id] [--json]` | Page-level version history: list, show, diff, or revert snapshots |
| `remnic taxonomy <show\|resolver\|add\|remove\|resolve>` | Manage the MECE knowledge-directory taxonomy. `add <id> <name>`, `remove <id>`, `resolve <text> [--category <cat>]` |
| `remnic enrich <entity-name\|--all\|--dry-run\|audit\|providers>` | Run the external entity-enrichment pipeline |
| `remnic procedural stats [--format json\|text] [--memory-dir <path>]` | Print procedural-memory stats (counts, recency, config) |
| `remnic capsule <fork\|lineage>` | Fork a portable capsule archive into a memory root, or print a fork's lineage breadcrumb |
| `remnic offline <prepare\|sync\|status\|watch>` | Remote/offline memory sync |
| `remnic action-confidence [--action <text>] [--confidence <0-1>] [--risk <level>] [--context <readiness>]` | Evaluate the read-only ask/draft/act/refuse/escalate advisory policy |

`remnic capsule` is the portability entrypoint:

```bash
remnic capsule fork <archive.capsule.json.gz> --target <memory-dir> --fork-id <id>
remnic capsule lineage --fork-id <id> --root <memory-dir>
```

## Import & export

| Command | What it does |
|---------|--------------|
| `remnic import --adapter <name> --file <path> [--dry-run] [--batch-size <n>]` | Import from a supported export file |
| `remnic import-lossless-claw --src <path> [--dry-run] [--session-filter <id>]` | Migrate a lossless-claw LCM database into Remnic's LCM mode |
| `remnic training:export --format <name> --output <path>` | Export memories as a fine-tuning dataset |

`remnic import --adapter` supports exactly these adapters: `chatgpt`, `claude`, `gemini`, `mem0`, and `supermemory`. WeClone is not an import adapter — it is hosted-only via `openclaw engram bulk-import --source weclone`. Lossless-claw has its own dedicated `remnic import-lossless-claw` command above.

```bash
remnic import --adapter chatgpt --file ./conversations.json --dry-run
```

## Advanced & research

| Command | What it does |
|---------|--------------|
| `remnic bench <action> [benchmark...]` | Run and manage benchmarks (alias: `remnic benchmark`) |
| `remnic binary <scan\|status\|run\|clean>` | Binary-file lifecycle: `scan`, `status`, `run [--dry-run]`, `clean --force` |
| `remnic extensions <list\|show\|validate\|reload>` | Manage memory extensions |

`bench` actions: `list`, `run`, `datasets` (`download`/`status`), `runs` (`list`/`show`/`delete`), `compare`, `results`, `baseline` (`save`/`list`), `export`, `publish`, `published`, `judge-calibrate`, `ui`, `providers` (`discover`). The `check` and `report` actions run under the `benchmark` alias. `published` and `judge-calibrate` are maintainer tools for the published-benchmark harness.

```bash
remnic bench list
remnic bench run --quick
```

`remnic extensions reload` is a reserved no-op (extension caching is not yet implemented); the other actions are live. See the [benchmarking guide](benchmarks.md) for the full `bench` workflow.

## OpenClaw-hosted commands

When Remnic runs inside OpenClaw, the gateway registers a single top-level `engram` command whose children are the deeper memory-operations surface — roughly 100 subcommands invoked as `openclaw engram <command>`. This surface is intentionally separate from the standalone `remnic` binary: it is the operator and maintenance toolkit that runs against the gateway's live orchestrator. There is no `openclaw remnic` namespace; inside a chat session the plugin exposes the `/remnic <on|off|status|clear|stats|flush>` session command instead.

Most-used `openclaw engram` commands:

```bash
openclaw engram stats                 # memory counts, buffer state, QMD status
openclaw engram search "<query>"      # search memories from the terminal
openclaw engram recall "<query>"      # run a full recall
openclaw engram doctor                # diagnose the hosted install
openclaw engram export                # export memories to a portable file
openclaw engram import                # import from a portable file
openclaw engram backup                # snapshot the memory directory
openclaw engram purge                 # delete memories (guarded)
openclaw engram access http-serve     # start the HTTP access surface
openclaw engram access mcp-serve      # start the MCP access surface
openclaw engram access-stats          # most-accessed memories report
openclaw engram bulk-import --source weclone
```

Note the distinction: `access` is the group that manages the HTTP and MCP access surfaces (`http-serve`, `http-stop`, `http-status`, `mcp-serve`), while `access-stats` is the separate most-accessed-memories report.

Beyond these, the hosted surface covers namespaces, capsules, trust zones, dreams, peers, secure-store, governance, review, continuity, the work layer (`task`/`project`), and the research and creation-ledger command families. The [operations guide](operations.md) documents the operator workflows, and [API reference — CLI commands](api.md#cli-commands) is the full `openclaw engram` command table.
