# Operator console (TUI)

The operator console is a live engine-introspection surface for Remnic. It shows
the current state of the engine's pipelines — buffer, extraction queue, dedup
decisions, maintenance ledger tail, QMD probe, and daemon health — as they
happen. It is a **terminal UI**, distinct from the browser-based
[admin console](./admin-console.md); and distinct from [Recall X-ray](./xray.md)
(which inspects *retrieval*) — the operator console inspects the *engine itself*.

The console ships on the OpenClaw-hosted CLI as `openclaw engram console`. There
is no standalone `remnic console` command; standalone deployments read the same
data over the [HTTP endpoint](#http-api) or the [MCP tool](#mcp-tool).

Tracking issue: [#688](https://github.com/joshuaswarren/remnic/issues/688).

## Modes

| Mode | Invocation | What it does |
|------|------------|--------------|
| **Live TUI** (default) | `openclaw engram console` | Interactive five-panel terminal UI that polls the engine every 2 seconds. Press `Ctrl-C` to exit. |
| **One-shot snapshot** | `openclaw engram console --state-only` | Prints a single `ConsoleStateSnapshot` as pretty-printed JSON and exits. Useful for piping into `jq` or external monitoring. |
| **Record trace** | `openclaw engram console --record-trace <path>` | Runs the live TUI **and** appends every refresh-cycle snapshot to `<path>` as JSONL (one frame per line). |
| **Replay trace** | `openclaw engram console --trace <path> [--speed N]` | Replays a previously-recorded JSONL trace at the original cadence. `--speed 2` halves the inter-frame delay; `--speed 0.5` doubles it. EOF exits cleanly. |

## Trace recording

`--record-trace <path>` opens the file in append mode (parent directory is
created with `mkdir -p`) and writes one `ConsoleStateSnapshot` per line,
separated by `\n`. Each line is a self-contained JSON object — you can `jq -c`
over the file or stream it into another tool.

A trace recorder failure (disk full, permission denied) **never** crashes the
live TUI. Errors are captured internally and surfaced via the recorder's
`getLastError()` accessor; the loop keeps painting.

```bash
# Record a trace while you reproduce a problem.
openclaw engram console --record-trace ~/.remnic/traces/2026-04-26.jsonl

# Inspect a few frames manually.
head -3 ~/.remnic/traces/2026-04-26.jsonl | jq .

# Hand the file to another operator for asynchronous review.
```

## Trace replay

`--trace <path>` reads the JSONL file frame-by-frame and feeds each snapshot into
the same `renderFrame` function the live TUI uses. Replay is fully sandboxed: no
orchestrator instance is required, no filesystem reads beyond the trace file
itself.

The inter-frame delay is computed from the captured `capturedAt` timestamps (so a
trace originally captured at 2 Hz replays at 2 Hz), divided by the `--speed`
multiplier:

```bash
# Replay at original cadence.
openclaw engram console --trace trace.jsonl

# Replay 4x faster.
openclaw engram console --trace trace.jsonl --speed 4

# Replay slowly enough to step through visually.
openclaw engram console --trace trace.jsonl --speed 0.25
```

Edge cases:

- **Malformed lines** (invalid JSON, `null` literal, array literal) are skipped.
  The replay summary reports `framesSkipped`.
- **Negative deltas** (timestamps that go backward) are clamped to zero — the
  next frame paints immediately.
- **Pathologically long gaps** (hour-long pauses in the captured trace) are
  capped at 60 seconds so a tester always sees forward progress.
- **`--speed Infinity`** is permitted and means "no delay" — frames paint
  back-to-back.

## On-disk trace format

Each line of a trace file is the full JSON-serialized `ConsoleStateSnapshot`
produced by `gatherConsoleState`
(`packages/remnic-core/src/console/state.ts`):

```json
{
  "capturedAt": "2026-04-26T15:23:01.512Z",
  "bufferState": { "turnsCount": 4, "byteCount": 312 },
  "extractionQueue": { "depth": 0, "recentVerdicts": [] },
  "dedupRecent": [],
  "maintenanceLedgerTail": [],
  "qmdProbe": { "available": true, "daemonMode": true, "debug": "..." },
  "daemon": { "uptimeMs": 9421000, "version": "9.6.22" },
  "errors": []
}
```

The schema is intentionally identical to the `--state-only`, HTTP, and MCP
responses, so the same trace file can be post-processed with the same tooling.

## HTTP API

```
GET /engram/v1/console/state[?namespace=<ns>]
```

Returns a single `ConsoleStateSnapshot` as JSON. Same schema as `--state-only`
and the MCP tool below. Requires a valid bearer token. The standalone server
binds `127.0.0.1:4318` by default.

```bash
curl -H "Authorization: Bearer $REMNIC_TOKEN" \
  http://127.0.0.1:4318/engram/v1/console/state | jq .
```

| Parameter | Description |
|-----------|-------------|
| `namespace` | Optional namespace scope. Defaults to the authenticated principal's namespace. |

Response shape is identical to the snapshot format shown in
[On-disk trace format](#on-disk-trace-format) above.

## MCP tool

`remnic.console_state` (canonical) / `engram.console_state` (legacy alias).

```json
{
  "name": "remnic.console_state",
  "arguments": {
    "namespace": "optional-namespace"
  }
}
```

Returns the same `ConsoleStateSnapshot` JSON. Useful for operator agents that
want to query engine health without shelling out to the CLI.

## Console vs admin console

| | Operator console (this page) | [Admin console](./admin-console.md) |
| --- | --- | --- |
| **Kind** | Terminal UI (TUI) | Browser UI (static HTML/JS shell) |
| **Focus** | Live engine internals: buffer, extraction queue, dedup, maintenance, QMD probe, daemon | Memory browser, recall debugger, trust zones, review queue, entity/graph explorers |
| **Launch** | `openclaw engram console` | HTTP access server at `/remnic/ui/` |
| **Data endpoint** | `GET /engram/v1/console/state` | the full `/engram/v1/*` operator API |

## Source

| File | Role |
|------|------|
| `packages/remnic-core/src/console/state.ts` | Engine-state aggregator (issue #688 / [#721](https://github.com/joshuaswarren/remnic/pull/721)). |
| `packages/remnic-core/src/console/tui.ts` | Live TUI render loop ([#728](https://github.com/joshuaswarren/remnic/pull/728)). |
| `packages/remnic-core/src/console/trace.ts` | Trace record + replay. |
