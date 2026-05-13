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

```typescript
import { createServer } from "@remnic/server";

const server = createServer({
  port: 3141,
  authToken: process.env.REMNIC_AUTH_TOKEN,
});

await server.start();
```

## License

MIT
