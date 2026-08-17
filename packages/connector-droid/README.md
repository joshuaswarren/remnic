# @remnic/connector-droid

> **Built by Droid.** This connector was implemented by Factory Droid itself.

Factory Droid connector for Remnic — connect [Droid](https://factory.ai) to
your shared memory store via HTTP MCP.

## Install

```bash
remnic connectors install droid
```

This mints a host token, records Remnic-side connector state, and writes a
`remnic` entry to the **user-level** `~/.factory/mcp.json` with HTTP transport
and an `Authorization: Bearer <token>` header. The project-level
`.factory/mcp.json` is never touched.

## Verify

```bash
remnic connectors doctor droid
```

## Remove

```bash
remnic connectors remove droid
```

See [docs/integration/droid.md](../../docs/integration/droid.md) for the full
guide.
