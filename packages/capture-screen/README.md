# @remnic/capture-screen

Local loopback daemon for replaying and serving screen-text snapshots to Remnic activity sources.

It stores snapshots in SQLite and exposes authenticated, cursor-paginated HTTP endpoints:

- `GET /v1/health`
- `GET /v1/snapshots?date=<YYYY-MM-DD>&timezone=<IANA>&cursor=<token>&limit=<1-500>` — `date` and `timezone` are required; `cursor` is the opaque keyset token returned by the previous page (not a raw row id).
- `GET /v1/stats?date=<YYYY-MM-DD>&timezone=<IANA>` — per-app time attribution for the day.

The daemon binds only to `127.0.0.1`, `::1`, or `localhost`.

## Run a replay fixture

```sh
export REMNIC_CAPTURE_TOKEN="…"   # bearer token, read from the environment
remnic-capture-screen \
  --spool ./capture.sqlite \
  --replay ./snapshots.json
```

The bearer token is read from the `REMNIC_CAPTURE_TOKEN` environment variable (legacy `ENGRAM_CAPTURE_TOKEN` also accepted), never a CLI flag: a long-lived daemon's argv is world-readable via `ps` / `/proc` on a multi-user host. Passing `--auth-token` is rejected.

`snapshots.json` contains an array of objects with `capturedAtUtc` (ISO-8601 UTC), `app`, `windowTitle`, `text`, and `textSource` (`"ax"` or `"ocr"`) fields. Each served snapshot also carries the stored `contentHash`, so the core activity client can ingest it. Exact replays deduplicate by the complete snapshot payload.

The daemon does not acquire native screenshots. Native platform helpers send redacted text snapshots to this daemon over its loopback API.

The `--spool` file must live in an owner-only directory: the daemon requires its parent to be a non-symlink directory you own with mode `0700` (no group/other access) and creates it `0700` when absent, so no other local user can plant a symlink at the spool path. The SQLite file itself is created `0600`. Point `--spool` at a dedicated directory such as `~/.local/state/remnic/capture/`.
