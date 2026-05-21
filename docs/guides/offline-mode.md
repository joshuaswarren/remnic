# Offline Mode

Offline mode lets a laptop keep using Remnic when the home Remnic daemon is
unreachable, then sync local changes back when the network returns.

The recommended topology is:

1. Run the main Remnic daemon at home.
2. Run a local Remnic daemon on the laptop.
3. Point laptop agents at the laptop daemon, not directly at the home daemon.
4. Run `remnic offline watch` on the laptop to sync with the home daemon over
   Tailscale, hotel Wi-Fi, LAN, or any other reachable route.

With that shape, a laptop can move from home Wi-Fi to sleep to an airplane or a
cruise cabin without reconfiguring agents. If the home daemon is reachable, the
watcher pushes and pulls. If it is not reachable, Remnic stays local and the
watcher retries until the connection comes back.

## Before Travel

Start or verify the home daemon:

```bash
export REMNIC_AUTH_TOKEN=...
remnic daemon start
remnic status
```

On the laptop, install local agent/model support and run a local Remnic daemon:

```bash
remnic init
remnic connectors install pi
remnic daemon start
```

Seed the laptop from the home daemon:

```bash
export REMNIC_OFFLINE_REMOTE_URL="http://home-remnic.tailnet-name.ts.net:4317"
export REMNIC_OFFLINE_TOKEN="$REMNIC_AUTH_TOKEN"
remnic offline prepare --namespace default
```

`prepare` downloads a full snapshot from the remote namespace and writes the
offline sync state under `<memoryDir>/.offline-sync/state/`.

## Stay Synced

Keep this running on the laptop before you leave:

```bash
remnic offline watch --namespace default --interval-ms 60000
```

The watcher performs the same work as `remnic offline sync`:

1. Build a changeset from local files changed since the last shared base.
2. Push that changeset to the remote daemon.
3. Pull the latest remote snapshot.
4. Apply remote changes locally.
5. Update the shared-base state.

Network failures do not clear local state or block local Remnic use. The next
watch iteration tries again.

## Manual Sync

Use `sync` when you want a one-shot transfer:

```bash
remnic offline sync --namespace default
```

Use `status` to see how many local upserts/deletes are pending relative to the
last shared base:

```bash
remnic offline status --namespace default
remnic offline status --namespace default --json
```

## Multiple Namespaces

Sync each namespace independently:

```bash
remnic offline prepare --namespace personal
remnic offline prepare --namespace work
remnic offline watch --namespace personal
remnic offline watch --namespace work --interval-ms 120000
```

The state file key includes the remote identity and namespace, so separate
namespaces do not overwrite each other's sync base.

## Conflict Handling

Offline mode uses a shared-base merge protocol. A file is applied only when the
target side is still at the base version the sender last saw.

If both laptop and home changed the same file, Remnic preserves the local file
and writes the incoming version under:

```text
<memoryDir>/.offline-sync/conflicts/<timestamp>-<source>/<original-path>
```

The sync result reports the conflict path so you can inspect or merge it later.
Remote-side conflicts behave the same way on the home daemon.

## What Syncs

Offline sync operates at the Remnic storage directory layer. That means it works
for core memories, retrieval indices, governance metadata, review queues,
continuity state, and other persisted Remnic files without adding host-specific
fallback logic to OpenClaw, Pi, Codex, Hermes, or future adapters.

By default, transcript files are included. Use `--no-transcripts` when preparing
or syncing a namespace if you want to exclude `transcripts/` from the transfer.

The transfer intentionally excludes private or process-local directories such
as `.secure-store/`, `.offline-sync/`, `.capsules/`, `node_modules/`, and `.git/`.
Auth tokens stay local and must be provisioned separately on each machine.

## Environment Variables

The CLI reads these values when flags are omitted:

```bash
export REMNIC_OFFLINE_REMOTE_URL="http://home-remnic.tailnet-name.ts.net:4317"
export REMNIC_OFFLINE_TOKEN="..."
```

Legacy fallbacks are also accepted:

```bash
export ENGRAM_OFFLINE_REMOTE_URL="http://home-remnic.tailnet-name.ts.net:4317"
export ENGRAM_AUTH_TOKEN="..."
```
