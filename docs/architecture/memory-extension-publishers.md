# Memory Extension Publishers

## Overview

Memory extension publishers are the mechanism Remnic uses to install
host-specific instruction files into each AI agent host's extension
directory. Each publisher knows:

- Where the host stores extensions on disk.
- Whether the host is installed locally.
- How to render and write Remnic-specific instructions.
- How to clean up (unpublish) those artefacts.

This design generalises the pattern previously hard-coded for Codex into
a pluggable contract that any host can implement.

## Publisher Interface

Every publisher implements `MemoryExtensionPublisher`:

```ts
interface MemoryExtensionPublisher {
  readonly hostId: string;
  resolveExtensionRoot(env?: NodeJS.ProcessEnv): Promise<string>;
  isHostAvailable(): Promise<boolean>;
  renderInstructions(ctx: PublishContext): Promise<string>;
  publish(ctx: PublishContext): Promise<PublishResult>;
  unpublish(): Promise<void>;
}
```

### PublishContext

```ts
interface PublishContext {
  readonly config: { memoryDir: string; daemonPort?: number; namespace?: string };
  readonly skillsRoot: string;
  readonly log: { info, warn, error };
}
```

### PublishResult

```ts
interface PublishResult {
  readonly hostId: string;
  readonly extensionRoot: string;
  readonly filesWritten: string[];
  readonly skipped: string[];
}
```

### PublisherCapabilities

Static capability flags that describe what a publisher can produce:

```ts
interface PublisherCapabilities {
  readonly instructionsMd: boolean;
  readonly skillsFolder: boolean;
  readonly citationFormat: boolean;
  readonly readPathTemplate: boolean;
}
```

## Host Implementations

### Codex (`codex-publisher.ts`)

**Status:** Fully implemented.

- Extension root: `~/.codex/memories_extensions/remnic/`
- Writes `instructions.md` with shared blocks + Codex-specific sandbox rules.
- Uses atomic write (temp file + rename) per CLAUDE.md guideline #54.
- `isHostAvailable()` checks for `~/.codex/` directory existence.

### Claude Code (`claude-code-publisher.ts`)

**Status:** Stub. Claude Code does not yet support file-based memory
extension directories. All methods are safe no-ops.

### Hermes (`hermes-publisher.ts`)

**Status:** Stub. Hermes uses daemon-based transport. All methods are
safe no-ops.

## Shared Instruction Blocks

`shared-instructions.ts` exports four reusable markdown fragments:

| Export | Content |
|--------|---------|
| `REMNIC_SEMANTIC_OVERVIEW` | Table of memory types (fact, preference, decision, etc.) |
| `REMNIC_CITATION_FORMAT` | `<oai-mem-citation>` block format and examples |
| `REMNIC_MCP_TOOL_INVENTORY` | Table of all MCP tools the daemon exposes |
| `REMNIC_RECALL_DECISION_RULES` | When to use MCP recall vs direct file reads |

Each publisher composes these blocks into its host-specific
`renderInstructions()` output, adding host-specific sections (e.g.
Codex sandbox rules) as needed.

## Registry

`index.ts` exports:

```ts
const PUBLISHERS: Record<string, () => MemoryExtensionPublisher>;
function publisherFor(hostId: string): MemoryExtensionPublisher | undefined;
```

`publisherFor()` returns `undefined` for unknown host IDs rather than
throwing, so callers can gracefully skip unknown hosts.

## CLI Integration

### `connectors install`

After a successful connector install, the CLI calls
`publisherFor(connectorId)` and, if the host is available, publishes
the memory extension automatically.

### `connectors doctor`

The doctor command iterates all registered publishers and reports:

- Whether each host is installed locally.
- Whether the extension directory exists.
- Remediation advice if the extension is missing.

## Adding a New Host Publisher

1. Create `packages/remnic-core/src/memory-extension/<host>-publisher.ts`.
2. Implement `MemoryExtensionPublisher`.
3. Define static `capabilities: PublisherCapabilities`.
4. Register it in `index.ts`'s `PUBLISHERS` map.
5. Export the class from `index.ts`.
6. Add it to the main `packages/remnic-core/src/index.ts` exports.
7. Write tests in `tests/memory-extension-publisher.test.ts`.
