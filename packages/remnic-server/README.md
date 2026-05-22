# @remnic/server

Standalone Remnic memory and context server -- HTTP and MCP interfaces without requiring OpenClaw.

Part of [Remnic](https://github.com/joshuaswarren/remnic), open-source memory and context for user-aware agents.

## Install

```bash
npm install @remnic/server
```

Most users should install [`@remnic/cli`](https://www.npmjs.com/package/@remnic/cli) instead, which includes the server and provides daemon management via `remnic daemon start`.

## What it does

The server exposes Remnic's memory engine over two interfaces:

- **HTTP API** -- RESTful endpoints for memory recall, observe, search, and management
- **MCP (Model Context Protocol)** -- tool-based interface for AI agents that support MCP (Replit, Cursor, etc.)

Both interfaces connect to the same [`@remnic/core`](https://www.npmjs.com/package/@remnic/core) engine. All data stays local on your filesystem.

## Usage

Run the standalone server:

```bash
npx --package @remnic/server remnic-server --help
npx --package @remnic/server remnic-server --port 4318
```

The package also ships the legacy `engram-server` binary for compatibility.
The bin wrappers are source-controlled so package managers can link them during
workspace installs; release builds verify that both targets have Node shebangs
and can start their help command before publish.

```typescript
import { startServer } from "@remnic/server";

const server = await startServer({
  port: 3141,
  authToken: process.env.REMNIC_AUTH_TOKEN,
});

console.log(`Remnic server listening on http://${server.host}:${server.port}`);
await server.stop();
```

## License

MIT
