# @remnic/capture-screen

Local loopback daemon for replaying and serving screen-text snapshots to Remnic activity sources.

It stores snapshots in SQLite and exposes authenticated, cursor-paginated HTTP endpoints:

- `GET /v1/health`
- `GET /v1/snapshots?cursor=<id>&limit=<1-500>`

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
