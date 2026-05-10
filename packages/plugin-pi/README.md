# Remnic for Pi

First-class Remnic memory extension for [Pi Coding Agent](https://pi.dev).

Install through Remnic:

```bash
remnic connectors install pi
```

Or load the package directly with Pi after configuring `REMNIC_PI_CONFIG`:

```bash
pi -e npm:@remnic/plugin-pi
```

The extension injects relevant Remnic recall before model calls, observes Pi
turns into Remnic/LCM, exposes Remnic tools and commands, and coordinates Pi
compaction with Remnic's LCM archive.

Installed through `remnic connectors install pi`, Remnic writes an auto-discovered
Pi extension to `~/.pi/agent/extensions/remnic/` and stores the daemon token in
`remnic.config.json` with owner-only permissions.

See the full integration guide in `docs/integration/pi.md`.
