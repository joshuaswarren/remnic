# Compatibility Fixtures

These fixtures model representative repository states for `runCompatChecks`.

- `healthy/`: expected-well-formed plugin repo wiring.
- `missing-manifest/`: plugin manifest file absent.
- `empty-package/`: empty `package.json` to verify parse failure behavior.

Each fixture is read as a full repo root in `tests/compat-fixtures.test.ts`.
