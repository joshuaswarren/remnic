---
"@remnic/cli": patch
"@remnic/plugin-openclaw": patch
"@joshuaswarren/openclaw-engram": patch
---

Detect legacy macOS `ai.remnic.server` launchd services as Remnic daemons.

The OpenClaw bridge now delegates when the legacy service plist is present and
healthy, and also performs a local health probe before selecting embedded mode.
The CLI daemon commands now share service candidate metadata, include the legacy
`ai.remnic.server` label for status/start/stop/uninstall, and resolve a global
`remnic-server` binary from PATH before falling back to TypeScript source during
daemon install.
