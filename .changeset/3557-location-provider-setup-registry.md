---
"@remnic/core": patch
---

### Extensible location provider setup registry

Replace the hard-coded `reitti`-only source check in `ensureConfiguredLocationProviders` with a setup registry (`registerLocationProviderSetup`, `unregisterLocationProviderSetup`, `getLocationProviderSetup`, `listLocationProviderSetups`, `resetLocationProviderSetups`) seeded with the built-in `reitti` entry, so additional location provider packages can participate in env-driven bootstrap without modifying `@remnic/core`. Refs #3557.

Stability: stable
