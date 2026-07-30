# check-config-contract v2 — parser-derived key parity (issue #1990)

`npm run check-config-contract` verifies the config surface from FOUR sides.
v1 (unchanged) checks top-level parity between the `PluginConfig` interface,
`parseConfig()`'s return, and the manifest schema, plus §33 disable-value
consistency. v2 adds parser-derived NESTED key-path parity, closing the
class reviewers caught on PR #1923 (`codingKnowledge.lsp` parsed but absent
from every manifest — three review threads across two bots).

## How v2 works

1. The script reads core `parseConfig` and each parser it calls. It also reads
   host parsers. OpenClaw's `parseOpenClawBridgeConfig` is one of them. It
   tracks raw input names and aliases. Nested blocks become dotted paths such
   as `wearables.fusion.enabled`. It reads static Zod object definitions. The
   snapshot in `scripts/config-contract/parsed-keys.snapshot.json` records the
   full config surface. `tests/config-contract-extractor.test.ts` checks it.
   Regenerate the snapshot to make a config change visible in review:

   ```sh
   npx tsx scripts/config-contract/extract-parsed-keys.ts > scripts/config-contract/parsed-keys.snapshot.json
   ```

2. `scripts/config-contract/contract-check.ts` compares the parsed key set
   against:
   - both plugin manifests' `configSchema`
     (`packages/plugin-openclaw/openclaw.plugin.json`,
     `packages/shim-openclaw-engram/openclaw.plugin.json`) —
     `missing-schema` / `dead-schema`;
   - `docs/config-reference.md` — `documented-nonexistent` (dotted paths
     under known top-level keys that match nothing) and `undocumented-key`
     (a parsed key mentioned nowhere by full path, leaf, or deeper path);
   - the extractor's `unparseable-construct` reports (dynamic key loops,
     computed access) — loud, never silently skipped.

3. **Grandfather manifest** (`scripts/config-contract/grandfathered.json`,
   umbrella #1988 decision C): each accepted current violation carries the
   issue tracking its removal. The check FAILS on any violation not in the
   manifest, and FAILS on any STALE entry (violation fixed but entry not
   pruned) — the manifest may only shrink.

## When your PR fails this check

- **`missing-schema`**: you parsed a new config key. Add it to BOTH
  manifests' `configSchema` (and the root `openclaw.plugin.json` for
  consistency), document it in `docs/config-reference.md`, and regenerate
  the snapshot.
- **`dead-schema`**: a schema key no longer corresponds to anything parsed.
  Delete the schema entry (or fix the parser if the deletion was the bug).
- **`undocumented-key` / `documented-nonexistent`**: fix the docs.
- **`unparseable-construct`**: the extractor cannot see through a dynamic
  construct. Prefer restructuring to static key access; genuinely dynamic
  surfaces get a grandfather entry with a tracking issue.
- **`stale-grandfather`**: you fixed a grandfathered violation — prune its
  entry from `grandfathered.json` in the same PR.

v2 checks key PRESENCE only; type/enum parity is a tracked follow-up.
