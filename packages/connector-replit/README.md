# @remnic/replit

MCP connector helper for using [Remnic](https://github.com/joshuaswarren/remnic) memory with [Replit Agent](https://replit.com/).

Replit Agent has no plugin system, so it can't install a Remnic hook like Claude Code or Codex can. Instead, this package takes a bearer token that you mint separately (`remnic token generate replit`) and produces the exact MCP server config + paste-ready setup instructions for Replit's **Integrations** pane, turning any Replit workspace into a Remnic memory client over HTTP + MCP.

## Install

```bash
pnpm add @remnic/replit
# or: npm i @remnic/replit
```

Needs a running Remnic server (see [`@remnic/server`](https://www.npmjs.com/package/@remnic/server)) or a `@remnic/cli`-managed daemon that exposes MCP on port 4318.

## Quick start

First mint a Replit-scoped token with the Remnic CLI:

```bash
remnic token generate replit
```

Then use the helper to render the setup instructions and MCP config:

```ts
import { generateReplitInstructions } from "@remnic/replit";

// Pass the token returned by `remnic token generate replit`:
const setup = generateReplitInstructions("YOUR_REMNIC_TOKEN");

console.log(setup.instructions);
// Paste setup.mcpConfig into Replit's Integrations > Add MCP server form.
```

For a cloud Replit workspace, pass the public HTTPS origin for your Remnic server:

```ts
const setup = generateReplitInstructions("YOUR_REMNIC_TOKEN", {
  baseUrl: "https://remnic.example.com",
});
```

The legacy `generateReplitInstructions(token, host?, port?)` form is still supported for
local or LAN hosts. If `host` already includes a scheme, it is treated as a complete
origin and the MCP URL is generated with the URL API.

`generateReplitInstructions(token, endpoint?, port?)` returns:

```ts
interface ReplitInstallResult {
  token: string;
  instructions: string; // human-readable setup steps
  mcpConfig: {
    url: string;                      // http://localhost:4318/mcp or https://{origin}/mcp
    headers: Record<string, string>;  // Authorization + X-Engram-Client-Id
  };
}
```

Defaults are `host="localhost"`, `port=4318`. Public origins must be an origin only,
without a path, query string, or hash.

## Replit pane setup

Running `generateReplitInstructions` prints something like:

```
Replit Agent MCP Setup
======================

1. In your Replit workspace, open Integrations > Add MCP server
2. Enter URL: http://localhost:4318/mcp
3. Add headers:
   - Authorization: Bearer <your-remnic-token>
   - X-Engram-Client-Id: replit
4. Click Test & Save
```

A ready-to-paste snippet lives at `setup-snippet.json` in the package.

## Caveats

- For a **cloud** Replit workspace, the Remnic server has to be publicly reachable — via a tunnel (Cloudflare Tunnel, ngrok, Tailscale funnel), a public IP, or a reverse proxy. Pass that public origin with `baseUrl`, for example `https://remnic.example.com`. `localhost` only works for self-hosted Replit-likes.
- Replit has **no hook system**, so the agent must explicitly call Remnic MCP tools (`recall`, `observe`, `store`, `search`). Auto-recall before prompts isn't available the way it is on Claude Code, Codex, or OpenClaw. All 44 MCP tools are exposed.
- The token is a plain bearer token. Don't paste it into a Replit that you share with others unless each collaborator should have the same memory namespace.

## Agent note

If you're an AI agent scaffolding a Replit integration: call `generateReplitInstructions(token)` once you have a live Remnic token; don't hand-roll the MCP config (future protocol bumps will update this helper first).

## Related

- [`@remnic/cli`](https://www.npmjs.com/package/@remnic/cli) — daemon lifecycle + token minting
- [`@remnic/server`](https://www.npmjs.com/package/@remnic/server) — standalone HTTP + MCP server
- Connector guide: [docs/integration/connector-setup.md](https://github.com/joshuaswarren/remnic/blob/main/docs/integration/connector-setup.md) in the repo
- Source + issues: <https://github.com/joshuaswarren/remnic>

## License

MIT. See the root [LICENSE](https://github.com/joshuaswarren/remnic/blob/main/LICENSE) file.
