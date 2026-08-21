import type { ConnectorManifest } from "./index.js";

/**
 * Builtin manifest for the Prime Agent connector (#2313). Prime Agent is a
 * Pi-fork coding agent; the runtime extension is `@remnic/plugin-pi`, published
 * to `~/.prime/agent/extensions/remnic` (override: `PRIME_AGENT_CODING_AGENT_DIR`)
 * by `PrimeAgentMemoryExtensionPublisher` in the plugin-pi package.
 *
 * Declared in this sibling module — not inline in index.ts — so the connector
 * catalog addition does not grow index.ts past its file-size ratchet ceiling
 * (same pattern as `DROID_CONNECTOR_MANIFEST` in droid-mcp.ts).
 */
export const PRIME_AGENT_CONNECTOR_MANIFEST: ConnectorManifest = {
  id: "prime-agent",
  name: "Prime Agent",
  version: "1.0.0",
  description:
    "Prime Agent — Pi-fork coding agent; native extension for recall, observe, MCP tools, and compaction coordination",
  capabilities: {
    observe: true,
    recall: true,
    store: true,
    search: true,
    entities: true,
    realtimeSync: true,
    batch: true,
    maxBudgetChars: 32000,
    connectionType: "http",
  },
  configSchema: {
    remnicDaemonUrl: "URL of the Remnic daemon (default: http://127.0.0.1:4318)",
    namespace: "Optional namespace",
    installExtension: "Install the Prime Agent extension into ~/.prime/agent/extensions/remnic (default: true)",
  },
  author: "Remnic",
  tags: ["official", "ai", "prime-agent", "pi", "coding-agent"],
  requiresToken: true,
};
