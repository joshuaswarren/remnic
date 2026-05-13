# ChatGPT Apps Demo

Remnic exposes a small ChatGPT Apps-compatible memory inspector on the
existing MCP runtime. This is a local developer demo, not a public app
submission package.

Archetype: `vanilla-widget`.

## What It Adds

- MCP widget resource: `ui://remnic/memory-inspector.v1.html`
- MIME type: `text/html;profile=mcp-app`
- Render tool: `remnic.chatgpt_memory_inspector`
- Legacy alias: `engram.chatgpt_memory_inspector`

The tool is read-only. It runs a safe recall preview, captures Recall X-ray
provenance, evaluates action confidence, and renders the result in a widget.
Correction, forget, and scoping controls send follow-up prompts only; persistent
changes still require a separate Remnic tool call and user confirmation.

## Why This Shape

OpenAI's Apps SDK quickstart says ChatGPT apps use an MCP server to expose
tools and can optionally render a web component in ChatGPT. The server guide
shows widget resources with `text/html;profile=mcp-app` and tools that point to
the widget via `_meta.ui.resourceUri`. The UI guide recommends the MCP Apps
bridge first, while keeping `window.openai` as the ChatGPT compatibility layer.

Docs used:

- https://developers.openai.com/apps-sdk/quickstart
- https://developers.openai.com/apps-sdk/build/mcp-server
- https://developers.openai.com/apps-sdk/build/chatgpt-ui
- https://developers.openai.com/apps-sdk/reference
- https://developers.openai.com/apps-sdk/plan/tools

## Local Smoke Test

Start Remnic's standalone server, then point MCP Inspector or ChatGPT developer
mode at the existing `/mcp` endpoint:

```bash
REMNIC_AUTH_TOKEN=dev-token remnic-server --port 4318
```

Use the normal bearer token header:

```text
Authorization: Bearer dev-token
```

Then call:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "remnic.chatgpt_memory_inspector",
    "arguments": {
      "query": "What preferences matter for this answer?",
      "currentContextScopes": ["work", "repo"]
    }
  }
}
```

The widget resource is served through MCP `resources/read`; there is no second
Remnic MCP server and no extra frontend build step.
