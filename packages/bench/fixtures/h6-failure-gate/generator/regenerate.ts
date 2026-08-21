import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  H6_FROZEN_SEED,
  generateH6BenchmarkDataset,
  writeH6FixtureBundle,
} from "../../../src/coding-graph/repo-gen/index.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

export async function regenerateH6Fixtures(outDir?: string): Promise<string> {
  const dataset = await generateH6BenchmarkDataset(H6_FROZEN_SEED);
  return writeH6FixtureBundle(outDir ?? join(SCRIPT_DIR, ".."), dataset);
}

if (process.argv[1] && process.argv[1].endsWith("regenerate.ts")) {
  void regenerateH6Fixtures().then((path) => {
    console.log(`Regenerated H6 dataset manifest and task trees at ${path}`);
  });
}
