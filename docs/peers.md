# Peers

Remnic has a **peer registry**: a generalization of Remnic's singular
identity-anchor model into a multi-peer schema. Every party that interacts
with a Remnic store — the operator themself, other humans, other agents,
and non-conversational integrations — can be represented as a `Peer` with
an evolving cognitive profile.

Provenance: the peer registry lands across five PRs under issue
[#679](https://github.com/joshuaswarren/remnic/issues/679); this page covers
the complete feature.

> **Command surface.** The `peer` command group runs on the hosted
> `openclaw engram` surface (the OpenClaw gateway / plugin runtime). The
> standalone `remnic` binary does not expose `peer`; use `openclaw engram peer …`
> or the HTTP/MCP surfaces below.

## Concepts

A **peer** is a stable, opaque identity. Each peer has three on-disk
kernel files under `peers/{peer-id}/`:

| File | Purpose | Update cadence | Owner |
|------|---------|----------------|-------|
| `identity.md` | Slow-changing facts: `id`, `kind`, `displayName`, timestamps, free-form notes. | Manual / rare. | Operator. |
| `profile.md` | Evolving cognitive profile derived from session signals. JSON payload inside a fenced block, with per-field provenance. | Background reasoner (async). | Reasoner. |
| `interactions.log.md` | Append-only signal log the reasoner reads. | Per turn / per signal. | Append-only. |

### Peer kinds

`Peer.kind` is one of:

- `self` — the current Remnic operator. Supersedes the legacy
  identity-anchor model; `openclaw engram peer migrate` seeds
  `peers/self/identity.md` from existing legacy data.
- `human` — another human collaborator distinct from `self`.
- `agent` — another AI agent (e.g. Claude Code, Codex, Hermes).
- `integration` — a non-conversational integration that produces signals
  but does not act on its own (cron, webhook, importer).

### Peer ids

`Peer.id` must match `^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$`,
1–64 characters, with no leading/trailing/consecutive separators. The
storage layer validates this on every read and write — `..`, paths with
`/`, and other traversal-ish strings are rejected before any filesystem
operation.

## Registry storage layout

All peer files live under `{memoryDir}/peers/`:

```
{memoryDir}/
└── peers/
    ├── self/
    │   ├── identity.md          # id, kind, displayName, notes
    │   ├── profile.md           # evolving cognitive profile (reasoner-owned)
    │   └── interactions.log.md  # append-only signal log
    ├── alice/
    │   ├── identity.md
    │   └── interactions.log.md
    └── codex-agent/
        ├── identity.md
        ├── profile.md
        └── interactions.log.md
```

The `identity.md` format uses a minimal YAML frontmatter:

```markdown
---
id: "self"
kind: self
displayName: "Self"
createdAt: "2026-04-27T00:00:00.000Z"
updatedAt: "2026-04-27T00:00:00.000Z"
---

## Migrated from identity-anchor.md

...operator identity notes...
```

All string values are double-quoted with `\\` and `\"` escapes. Timestamps
are bare ISO-8601 strings. The body after the closing `---` is free-form
markdown.

## Profile reasoner

The async profile reasoner runs inside the Dreams REM phase. It reads recent
`interactions.log.md` entries and derives structured `profile.md` fields with
provenance. Each field records:

- `observedAt` — ISO-8601 timestamp of the observation.
- `signal` — the log entry text that drove the inference.
- `sourceSessionId` — (optional) originating session.
- `note` — (optional) free-form reasoner annotation.

The reasoner is **disabled by default** and must be opted in via
`peer.profileReasoner.enabled: true` in the plugin config.

## Recall integration

The peer registry wires into the recall pipeline. When a peer is registered
for the active session (`orchestrator.setPeerIdForSession`), Remnic injects a
brief excerpt from that peer's `profile.md` into the prompt context as a
`## Peer Profile` section.

### Recall X-ray annotation

When `xrayCapture: true` is passed to recall, the resulting
`RecallXraySnapshot` includes a `peerProfileInjection` field:

```ts
{
  peerProfileInjection: {
    peerId: "codex-agent",
    fieldsInjected: 2        // number of fields after maxFields cap
  } | null                   // null = no injection (disabled, no peer, no profile)
}
```

- **Non-null** — peer profile was injected; `fieldsInjected` indicates
  how many fields were included after the `peerProfileRecallMaxFields` cap.
- **Explicit `null`** — feature was enabled and a peer was registered, but
  no profile was found or it had no fields.
- **Absent** (`undefined`) — `peerProfileRecallEnabled` was `false` or no
  peer was registered for the session; the field is omitted entirely.

This lets operators correlate recall-quality differences with peer-profile
injection in the X-ray trace.

## CLI commands

All peer commands run on the hosted `openclaw engram peer` surface:

```
openclaw engram peer list [--json]
openclaw engram peer show <id> [--json]
openclaw engram peer set <id> [--kind <kind>] [--display-name <name>] [--notes <text>] [--json]
openclaw engram peer delete <id> [--json]
openclaw engram peer forget <id> --confirm yes [--json]
openclaw engram peer profile <id> [--json]
openclaw engram peer migrate [--dry-run] [--display-name <name>] [--json]
```

### `openclaw engram peer list`

Lists all registered peers. `--json` emits `{ "peers": [...] }`.

### `openclaw engram peer show <id>`

Shows the identity record for a single peer. Exits non-zero when the
peer is not found.

### `openclaw engram peer set <id>`

Creates or updates a peer. On first write, `--kind` sets the peer kind
(default `"human"` when omitted at service layer). On subsequent writes,
`kind` is immutable — pass `--display-name` or `--notes` to update those
fields instead.

### `openclaw engram peer delete <id>`

Removes `peers/{id}/identity.md`. The peer directory and companion files
(`profile.md`, `interactions.log.md`) are left in place. Idempotent:
returns a no-op result when the peer does not exist.

### `openclaw engram peer forget <id> --confirm yes`

**DESTRUCTIVE.** Purges the entire peer directory — `identity.md`,
`profile.md`, `interactions.log.md`, and any other companion files under
`peers/{id}/`. All data is permanently removed.

```
openclaw engram peer forget <id> --confirm yes [--json]
```

Requires `--confirm yes` exactly. Any other value (or omitting the flag)
aborts the command with a non-zero exit code and prints a usage error.

**Properties:**

- **Idempotent** — if the peer directory does not exist the command returns
  a no-op result (`{ ok: true, purged: false }`) rather than erroring.
- **Safe to run twice** — second call after a successful purge is a no-op.
- **All-or-nothing** — uses `fs.rm({ recursive: true })` so the OS handles
  partial-directory state atomically; no file-by-file manual cleanup.

**Contrast with `peer delete`:** `peer delete` only removes `identity.md`
and leaves the peer directory and companion files intact (useful when you
want to de-register a peer identity without losing its interaction history).
`peer forget` removes everything.

**Example output:**

```
Purged all data for peer "codex-agent".
```

```
Peer "codex-agent" directory not found (no-op).
```

The `--json` flag emits `{ "ok": true, "purged": true|false }`.

#### HTTP surface

```
DELETE /engram/v1/peers/:id?forget=true
Content-Type: application/json

{ "confirm": "yes" }
```

Returns `200 { "ok": true, "purged": true|false }` on success.
Returns `400 { "error": "confirm_required" }` when the body omits
`{ "confirm": "yes" }`.

#### MCP tool

`engram.peer_forget` (also `remnic.peer_forget`):

```json
{ "id": "codex-agent", "confirm": "yes" }
```

Returns `{ "ok": true, "purged": true|false }`. Throws when `confirm` is
absent or not `"yes"`.

### `openclaw engram peer profile <id>`

Prints the evolving cognitive profile for a peer. The profile is written
by the async reasoner; exits non-zero when no profile exists yet.

### `openclaw engram peer migrate`

Migrates legacy identity-anchor data into `peers/self/identity.md`.

```
openclaw engram peer migrate [--dry-run] [--display-name <name>] [--json]
```

**What it reads:**

- `{memoryDir}/identity/identity-anchor.md` — structured sections
  (`## Identity Traits`, `## Communication Preferences`, etc.) written by
  `engram_identity_anchor_update`. Embedded verbatim in `peer.notes` under
  a `## Migrated from identity-anchor.md` label.
- `{memoryDir}/IDENTITY.md` — free-form reflection entries appended by the
  extraction engine. Embedded as a `## Migrated from IDENTITY.md` section.

Both sources are optional. If neither exists, a `self` peer is created
with no notes. Symlinked source files are silently skipped.

**Properties:**

- **Idempotent** — if `peers/self/identity.md` already exists the command
  returns immediately without overwriting.
- **Non-destructive** — legacy files are never deleted. Verify the result
  with `openclaw engram peer show self` before archiving legacy data.
- **`--dry-run`** — computes and prints the proposed peer record without
  writing anything to disk.

**Example output:**

```
Migrated identity-anchor data to peers/self/identity.md.
  Read anchor:  /path/to/memory/identity/identity-anchor.md
```

Legacy identity-anchor files are untouched. Verify the migration result
with `openclaw engram peer show self` before archiving legacy files.

## HTTP and MCP surfaces

The peer registry ships the following HTTP endpoints and MCP tools:

| Surface | HTTP | MCP tool |
|---------|------|----------|
| List peers | `GET /engram/v1/peers` | `engram.peer_list` |
| Get peer | `GET /engram/v1/peers/:id` | `engram.peer_get` |
| Set peer | `PUT /engram/v1/peers/:id` | `engram.peer_set` |
| Delete peer (identity only) | `DELETE /engram/v1/peers/:id` | `engram.peer_delete` |
| Forget peer (full purge) | `DELETE /engram/v1/peers/:id?forget=true` (body: `{"confirm":"yes"}`) | `engram.peer_forget` |
| Get profile | `GET /engram/v1/peers/:id/profile` | `engram.peer_profile_get` |

## Relationship to the legacy identity-anchor

The legacy `engram_identity_anchor_get` and `engram_identity_anchor_update`
MCP tools continue to work unchanged. `identityAnchorUpdate` is now
**deprecated** — the method is preserved for backward compatibility but
will be removed in a future major version. Use `peerSet({ id: "self", ... })`
or `openclaw engram peer set self` to update the self peer going forward.

After running `openclaw engram peer migrate` you can verify with:

```
openclaw engram peer show self
```

And then optionally archive the legacy files:

```
mv ~/.remnic/identity/identity-anchor.md ~/.remnic/identity/identity-anchor.md.bak
```

## Privacy posture

- **Local-only by default.** Peer kernel files are stored under the
  same `memoryDir` tree as the rest of Remnic. They are not synced or
  exported anywhere automatically.
- **No personality inference.** The reasoner only derives profile fields
  from observable signals — explicit preferences, communication-style
  cues, recurring concerns, decision patterns. Sentiment-based or
  affective inference is a non-goal.
- **Provenance everywhere.** Every profile field carries a list of
  `PeerProfileFieldProvenance` entries pointing back to the originating
  session/signal. You can audit exactly why a profile claim exists.
- **Forget is destructive.** Use `openclaw engram peer forget <id> --confirm yes`
  to permanently purge the full peer directory (identity, profile, and
  interaction log). Use `openclaw engram peer delete <id>` to remove only the
  identity kernel while preserving companion files.
- **Capsule export gating.** Capsule export does not include peer profiles
  unless explicitly opted in.
