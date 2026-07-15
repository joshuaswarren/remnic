# Plugin Development Guide

How to create a Remnic plugin for a new AI agent platform.

## Architecture

Every Remnic plugin follows the same pattern:

1. **Connect to Remnic** — via the daemon's HTTP API or MCP protocol on `:4318`
2. **Auto-recall** — inject memory context before the agent processes a prompt
3. **Auto-observe** — capture conversation turns and file changes for memory extraction
4. **Explicit tools** — provide the agent with direct recall/store/search capabilities
5. **Authenticate** — use a per-plugin token from `~/.remnic/tokens.json` with `~/.engram/tokens.json` as a migration fallback

## Architecture boundary

`@remnic/core` never imports a host package. Core owns memory behavior and
exposes host-agnostic contracts; each plugin depends on core and maps those
contracts onto its platform's plugin SDK, hooks, and manifest. Keep
host-specific types, commands, and lifecycle glue in the plugin package. When
the host already provides a native command surface, tool-registration path, or
memory lifecycle hook, consume that upstream primitive instead of inventing a
parallel abstraction in core.

## Integration Depth Tiers

### Tier 1: MCP Only (Replit)

The platform supports MCP but has no plugin/hook system. The agent must explicitly call MCP tools — no automatic memory injection.

```json
{
  "mcpServers": {
    "remnic": {
      "url": "http://localhost:4318/mcp",
      "headers": { "Authorization": "Bearer ${REMNIC_AUTH_TOKEN}" }
    }
  }
}
```

### Tier 2: Plugin + Hooks (Claude Code, Codex)

The platform has a plugin format AND lifecycle hooks. Hooks enable automatic memory injection on every prompt and observation on every tool use.

**Required hooks:**
- `SessionStart` → recall project context, inject as `additionalContext`
- `UserPromptSubmit` → recall memories relevant to the prompt, inject as `additionalContext`
- `PostToolUse` → observe file changes in background

**Required MCP:** the full Remnic MCP tool surface (100+ tools) for explicit operations.

### Tier 3: MemoryProvider (Hermes)

The platform has a dedicated memory provider protocol. This is the deepest integration — memory injection is structural, happening on every LLM call without hooks.

**Required methods:**
- `pre_llm_call` → recall + inject into system prompt
- `sync_turn` → observe conversation turn
- `extract_memories` → structured extraction on session end

### Tier 4: Memory Slot (OpenClaw)

The platform has a dedicated memory plugin slot. Similar to Tier 3 but with platform-specific APIs.

## Creating a New Plugin

### Step 1: Create the Package

```bash
mkdir -p packages/plugin-myplatform
cd packages/plugin-myplatform
```

### Step 2: Add package.json

```json
{
  "name": "@remnic/plugin-myplatform",
  "version": "0.1.0",
  "type": "module",
  "description": "Remnic memory plugin for MyPlatform",
  "main": "dist/index.js",
  "dependencies": {
    "@remnic/core": "workspace:*"
  }
}
```

### Step 3: Implement the Platform's Plugin Format

Follow the target platform's plugin documentation. At minimum:
- Plugin manifest (platform-specific format)
- MCP server config pointing to `http://localhost:4318/mcp`
- Hook scripts (if the platform supports hooks)

### Step 4: Add an Installer

Create `src/installer.ts` that `remnic connectors install myplatform` calls:

```typescript
export async function install(options: { tokenStore: TokenStore; configDir: string }) {
  // 1. Generate auth token
  const token = await options.tokenStore.generate("myplatform");
  
  // 2. Write platform-specific config files
  // 3. Copy plugin files to platform's plugin directory
  // 4. Run health check
}
```

### Step 5: Register the Connector

Add the connector manifest to the connector registry in `@remnic/core`:

```typescript
{
  id: "myplatform",
  name: "MyPlatform",
  capabilities: { observe: true, recall: true, store: true, ... },
  connectionType: "mcp",
}
```

### Step 6: Add an Adapter (Optional)

If the platform sends identifiable headers or `clientInfo`, add an adapter in `@remnic/core/adapters/`:

```typescript
export class MyPlatformAdapter implements EngramAdapter {
  readonly id = "myplatform";
  matches(context: AdapterContext): boolean { ... }
  resolveIdentity(context: AdapterContext): ResolvedIdentity { ... }
}
```

## Hook Script Template

For platforms with lifecycle hooks (Tier 2):

```bash
#!/usr/bin/env bash
# Hook: [event name]
# Reads JSON from stdin, writes JSON to stdout

REMNIC_HOST="${REMNIC_HOST:-127.0.0.1}"
REMNIC_PORT="${REMNIC_PORT:-4318}"
REMNIC_TOKEN="$(node -e "
  const fs = require('fs');
  const path = require('path');
  const remnic = path.join(process.env.HOME, '.remnic', 'tokens.json');
  const engram = path.join(process.env.HOME, '.engram', 'tokens.json');
  const tokenFile = fs.existsSync(remnic) ? remnic : engram;
  if (fs.existsSync(tokenFile)) {
    const t = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    process.stdout.write(t['myplatform'] || '');
  }
")"

INPUT="$(cat)"
# Parse input, call the Remnic API, return hook response
```

## Testing Your Plugin

```bash
# Unit tests
pnpm test --filter=@remnic/plugin-myplatform

# Integration test: start daemon, install plugin, simulate hook
remnic daemon start
remnic connectors install myplatform
remnic connectors doctor myplatform
```
