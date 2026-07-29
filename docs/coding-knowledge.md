# Coding knowledge (Track A)

Issue [#1548](https://github.com/joshuaswarren/remnic/issues/1548) Track A
ships durable, project-scoped coding knowledge inside `@remnic/core` with no
new dependencies. Four memory-shaped features live under the `coding/`
directory; this document is the single source of truth for what is
implemented today.

> One-source rule (#1527): namespace scoping, `resolveGitContext`, and the
> file-path **review-context** recall tier are documented in
> [Coding agent mode](coding-agent.md) and are not repeated here. Track A
> composes with those surfaces; it does not redefine them.

The features, all gated by the `codingKnowledge` config block:

1. [Decision records](#decision-records) — standing architectural decisions
   with a status lifecycle.
2. [Architecture card](#architecture-card) — a deterministic, versioned
   per-project overview.
3. [Session delta](#session-delta) — "since you last worked here: N commits,
   these files."
4. [Structural provider (reserved)](#structural-provider-reserved) — the
   config knob for symbol-anchored review-intent recall; the provider modules
   ship in [#1754](https://github.com/joshuaswarren/remnic/pull/1754) (in progress).

## Gate contract

Every Track A surface obeys one rule: with the master gate off, behaviour is
byte-for-byte identical to the pre-feature codebase on MCP `tools/list`, HTTP
route registration, the briefing, recall, and the state directory (nothing is
created). The per-feature switches are effective **only** under the master
gate.

Each feature has a single gate predicate, checked identically on every
transport. The MCP `tools/list` visibility check evaluates the config-level
conditions (master gate + feature switch) at construction time; the call-time
gate re-checks those conditions **plus** a coding context (decision records,
the architecture card, and the session delta all live *in* the coding
namespace — [rule 42](coding-agent.md#overview)).

## Config surface

`codingKnowledge` is a nested object in the plugin config, parsed by
[`coding/coding-knowledge-config.ts`](../packages/remnic-core/src/coding/coding-knowledge-config.ts).
Defaults are declared in `CODING_KNOWLEDGE_DEFAULTS` and exercised by a
deep-equal characterization test so the schema and the docs cannot drift.

| Key | Default | Behavior |
|-----|---------|----------|
| `codingKnowledge.enabled` | `false` | Master gate. Off = pre-feature behaviour on every path. |
| `codingKnowledge.decisionRecords` | `true` | Advertises the `engram.coding_decision` MCP tool + HTTP route (under the master gate). |
| `codingKnowledge.architectureCard` | `true` | Advertises the `engram.coding_architecture` MCP tool + HTTP route. |
| `codingKnowledge.sessionDelta` | `true` | Advertises the `engram.coding_delta` MCP tool + HTTP route. |
| `codingKnowledge.preActionGate` | `false` | Pre-action failure gate check (under the master gate). |
| `codingKnowledge.architectureCardLlmSummary` | `false` | Opt-in LLM summary pass on the architecture card (costs tokens). |
| `codingKnowledge.structuralProvider` | `"none"` | `"none" \| "subprocess" \| "native"`. See [Structural provider (reserved)](#structural-provider-reserved). |
| `codingKnowledge.structuralProviderCommand` | `""` | Absolute path to the subprocess provider binary (used only when `structuralProvider = "subprocess"`). |
| `codingKnowledge.codegraphTools` | `false` | Gate for the 14 codegraph parity tools. See [Coding graph (Track B)](coding-graph.md). |
| `codingKnowledge.codegraphDbDir` | `""` | Root for per-project graph SQLite DBs. Empty = derive from `memoryDir`. |

Boolean values are coerced at the parse boundary (so `--config
codingKnowledge.enabled=false` arrives as `false`, not a truthy string). An
unknown `structuralProvider` value is rejected listing the valid options
(rule 51 — silent defaulting is a contract lie). Configuration is set via the
plugin config object (`openclaw.json`); per-key `REMNIC_*` / `ENGRAM_*` environment
overrides are **not** wired for `codingKnowledge` today — set the keys in the plugin
config, not via env vars.

The type lives in
[`packages/remnic-core/src/types.ts`](../packages/remnic-core/src/types.ts)
(`CodingKnowledgeConfig`).

## Decision records

Standing architectural decisions stored as markdown + YAML frontmatter under
the coding namespace, so QMD hybrid search finds them for free and the normal
persist pipeline fires catalog recording, reindex, and dedup (no direct `fs`
writes of memory content).

Pure contract: [`coding/decision-records.ts`](../packages/remnic-core/src/coding/decision-records.ts).
Surfaces: [`coding/decision-surfaces.ts`](../packages/remnic-core/src/coding/decision-surfaces.ts).

### Record shape

```text
id            stable identifier (typically ADR-XXXX); must be unique
title         one-line summary surfaced in briefings and `list` output
status        "proposed" | "accepted" | "superseded" | "rejected"
context       the problem / context the decision addresses
decision      the decision itself
consequences  trade-offs, follow-ups (optional, free-form)
entityRefs    entity ids / doc anchors / code paths (may be empty)
supersedes    the record this one replaces (set by `supersede`, never by hand)
```

Status lifecycle:

- `ACTIVE_DECISION_STATUSES = { "proposed", "accepted" }` — the statuses
  surfaced in standing-decisions lists and briefing titles. `superseded` and
  `rejected` are intentionally excluded; the `supersedes` edge tells callers
  what to fall back to.
- A record whose frontmatter omits `status` defaults to `"proposed"`, never
  `"accepted"` (rule 48 — accepting a decision is a deliberate action).
- `supersede(a → b)` writes `b` to disk **before** flipping `a.status` to
  `"superseded"` (rule 25 — a crash between the two writes leaves the new
  decision discoverable, not nothing).

### Surfaces

All three transports dispatch through the `coding_decision` boundary
operation, which calls one shared handler. Invalid subcommands throw listing
the valid options; an unknown decision id returns an explicit not-found, never
an empty success.

| Transport | Surface |
|-----------|---------|
| MCP tool | `engram.coding_decision` (alias `remnic.coding_decision`) |
| HTTP route | `POST /engram/v1/coding/decisions` |
| MCP `tools/list` visibility | advertised only when `enabled && decisionRecords` |

Subcommands: `list`, `get`, `record`, `supersede`.

MCP tool call (option 1 — `record` a new decision). The handler ignores any
caller-supplied `id` and generates its own canonical id; the response returns
`{ memoryId, status }`, and that `memoryId` is what `get`/`supersede` use later:

```json
{
  "tool": "engram.coding_decision",
  "subcommand": "record",
  "sessionKey": "string",
  "title": "Use web-tree-sitter, not native bindings",
  "status": "accepted",
  "context": "Native node-tree-sitter repeats the better-sqlite3 binding pain.",
  "decision": "Adopt web-tree-sitter (WASM) grammars.",
  "consequences": "~2-3x slower parsing; measured by the bench harness.",
  "entityRefs": ["packages/coding-graph"]
}
```

MCP tool call (option 2 — `supersede`). `id` (or its alias `supersedesId`)
names the **existing** record being retired; the replacement is built from
`title`/`decision`/`context`. The response returns
`{ supersededMemoryId, replacementMemoryId }`:

```json
{
  "tool": "engram.coding_decision",
  "subcommand": "supersede",
  "sessionKey": "string",
  "id": "decision-a1b2c3",
  "title": "Use native bindings after all",
  "context": "Benchmarks showed parsing was the bottleneck.",
  "decision": "Switch to native node-tree-sitter."
}
```

HTTP equivalent:

```bash
curl -s -X POST http://127.0.0.1:4318/engram/v1/coding/decisions \
  -H "Authorization: Bearer $REMNIC_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"subcommand":"list","sessionKey":"string"}'
```

## Architecture card

A compact, byte-stable markdown overview of a repository: known manifests,
top-level directories, a language histogram by extension, and entry points
derived from manifests. The deterministic card is useful on its own; an
optional LLM summary pass (gated by `architectureCardLlmSummary`) can prepend
a human-readable overview using the existing extraction engine — on LLM
failure the deterministic card ships unchanged (rule 13).

Pure builder: [`coding/architecture-card.ts`](../packages/remnic-core/src/coding/architecture-card.ts).
Surfaces: [`coding/architecture-surfaces.ts`](../packages/remnic-core/src/coding/architecture-surfaces.ts).

### Properties

- **Byte-stable** — every multi-value field is sorted before serialising, so
  two runs over the same fixture produce byte-identical output (rule 38).
- **Size-capped** — `ARCHITECTURE_CARD_MAX_BYTES = 4096`. When the card
  exceeds the cap it is truncated with a visible marker
  (`ARCHITECTURE_CARD_TRUNCATION_MARKER`) so consumers know information was
  elided (rule 34 — never silently incomplete).
- **LLM summary capped** — the summary prefix is clamped to
  `ARCHITECTURE_CARD_MAX_SUMMARY_BYTES = 1024` so a misbehaving summariser
  cannot crowd out the deterministic sections.
- **Privacy + speed** — file *contents* are never read except for manifest
  files.
- **Versioned** — each refresh snapshots the prior content via
  `page-versioning.ts` before overwriting (rule 25), giving snapshot/diff/
  revert for free.

Known manifest files the scanner parses for project metadata and entry
points: `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `setup.py`,
`pom.xml`, `build.gradle`, `build.gradle.kts`, `Gemfile`, `composer.json`,
`mix.exs`, `deno.json`. Directories skipped by the scanner (`node_modules`,
`.git`, `vendor`, `dist`, `build`, `__pycache__`, venvs, …) are declared in
`SCAN_IGNORE_DIRS`.

### Surfaces

| Transport | Surface |
|-----------|---------|
| MCP tool | `engram.coding_architecture` (alias `remnic.coding_architecture`) |
| HTTP route | `POST /engram/v1/coding/architecture` |
| MCP `tools/list` visibility | advertised only when `enabled && architectureCard` |

Subcommands: `get` (return the current card or not-found), `refresh` (build a
fresh card from the repo, snapshot the prior version, persist it).

MCP tool call:

```json
{
  "tool": "engram.coding_architecture",
  "subcommand": "refresh",
  "sessionKey": "string"
}
```

## Session delta

Tells a returning agent what changed since the last session in the same coding
namespace: commits, touched files, and a one-line summary. The differ is a
pure function over a `GitLogSlice`; the caller supplies the slice from a real
git invoker (reusing the 2-second-per-call timeout discipline from
`coding/git-context.ts`).

Pure differ: [`coding/session-delta.ts`](../packages/remnic-core/src/coding/session-delta.ts).
Surfaces: [`coding/session-delta-surfaces.ts`](../packages/remnic-core/src/coding/session-delta-surfaces.ts).

### Behaviour

- The `get` subcommand computes the delta against the persisted last-seen head
  **and** updates the marker in the same call, so the *next* session sees this
  one as the baseline.
- A first session (no prior state) produces no delta section **and** initialises
  the state — it never claims "0 changes".
- An unchanged repo (prior head == current head) suppresses the "no changes"
  line rather than rendering it.
- A prior head missing from the repo (force-push/rebase) is surfaced as a
  tagged `{ ok: false, code: "unreachable_head" }` outcome handled as "delta
  unavailable", never a crash.
- Results are capped (`MAX_DELTA_COMMITS`, `MAX_DELTA_FILES`; the `slice(-n)`
  caps guard against `n === 0` — rule 27). The uncapped commit total is also
  reported so summaries never under-report on large repos.
- State writes are temp-file-then-rename (rule 54) and the new last-seen-head
  is persisted **after** the delta is computed from the old one (rule 25).
- State location: `<memoryDir>/state/coding-knowledge/<sanitized-namespace>.json`
  (the namespace is already sanitized by the coding-namespace router;
  `sanitizeFragment` is reused defensively).

### Surfaces

| Transport | Surface |
|-----------|---------|
| MCP tool | `engram.coding_delta` (alias `remnic.coding_delta`) |
| HTTP route | `POST /engram/v1/coding/delta` |
| MCP `tools/list` visibility | advertised only when `enabled && sessionDelta` |

Subcommand: `get` (read-only semantically; it mutates only the operator-side
state file, which is uncounted bookkeeping — the same way `calibration.ts`
writes are uncounted).

MCP tool call:

```json
{
  "tool": "engram.coding_delta",
  "subcommand": "get",
  "sessionKey": "string"
}
```

## Structural provider (reserved)

The `structuralProvider` knob selects how review-intent recall expands a diff
to affected *symbols* (not just file paths). It is the architectural boundary
between Track A and the native [coding-graph engine](coding-graph.md) (Track
B): the native engine (`"native"`) and an external binary (`"subprocess"`)
are both providers of the same port.

| Value | Behavior |
|-------|----------|
| `"none"` (default) | No provider consulted. Review-intent recall runs **file-path-only** boosting, identical to the [review-context tier](coding-agent.md#review-context-recall-tier) shipped in #569. |
| `"subprocess"` | Reserved: shell out to `structuralProviderCommand` via `execFile` (argv array, never a shell string). |
| `"native"` | Reserved: adapt the `@remnic/coding-graph` engine to the port. |

The config field is parsed and validated today; the provider modules
themselves (the port interface, the subprocess provider, the native adapter)
ship in [#1754 (in progress)](https://github.com/joshuaswarren/remnic/pull/1754). **Until then, review-intent recall is file-path-only
regardless of this setting** — setting `structuralProvider` to `"subprocess"`
or `"native"` is accepted by the parser but has no effect on recall. This is
documented honestly rather than implied.

## Diagnostics

`remnic doctor` renders the effective coding scope (see
[Coding agent mode](coding-agent.md#remnic-doctor-output)). The three Track A
features are accessed through their [MCP tools and HTTP routes](#gate-contract)
today; automatic injection of the architecture card, session-delta line, and
decision titles into the daily briefing is reserved for a follow-up PR (the
design calls for a single `buildCodingKnowledgeBriefingSection` injection
helper so future additions have one chokepoint). With the master gate off,
behaviour is byte-identical to pre-feature on every path.

## Related reading

- [Coding agent mode](coding-agent.md) — namespace scoping, `resolveGitContext`,
  and the file-path review-context recall tier Track A composes with.
- [Coding graph (Track B)](coding-graph.md) — the native codebase-graph engine;
  `manage_adr` and `get_architecture` compose Track A's records and card with
  live graph stats.
- [`packages/remnic-core/src/coding/`](../packages/remnic-core/src/coding/) —
  the pure modules and their contract tests.
