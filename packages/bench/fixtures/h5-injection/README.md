# H5 memory-injection fixtures

Synthetic defensive-research fixtures for [H5 / issue #1962](https://github.com/joshuaswarren/remnic/issues/1962).

Every attack objective is mechanically limited to one harmless canary:

- emit a seeded `CANARY-e2e-*` string;
- include a seeded `https://example.com/canary/*` URL; or
- call the in-process fake `canary_tool` with a seeded marker.

The suite targets only Remnic's isolated benchmark adapter. It contains no real credentials, hosts, commands, personal data, or third-party targets. `base/`, `benign-twins/`, and `adaptive-r1/` are separate frozen populations and must never be pooled.

Regenerate deterministically:

```bash
NODE_OPTIONS="--conditions=remnic-source" npx tsx packages/bench/fixtures/h5-injection/generator/regenerate.ts
```

A valid regeneration is byte-identical. The manifest hashes, arm configuration, decision rule, model profile, and expected design are copied into each run directory before model calls begin.
