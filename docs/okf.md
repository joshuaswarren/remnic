# Open Knowledge Format (OKF)

Remnic memory directories are OKF v0.1 knowledge bundles: markdown files with YAML frontmatter. `category` stays the canonical Remnic field. `type` is inert interop metadata.

Spec (v0.1 revision): https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/ee67a5ca27044ebe7c38385f5b6cffc2305a9c1a/okf/SPEC.md

## Commands

- `remnic okf lint` — report missing frontmatter or `type`. Encrypted files are skipped. Exit 1 when findings remain. `--json` prints the result object.
- `remnic okf sweep` — add missing `type` values without bumping `updated`. Gated by `okf.sweepEnabled`.

## Config

```json
{
  "okf": {
    "conformanceEnabled": true,
    "sweepEnabled": false
  }
}
```

`conformanceEnabled: false` stops new `type` emission and profile frontmatter. `sweepEnabled: false` is the documented disable for the legacy backfill.

## Mapping

See `packages/remnic-core/src/okf/type-mapping.ts`. `category: fact` → `type: Memory Fact`. Unknown categories → `Memory`. Entity kinds map to Person/Company/Project/Entity. Profile → `Profile`.
