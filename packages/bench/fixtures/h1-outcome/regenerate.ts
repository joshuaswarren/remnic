/**
 * Regenerates the committed H1 outcome-prior task family and CI snapshot
 * (issue #1958). Run from the repo root:
 *
 *   pnpm exec tsx packages/bench/fixtures/h1-outcome/regenerate.ts
 *
 * The full 5-user / 12-epoch session tree is not written here. Rebuild it
 * locally with `remnic bench drift-gen --users 5 --epochs 12 --seed 21`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { H1_CI_RECIPE, buildCommittedTaskArtifacts } from "../../src/ablations/outcome-prior-corpus.js";
import { generateDriftCorpus } from "../../src/generators/drift-gen/index.js";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const artifacts = buildCommittedTaskArtifacts();
const ciDir = path.join(fixtureDir, "corpus-ci");

mkdirSync(ciDir, { recursive: true });
writeFileSync(path.join(fixtureDir, "tasks.jsonl"), artifacts.fullTasksJsonl);
const generated = await generateDriftCorpus({
  users: H1_CI_RECIPE.users,
  epochs: H1_CI_RECIPE.epochs,
  seed: H1_CI_RECIPE.seed,
  outDir: ciDir,
});
writeFileSync(path.join(ciDir, "tasks.jsonl"), artifacts.ciTasksJsonl);
writeFileSync(path.join(ciDir, "warm-store.json"), artifacts.warmStoreJson);

console.log(
  `regenerated h1-outcome: full tasks ${artifacts.fullTasksJsonl.trim().split("\n").length}, ci tasks ${artifacts.ciTasksJsonl.trim().split("\n").length}, ci facts ${generated.manifest.counts.facts}`,
);
