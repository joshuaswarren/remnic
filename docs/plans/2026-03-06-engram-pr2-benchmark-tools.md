# PR2 Benchmark Pack Validator And Import Tools

**PR title target:** `feat: add benchmark pack validate/import tools`

## Goal

Ship the next benchmark-first slice after PR1:

- validate benchmark packs before they are copied into Engram
- import validated packs into Engram's eval store
- keep the pack contract small and operationally obvious
- update README and eval docs to reflect the real shipped CLI surface

This PR still does **not** change live recall, extraction, or ranking behavior.

## Why This Slice Comes Next

PR1 created the storage contract and status reporting. The next bottleneck is operational: there is no safe, standard way to verify or install benchmark packs. That blocks shadow mode, CI benchmark gates, and benchmark sharing across repos or operators.

## Scope

### Code

- `src/evals.ts`
- `src/cli.ts`

### Tests

- `tests/evals-benchmark-tools.test.ts`

### Docs

- `README.md`
- `docs/config-reference.md`
- `docs/evaluation-harness.md`
- `docs/plans/2026-03-06-engram-agentic-memory-roadmap.md`
- `docs/plans/2026-03-06-engram-pr2-benchmark-tools.md`

## Contract

### Validation input

Supported source shapes:

1. A JSON manifest file
2. A benchmark pack directory with a root `manifest.json`

The validator must:

- parse and validate the manifest with the existing PR1 schema
- return benchmark metadata (`benchmarkId`, title, case count, tags, source links)
- fail clearly on missing/invalid manifests

### Import behavior

The importer must:

- validate before copying
- copy into `state/evals/benchmarks/<benchmarkId>/`
- write the manifest as `manifest.json`
- preserve additional files when importing from a directory
- reject overwriting an existing benchmark unless `--force` is set

## CLI Surface

```bash
openclaw engram benchmark-validate --path <manifest-or-pack>
openclaw engram benchmark-import --path <manifest-or-pack> [--force]
```

Both commands should work even if `evalHarnessEnabled` is `false`, because operators need to prepare benchmark packs before turning on benchmark bookkeeping.

## Tests Required

1. Validate a manifest JSON file successfully
2. Validate a directory-root `manifest.json` successfully
3. Import a manifest file into the eval benchmark store
4. Import a directory pack and preserve extra files
5. Reject import overwrite without `--force`
6. Allow overwrite with `--force`

## Verification Gate

Run before pushing:

1. `npx tsx --test tests/evals-benchmark-tools.test.ts tests/cli-benchmark-status.test.ts tests/config-eval-harness.test.ts`
2. `npm run check-types`
3. `npm test`
4. `npm run build`

## Follow-On PRs Unblocked By PR2

- PR3 shadow recording for recall behavior
- PR4 CI benchmark delta gating
- PR5 objective-state memory store
