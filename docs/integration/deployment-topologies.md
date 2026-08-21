# Deployment Topologies

Remnic's HTTP access server supports several deployment topologies depending on your environment and use case.

## 1. Localhost (Default)

The server binds to `127.0.0.1` on the same machine as OpenClaw. This is the default for development and single-machine setups.

```bash
openclaw engram access http-serve --port 4318 --token "$TOKEN"
```

All endpoints are available at `http://127.0.0.1:4318/engram/v1/`.

## 2. LAN (Network-Accessible)

Run Remnic on a dedicated machine accessible from your local network (e.g., a Mac Mini or home server).

```bash
openclaw engram access http-serve --host 0.0.0.0 --port 4318 --token "$TOKEN"
```

Other machines on the LAN can reach Remnic at `http://<machine-ip>:4318/engram/v1/`.

**Security note:** Binding to `0.0.0.0` exposes the server to all network interfaces. Use a firewall or VPN to restrict access. The bearer token is required for all requests.

## 3. Remote (Self-Hosted)

Run Remnic on a remote server or VPS. Use a reverse proxy (nginx, Caddy) with TLS termination.

```nginx
server {
    listen 443 ssl;
    server_name remnic.example.com;

    ssl_certificate /etc/ssl/certs/remnic.pem;
    ssl_certificate_key /etc/ssl/private/remnic.key;

    location / {
        proxy_pass http://127.0.0.1:4318;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Start Remnic binding to localhost behind the proxy:

```bash
openclaw engram access http-serve --host 127.0.0.1 --port 4318 --token "$TOKEN"
```

## 4. Standalone (No OpenClaw)

Run Remnic as a standalone CLI/HTTP server using the `remnic` binary. Requires [tsx](https://github.com/privatenumber/tsx) on PATH. This topology is useful for CI/CD pipelines, scripted memory operations, or environments where OpenClaw is not available.

> **Build from source required:** The canonical `remnic` CLI auto-locates `tsx` from local `node_modules`, falling back to a global `tsx` if needed. The legacy `engram` binary remains as a forwarder. The `daemon start` command launches the server via a monorepo-relative path that only exists when built from source.

```bash
# Prerequisite
npm install -g tsx

# Build from source (required for daemon start)
git clone https://github.com/joshuaswarren/remnic.git
cd remnic && pnpm install && pnpm run build
cd packages/remnic-cli && npm link # Makes `remnic` available on PATH
cd ../..

# Initialize configuration
remnic init

# Set required environment variables
export OPENAI_API_KEY=sk-...
export REMNIC_AUTH_TOKEN=$(openssl rand -hex 32)

# Start the server
remnic daemon start
remnic status    # verify it's running
```

Connect from any HTTP client or use `@remnic/hermes-provider`:

```typescript
import { HermesClient } from "@remnic/hermes-provider";

const client = new HermesClient({
  baseUrl: "http://127.0.0.1:4318",
  authToken: process.env.REMNIC_AUTH_TOKEN,
});
```

For MCP clients, point at `http://127.0.0.1:4318/mcp`:

```jsonc
// Claude Code config (~/.claude.json)
{
  "mcpServers": {
    "remnic": {
      "url": "http://localhost:4318/mcp",
      "headers": {
        "Authorization": "Bearer ${REMNIC_AUTH_TOKEN}"
      }
    }
  }
}
```

The standalone topology supports all the same endpoints and MCP tools as the OpenClaw plugin mode.

## 5. Containerized (Docker)

Run Remnic in Docker, either standalone or as a sidecar alongside other services.
The default Dockerfile builds a full local-first image with `@tobilu/qmd@2.5.3`
installed and available as `qmd` for the non-root runtime user. Persist `/data`
so Remnic memory files and QMD index state survive container restarts.

```yaml
# docker-compose.yml
version: "3.8"
services:
  remnic:
    build: .
    ports:
      - "4318:4318"
    environment:
      REMNIC_AUTH_TOKEN: ${REMNIC_AUTH_TOKEN}
      NODE_ENV: production
    volumes:
      - remnic-data:/data

volumes:
  remnic-data:
```

## Port Selection

| Port | Use Case |
|------|----------|
| 4318 | Default Remnic HTTP port (configurable via `--port`) |
| 18789 | OpenClaw gateway (Remnic plugin mode) |

## Authentication

All topologies require a bearer token. Standalone server configuration uses
this precedence:

1. The `--token` CLI flag.
2. The `REMNIC_AUTH_TOKEN` environment variable.
3. The server `authToken` configuration value.

OpenClaw delegate mode resolves the daemon credential with this precedence:

1. `OPENCLAW_REMNIC_ACCESS_TOKEN`
2. `REMNIC_AUTH_TOKEN`
3. `OPENCLAW_ENGRAM_ACCESS_TOKEN` (legacy name)
4. `ENGRAM_AUTH_TOKEN` (legacy name)
5. The OpenClaw entry in `~/.remnic/tokens.json`
6. The OpenClaw entry in `~/.engram/tokens.json` (legacy store)
7. `server.authToken` in the daemon config file for the selected endpoint

The first non-empty value wins. An environment variable wins over a config
file, even when the config file has a newer token. After a daemon returns HTTP
401, delegate mode retries once after it excludes the rejected credential.
This lets a rotated config token replace a stale exported environment value
without restarting the session.

Clients must send `Authorization: Bearer <token>` with every request.

### SecretRef tokens (OpenClaw plugin mode, issue #757)

When running under OpenClaw, `agentAccessHttp.authToken` accepts an OpenClaw
SecretRef object instead of a literal string. Remnic delegates resolution to
the gateway's built-in secret resolver — the same path that handles
`gateway.auth.token` and channel `botToken` / `token` fields — so the token
never appears in cleartext in `openclaw.json`:

```json
{
  "agentAccessHttp": {
    "enabled": true,
    "authToken": {
      "source": "exec",
      "provider": "kc_openclaw_remnic_token",
      "id": "value"
    }
  }
}
```

Resolution happens once at plugin startup, before the HTTP listener opens.
If resolution fails (Keychain locked, missing exec provider, empty value),
the bridge refuses to start rather than serving requests with no auth.

Standalone Remnic (no OpenClaw gateway present) does **not** support
SecretRef objects — use a literal string or `${ENV_VAR}` expansion instead.

## Health Check

Regardless of topology, verify the server is running:

```bash
curl -H "Authorization: Bearer $TOKEN" http://<host>:4318/engram/v1/health
```

Returns:

```json
{
  "ok": true,
  "memoryDir": "/path/to/memory",
  "namespacesEnabled": false,
  "defaultNamespace": "default",
  "searchBackend": "qmd",
  "qmdEnabled": true,
  "qmd": {
    "enabled": true,
    "active": true,
    "degraded": false,
    "mode": "cli",
    "collection": "openclaw-engram",
    "collectionState": "present",
    "installedVersion": "qmd 2.5.3",
    "supportedVersion": "2.5.3",
    "supported": true,
    "upgradeAvailable": false,
    "doctorAvailable": true,
    "debugStatus": "cli=true daemon=false ..."
  },
  "nativeKnowledgeEnabled": false,
  "projectionAvailable": true
}
```

If `qmdEnabled` is true but `qmd.active` is false, the server is running in
degraded filesystem fallback mode. Check `qmd.debugStatus` and
`qmd.collectionState`; the default Docker image should report an installed
QMD version and an active `present` or fail-open `unknown` collection state
after startup.
