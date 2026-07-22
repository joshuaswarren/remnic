# @remnic/capture-screen

Local loopback daemon for replaying and serving screen-text snapshots to Remnic activity sources.

It stores snapshots in SQLite and exposes authenticated, cursor-paginated HTTP endpoints:

- `GET /v1/health`
- `GET /v1/snapshots?cursor=<id>&limit=<1-500>`

The daemon binds only to `127.0.0.1`, `::1`, or `localhost`.

## Run a replay fixture

```sh
remnic-capture-screen \
  --auth-token "$REMNIC_CAPTURE_TOKEN" \
  --spool ./capture.sqlite \
  --replay ./snapshots.json
```

`snapshots.json` contains an array of objects with `capturedAtUtc`, `app`, `windowTitle`, and `text` fields. Exact replays deduplicate by the complete snapshot payload.

The daemon does not acquire native screenshots. Native platform helpers send redacted text snapshots to this daemon over its loopback API.
