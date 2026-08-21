# Live graph dashboard

The live graph dashboard is an optional sidecar process that serves a read-only view of the memory graph: a snapshot endpoint, a health endpoint, and a WebSocket stream that pushes patches when the graph files change. It has no config flag — you start it on demand with the CLI — and it only surfaces data once the graph subsystem is enabled (`multiGraphMemoryEnabled` / `graphRecallEnabled`, both default `false`).

> Provenance: the live graph dashboard landed in v8.8.

It serves:
- `GET /api/graph` — current parsed graph snapshot
- `GET /api/health` — runtime health/status payload
- WebSocket stream (same host/port) — patch updates after graph file changes

## Start, stop, status

```bash
openclaw engram dashboard start --host 127.0.0.1 --port 4319
openclaw engram dashboard status
openclaw engram dashboard stop
```

Default behavior:
- Separate process boundary from gateway hot path.
- Loopback bind by default (`127.0.0.1`).
- Graceful degradation when graph files are missing/corrupt (health endpoint remains available).

## Safety notes

- Keep loopback bind unless you explicitly need remote access.
- WebSocket upgrades require an explicit `Origin` header that is loopback (`127.0.0.1`, `localhost`, or `::1`) and uses the dashboard's bound HTTP port (`http:` only).
- If you expose non-loopback binds, place the service behind network controls.
- Dashboard is read-only and does not mutate memory artifacts.

