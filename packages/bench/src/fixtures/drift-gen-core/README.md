# drift-gen-core canonical snapshot

Small committed snapshot of the drift-gen synthetic corpus (issue #1954),
used by tests and CI. Full-size corpora are regenerated locally from seeds
and never committed (dataset runbook, Sanitization step 3).

- Parameters: `--users 2 --epochs 4 --seed 11` (defaults otherwise).
- All content is synthetic: fictional people, companies, cities, products.
- Never hand-edit the generated files. To change the data, change the
  generator under `packages/bench/src/generators/drift-gen/`, bump
  `DRIFT_GEN_VERSION`, and rerun:

  ```bash
  pnpm exec tsx packages/bench/src/fixtures/drift-gen-core/regenerate.ts
  ```

- Validate with:

  ```bash
  remnic bench drift-gen validate packages/bench/src/fixtures/drift-gen-core
  ```

The `audit` block in `dataset.manifest.json` records the answerability audit
for the current generator version (30 sampled probes answered from gold facts
only). Re-audit on every generator version bump.
