/**
 * Regenerates the canonical drift-gen smoke fixture (issue #1954).
 *
 * Run from the repo root after any drift-gen generator change (which must
 * also bump DRIFT_GEN_VERSION):
 *
 *   pnpm exec tsx packages/bench/src/fixtures/drift-gen-core/regenerate.ts
 *
 * The audit block records the most recent answerability audit for this
 * generator version (dataset runbook, Curation step 3). Re-audit — sample 30
 * probes, answer them using only the gold facts — whenever the generator
 * version changes, and update the block here.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateDriftCorpus } from "../../generators/drift-gen/index.js";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));

const result = await generateDriftCorpus({
  users: 2,
  epochs: 4,
  seed: 11,
  outDir: fixtureDir,
  audit: {
    sampled: 30,
    passed: 30,
    auditor: "Fable-class agent review (issue #1954)",
    date: "2026-07-28",
  },
});

console.log(
  `regenerated drift-gen-core: ${result.manifest.counts.facts} facts, ${result.manifest.counts.probes} probes`,
);
