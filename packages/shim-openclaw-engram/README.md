# @joshuaswarren/openclaw-engram

> **Engram has been renamed to Remnic.** This package is a compatibility shim that re-exports [`@remnic/plugin-openclaw`](https://www.npmjs.com/package/@remnic/plugin-openclaw).

## Migrate

Replace this package with the canonical one:

```bash
openclaw plugins install clawhub:@remnic/plugin-openclaw
```

Your existing memories, configuration, and settings will continue to work. The rename only changes the package name -- all functionality is preserved.

For full migration details, see the [Rename Guide](https://github.com/joshuaswarren/remnic/blob/main/docs/RENAME.md).

## What is Remnic?

Remnic is open-source memory and context for user-aware agents. It helps agents understand preferences, projects, constraints, decisions, patterns, and definitions of good while keeping memory inspectable as plain markdown files.

- **Repository**: [github.com/joshuaswarren/remnic](https://github.com/joshuaswarren/remnic)
- **Core package**: [`@remnic/core`](https://www.npmjs.com/package/@remnic/core)
- **OpenClaw plugin**: [`@remnic/plugin-openclaw`](https://www.npmjs.com/package/@remnic/plugin-openclaw)
- **Standalone CLI**: [`@remnic/cli`](https://www.npmjs.com/package/@remnic/cli)

## License

MIT
