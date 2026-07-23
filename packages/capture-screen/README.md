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
remnic-capture-screen start \
  --spool ~/.local/state/remnic/capture/spool.sqlite \
  --replay ./snapshots/            # a directory of *.json fixture files
```

The bearer token is read from the `REMNIC_CAPTURE_TOKEN` environment variable (legacy `ENGRAM_CAPTURE_TOKEN` also accepted), never a CLI flag: a long-lived daemon's argv is world-readable via `ps` / `/proc` on a multi-user host. Passing `--auth-token` is rejected.

Each `*.json` file in the `--replay` directory holds a snapshot object (or an array of them) with `capturedAtUtc` (ISO-8601 UTC), `app`, `windowTitle`, one of `text` or `ax`, and `textSource` (`"ax"` or `"ocr"`). Each served snapshot also carries the stored `contentHash`, so the core activity client can ingest it. Exact replays deduplicate by the complete snapshot payload.

The daemon does not acquire native screenshots. Native platform helpers send redacted text snapshots to this daemon over its loopback API.

The `--spool` file must live in an owner-only directory. The daemon creates the directory `0700` when absent; if it already exists, the daemon refuses to open the spool under a symlinked or group/other-accessible directory and never changes an existing directory's permissions. The SQLite file itself is created `0600`. Point `--spool` at a dedicated directory such as `~/.local/state/remnic/capture/`.
