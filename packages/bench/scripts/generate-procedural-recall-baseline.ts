/**
 * Regenerate the procedural-recall baseline artifact for issue #567 PR 2/5.
 *
 * Deterministic: uses a fixed seed so the committed JSON is reproducible.
 * Run via `tsx packages/bench/scripts/generate-procedural-recall-baseline.ts`
 * from the repo root; commit the resulting JSON.
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runProceduralAblation } from "../src/benchmarks/remnic/procedural-recall/ablation.ts";
import { PROCEDURAL_REAL_SCENARIOS } from "../src/benchmarks/remnic/procedural-recall/real-scenarios.ts";

async function main(): Promise<void> {
  const scenarios = PROCEDURAL_REAL_SCENARIOS.map((s) => ({
    id: s.id,
    prompt: s.prompt,
    procedurePreamble: s.procedurePreamble,
    procedureSteps: s.procedureSteps,
    procedureTags: s.procedureTags,
    expectMatch: s.expectMatch,
  }));

  const artifact = await runProceduralAblation({
    scenarios,
    seed: 0x72656d6e,
    bootstrapIterations: 500,
  });

  const here = path.dirname(fileURLToPath(import.meta.url));
  const outDir = path.resolve(here, "../baselines");
  const outPath = path.join(outDir, "procedural-recall-baseline.json");
  await mkdir(outDir, { recursive: true });
  // Pin `generatedAt` to a stable string so the committed baseline stays
  // byte-stable across regens. Consumers that want wall-clock timing can
  // read `git log` on the file.
  const stamped = { ...artifact, generatedAt: "baseline-v1" };
  await writeFile(outPath, JSON.stringify(stamped, null, 2) + "\n", "utf8");
  console.log(
    `wrote ${outPath} (scenarios=${artifact.fixture.scenarioCount} onScore=${artifact.onScore.toFixed(4)} offScore=${artifact.offScore.toFixed(4)} lift=${artifact.lift.toFixed(4)})`,
  );
}

await main();
