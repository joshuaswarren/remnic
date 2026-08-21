/**
 * @remnic/core — Shared Instruction Blocks
 *
 * Reusable markdown fragments that every host-specific publisher can
 * compose into its instructions.md file. Keeping them here avoids
 * per-host copy-paste drift.
 */

/**
 * Describes the Remnic memory types a host agent may encounter.
 */
export const REMNIC_SEMANTIC_OVERVIEW = `\
## Remnic Memory Types

Remnic stores memories as plain Markdown files with YAML front-matter.
Each memory has a **type** that describes its semantic role:

| Type | Description |
|------|-------------|
| \`fact\` | An objective piece of knowledge the user confirmed or that was extracted from a session. |
| \`preference\` | A stated or inferred user preference (e.g. coding style, tool choice). |
| \`decision\` | An explicit decision or trade-off the user made. |
| \`entity\` | A named thing the user cares about (project, service, person, API). |
| \`skill\` | A reusable workflow or procedure documented for future sessions. |
| \`correction\` | A fix or amendment to a previously stored memory. |
| \`question\` | An open question or uncertainty flagged for future resolution. |
| \`observation\` | A pattern noticed across sessions (e.g. "user always runs tests before commits"). |
| \`summary\` | A condensed roll-up of recent sessions or a topic area. |

When reading Remnic content, the front-matter \`type\` field tells you what
kind of knowledge you are looking at and how much weight to give it.
`;

/**
 * Explains the oai-mem-citation block format hosts should use when
 * referencing Remnic-sourced content.
 */
export const REMNIC_CITATION_FORMAT = `\
## Citing Remnic Memories

When a piece of your output draws on a Remnic file, cite it using the
memory citation block format so the user can trace the source:

\`\`\`
<oai-mem-citation path="<path-relative-to-remnic-memory-base>" />
\`\`\`

The path must be **relative to the Remnic memory base** (the directory
named \`memories/\` under \`<remnic-home>\`), not absolute. Examples:

- \`<oai-mem-citation path="default/MEMORY.md" />\`
- \`<oai-mem-citation path="my-project/skills/deploy/SKILL.md" />\`
- \`<oai-mem-citation path="shared/memory_summary.md" />\`

Cite each distinct source once near the fact it supports. Do not invent
citations for files you have not actually read.
`;

/**
 * Table of MCP tools the Remnic daemon exposes. Hosts that can reach
 * the MCP server should prefer these over raw file reads.
 *
 * Tool names use the canonical `remnic.*` prefix. Legacy `engram.*`
 * aliases are also accepted by the server for backward compatibility.
 */
export const REMNIC_MCP_TOOL_INVENTORY = `\
## Remnic MCP Tools

When the Remnic MCP server is reachable, the following tools are
available. Prefer MCP tools over direct file reads when the host
supports MCP connections.

| Tool | Purpose |
|------|---------|
| \`remnic.recall\` | Retrieve contextually relevant memories for the current session. |
| \`remnic.recall_explain\` | Like recall, but includes an explanation of why each memory was selected. |
| \`remnic.memory_store\` | Persist a new memory (fact, preference, decision, etc.). |
| \`remnic.memory_get\` | Fetch a specific memory by ID. |
| \`remnic.memory_search\` | Full-text + semantic search across all memories. |
| \`remnic.memory_timeline\` | Retrieve memories in chronological order within a time range. |
| \`remnic.observe\` | Record an observation from the current conversation turn. |
| \`remnic.entity_get\` | Look up a named entity and its relationships. |
| \`remnic.memory_entities_list\` | List all known entities. |
| \`remnic.memory_profile\` | Retrieve the user profile summary. |
| \`remnic.day_summary\` | Generate a summary of memories from a specific day. |
| \`remnic.briefing\` | Generate a structured briefing for an upcoming session. |
| \`remnic.memory_feedback\` | Submit feedback on a recalled memory (useful, outdated, wrong). |
| \`remnic.memory_promote\` | Promote a memory to a higher confidence tier. |
| \`remnic.context_checkpoint\` | Save a conversation checkpoint for continuity. |
| \`remnic.suggestion_submit\` | Submit a suggestion for a new memory to the review queue. |
| \`remnic.review_queue_list\` | List pending suggestions in the review queue. |
| \`remnic.work_task\` | Create or update a work task. |
| \`remnic.work_project\` | Create or update a work project. |
| \`remnic.work_board\` | View the work board. |

Legacy \`engram.*\` prefixed names are accepted as aliases for all tools.
`;

/**
 * Decision rules for when a host agent should use MCP recall vs
 * reading Remnic files directly from disk.
 */
export const REMNIC_RECALL_DECISION_RULES = `\
## When to Use Recall vs Direct Read

### Use \`remnic.recall\` (MCP) when:

- The Remnic MCP server is reachable (the host has an active MCP
  connection to the Remnic daemon).
- You want contextually relevant memories ranked by the recall planner
  (semantic search + reranking + importance scoring).
- You need memories across multiple namespaces or topics.
- The conversation benefits from Remnic's intent detection and
  adaptive recall depth.

### Use direct file reads when:

- You are in a sandboxed environment with no network or MCP access
  (e.g. Codex phase-2 consolidation).
- You need a specific file you already know the path to.
- The MCP server is unavailable or unhealthy.
- You are operating on the raw memory files for maintenance or
  migration purposes.

### General guidance:

- Prefer MCP tools when available — they provide ranked, deduplicated,
  and context-aware results.
- Fall back to file reads gracefully — never block on a failed MCP call
  when the data is also on disk.
- Never write directly to the Remnic memory directory unless you are an
  authorized extraction or consolidation process.
`;
