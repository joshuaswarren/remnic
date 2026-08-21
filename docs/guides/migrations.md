# Migrations

Remnic covers several distinct migration paths. This page is the index; each
path has its own detailed guide. It also covers two housekeeping migrations that
have no separate guide: consolidating a hand-tuned config onto a preset, and
finding the current roadmap.

## Which migration do you need?

| You are moving from | Guide |
|---|---|
| The legacy `@joshuaswarren/openclaw-engram` plugin to `@remnic/plugin-openclaw` | [OpenClaw Engram to Remnic](openclaw-engram-to-remnic.md) |
| The single-package plugin to the standalone `@remnic/cli` and server | [Platform migration](platform-migration.md) |
| lossless-claw (LCM) to Remnic's built-in LCM mode | [LCM to Remnic](../lcm-to-remnic-migration.md) |
| mem0, Supermemory, ChatGPT, Claude, or Gemini exports | Run `remnic import --adapter <name> --file <path>` |

## Upgrading in place

For existing OpenClaw users the plugin update path is transparent: the npm entry
point, config format, plugin manifest, memory storage, and config schema are
unchanged. Verify after upgrading:

```bash
openclaw engram doctor --json   # OpenClaw plugin users
remnic doctor                   # standalone users
```

Roll back by pinning the previous plugin version:

```bash
openclaw plugins install npm:@remnic/plugin-openclaw@<previous-version>
```

Memory storage is never modified by an upgrade, so rollback never loses data.

## Consolidating config onto a preset

If your config grew by copying old advanced-flag examples, collapse it onto a
preset first:

1. Choose the nearest preset: `conservative`, `balanced`, `research-max`, or
   `local-llm-heavy`.
2. Delete advanced flags that now match the preset.
3. Re-add only the values you intentionally want to override.

```jsonc
{
  "memoryOsPreset": "research-max",
  "maxMemoryTokens": 2800,
  "graphRecallEnabled": false
}
```

That is far easier to review than carrying a large copied block of defaults.

Older docs sometimes used `research` as a preset label. The config parser still
accepts it as an alias, but the canonical name is `research-max`.

## Where the roadmap lives

The roadmap source of truth is the GitHub Project:

- [Remnic Feature Roadmap](https://github.com/users/joshuaswarren/projects/1)

Use `docs/plans/` only for architecture context after you already know the
active project item. Good workflow:

1. Check the GitHub Project for order, blockers, and coordination.
2. Read the relevant issue.
3. Open the matching historical plan only if you need deeper design rationale.

## Operator checklist

- Replace copied preset JSON blocks with `memoryOsPreset` where possible.
- Update any internal docs that still point contributors at a specific plan file
  as if it were the live roadmap.
- Re-run the config contract check after adding or removing advanced fields.
- Moving to the standalone CLI or server? See the
  [Platform migration guide](platform-migration.md).
