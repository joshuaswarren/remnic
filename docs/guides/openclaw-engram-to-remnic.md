# OpenClaw Engram to Remnic Migration

This guide is for OpenClaw users moving from the legacy
`@joshuaswarren/openclaw-engram` package to the canonical
`@remnic/plugin-openclaw` package.

Use it when an OpenClaw upgrade reports `0 plugins updated, 1 unchanged,
1 skipped`, or when `engram-http` starts but `/engram/v1/health` never
responds after moving to a newer OpenClaw bundle.

## Short Answer

Run the Remnic migration command:

```bash
npm install -g @remnic/cli
remnic openclaw migrate-engram --yes
```

Then restart OpenClaw:

```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
remnic doctor
```

## What the Command Changes

`remnic openclaw migrate-engram` is a focused wrapper around the safe OpenClaw
upgrade path. It:

- backs up `~/.openclaw/openclaw.json`;
- backs up the canonical extension directory, if present;
- backs up the legacy `~/.openclaw/extensions/openclaw-engram` directory, if present;
- installs a clean `@remnic/plugin-openclaw` package into
  `~/.openclaw/extensions/openclaw-remnic`;
- writes or updates `plugins.entries["openclaw-remnic"]`;
- sets `plugins.slots.memory = "openclaw-remnic"`;
- preserves the existing memory directory instead of relocating data.

The legacy `plugins.entries["openclaw-engram"]` entry is intentionally retained
during migration. Keep it until the gateway log shows Remnic starting under the
canonical id and `remnic doctor` passes. After that, it can be removed manually.

## Config Key

Use this key after migration:

```json
{
  "plugins": {
    "slots": {
      "memory": "openclaw-remnic"
    },
    "entries": {
      "openclaw-remnic": {
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          "memoryDir": "~/.openclaw/workspace/memory/local"
        }
      }
    }
  }
}
```

Do not rename the package to `remnic-workspace` in `plugins.entries`. The npm
workspace root is named `remnic-workspace`, but the OpenClaw plugin id is
`openclaw-remnic`.

## Preserving Local Patches

If your legacy `@joshuaswarren/openclaw-engram` tree contains local edits, the
migration command leaves that tree in place and also copies it into the timestamped
backup directory printed by the command.

Recommended flow:

1. Run `remnic openclaw migrate-engram --yes --no-restart`.
2. Diff your backed-up `openclaw-engram` directory against the new
   `openclaw-remnic` directory.
3. Re-apply only still-needed patches to `openclaw-remnic`.
4. Restart the OpenClaw gateway.
5. Run `remnic doctor`.

For GPT-5-family OpenAI chat-completions models, Remnic now sends
`max_completion_tokens` instead of `max_tokens` and omits `temperature` for
native OpenAI `gpt-5*` models. Local compatibility patches for that behavior
should not be needed after this release.

## Useful Flags

```bash
remnic openclaw migrate-engram --dry-run
remnic openclaw migrate-engram --yes --version latest
remnic openclaw migrate-engram --yes --no-restart
remnic openclaw migrate-engram --yes --config ~/.openclaw/openclaw.json
remnic openclaw migrate-engram --yes --memory-dir ~/.openclaw/workspace/memory/local
remnic openclaw migrate-engram --yes --legacy-plugin-dir ~/.openclaw/extensions/openclaw-engram
```

## Verification

After restarting OpenClaw:

```bash
remnic doctor
grep -i remnic ~/.openclaw/logs/gateway.log | tail -50
curl -fsS -H "Authorization: Bearer $REMNIC_AUTH_TOKEN" \
  http://127.0.0.1:4318/engram/v1/health
```

Look for:

- `plugins.slots.memory = "openclaw-remnic"`;
- `plugins.entries["openclaw-remnic"]`;
- `[remnic] gateway_start fired` in the gateway log;
- a successful health response from the loopback Remnic HTTP server.

If the gateway does not start, restore `openclaw.json` or the extension
directory from the timestamped backup printed by the command.
