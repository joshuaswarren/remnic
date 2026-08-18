/**
 * MCP tool-listing entries for the admin/maintenance operation surface
 * (capsules, governance, entity synthesis, procedure mining, pattern
 * reinforcement, procedural stats). Extracted from access-mcp.ts (#2136)
 * to keep the transport file under its structural-ratchet ceiling; the
 * dispatch name map and operation handlers stay in their existing homes.
 */
/** Git-context schema props accepted-and-ignored by every tool (issue #569
 * compatibility surface) — defined here so the tool tables and the transport
 * share one copy without an import cycle. */
export const MCP_GIT_CONTEXT_SCHEMA_PROPS_IGNORED: Record<string, unknown> = {
  cwd: {
    type: "string",
    description: "Accepted for MCP client compatibility (git-context auto-injection); ignored by this tool.",
  },
  projectTag: {
    type: "string",
    description: "Accepted for MCP client compatibility; ignored by this tool.",
  },
};

export const MCP_ADMIN_OPS_TOOLS: Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> = [
{
  name: "engram.capsule_export",
  description: "Export a portable Remnic capsule archive from the namespace-scoped memory store.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Capsule id (alphanumeric with single dashes, max 64 characters).",
      },
      namespace: { type: "string" },
      since: {
        type: "string",
        description: "Only include files modified on or after this ISO 8601 timestamp.",
      },
      includeKinds: {
        type: "array",
        items: { type: "string" },
        description: "Optional top-level directory allow-list.",
      },
      peerIds: {
        type: "array",
        items: { type: "string" },
        description: "Optional peer id allow-list for the peers/ subtree.",
      },
      includeTranscripts: { type: "boolean" },
      encrypt: { type: "boolean" },
      ...MCP_GIT_CONTEXT_SCHEMA_PROPS_IGNORED,
    },
    required: ["name"],
    additionalProperties: false,
  },
},
{
  name: "engram.capsule_import",
  description: "Import a Remnic capsule archive into the namespace-scoped memory store.",
  inputSchema: {
    type: "object",
    properties: {
      archivePath: {
        type: "string",
        description: "Path to a .capsule.json.gz or .capsule.json.gz.enc archive.",
      },
      namespace: { type: "string" },
      mode: {
        type: "string",
        enum: ["skip", "overwrite", "fork"],
        description: "Conflict handling mode. Defaults to skip.",
      },
      passphrase: {
        type: "string",
        description: "Passphrase for encrypted capsule archives.",
      },
      ...MCP_GIT_CONTEXT_SCHEMA_PROPS_IGNORED,
    },
    required: ["archivePath"],
    additionalProperties: false,
  },
},
{
  name: "engram.capsule_list",
  description: "List capsule archives in the namespace-scoped capsule store.",
  inputSchema: {
    type: "object",
    properties: {
      namespace: { type: "string" },
      sessionKey: {
        type: "string",
        description:
          "Optional session key used to derive namespace principal when no trusted transport principal is present.",
      },
      ...MCP_GIT_CONTEXT_SCHEMA_PROPS_IGNORED,
    },
    additionalProperties: false,
  },
},
{
  name: "engram.memory_governance_run",
  description: "Run Remnic memory governance in a bounded shadow/apply pass.",
  inputSchema: {
    type: "object",
    properties: {
      namespace: { type: "string" },
      mode: { type: "string", enum: ["shadow", "apply"] },
      recentDays: { type: "number" },
      maxMemories: { type: "number" },
      batchSize: { type: "number" },
    },
    additionalProperties: false,
  },
},
{
  name: "engram.entity_synthesis_run",
  description:
    "Bulk-drain the entity synthesis queue (issue #2136). Processes up to maxEntities (default 25, max 200) queued entity names into canonical syntheses; loop until processed < requested to drain fully.",
  inputSchema: {
    type: "object",
    properties: {
      namespace: { type: "string" },
      maxEntities: { type: "number" },
    },
    additionalProperties: false,
  },
},
{
  name: "engram.procedure_mining_run",
  description:
    "Run procedural memory mining from causal trajectories (issue #519). Respects procedural.enabled; writes under procedures/ when clusters qualify.",
  inputSchema: {
    type: "object",
    properties: {
      namespace: { type: "string" },
    },
    additionalProperties: false,
  },
},
{
  name: "engram.pattern_reinforcement_run",
  description:
    "Run the pattern-reinforcement maintenance job (issue #687 PR 2/4). Clusters duplicate non-procedural memories by normalized content, promotes the most-recent member to canonical, and supersedes the older duplicates. Gated on patternReinforcementEnabled and the patternReinforcementCadenceMs floor — pass force=true to bypass the cadence for an ad-hoc operator run.",
  inputSchema: {
    type: "object",
    properties: {
      namespace: { type: "string" },
      force: { type: "boolean" },
    },
    additionalProperties: false,
  },
},
{
  // The canonical `remnic.procedural_stats` alias is added automatically
  // by `withToolAliases` — the dual-naming invariant keeps both names
  // alive for the legacy surface.
  name: "engram.procedural_stats",
  description:
    "Procedural memory stats (issue #567): counts by status, recent write activity, and the active procedural.* config. Read-only, namespace-scoped.",
  inputSchema: {
    type: "object",
    properties: {
      namespace: { type: "string" },
    },
    additionalProperties: false,
  },
},
{
  name: "engram.procedure_library_maintenance",
  description:
    "Run procedure library health maintenance (issue #2370): merge near-duplicate active procedures, flag stale-tool procedures for repair, and retire failure-dominant or idle ones — from Memory Worth + trajectory telemetry. Shadow-first: default run writes nothing and returns a proposed-transition report. apply=true (and procedural.maintenance.enabled) executes transitions; dryRun=true forces shadow.",
  inputSchema: {
    type: "object",
    properties: {
      namespace: { type: "string" },
      apply: { type: "boolean" },
      dryRun: { type: "boolean" },
    },
    additionalProperties: false,
  },
},
];
