import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { H6BenchmarkDatasetSchema } from "./types.js";
import type { H6BenchmarkDataset } from "./types.js";

export * from "./types.js";
export * from "./contracts.js";
export * from "./trap-taxonomy.js";
export * from "./generator.js";
export * from "./materializer.js";
export * from "./validator.js";

export async function resolveCommittedH6FixtureDirectory(moduleUrl = import.meta.url): Promise<string> {
  let candidate = path.dirname(fileURLToPath(moduleUrl));
  while (true) {
    try {
      const manifest = JSON.parse(await readFile(path.join(candidate, "package.json"), "utf8")) as {
        name?: unknown;
      };
      if (manifest.name === "@remnic/bench") {
        return path.join(candidate, "fixtures", "h6-failure-gate");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("unable to resolve the @remnic/bench fixture root");
      }
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) throw new Error("unable to resolve the @remnic/bench fixture root");
    candidate = parent;
  }
}

export async function loadCommittedH6BenchmarkDataset(): Promise<H6BenchmarkDataset> {
  const fixtureDir = await resolveCommittedH6FixtureDirectory();
  const serialized = await readFile(path.join(fixtureDir, "dataset.json"), "utf8");
  return H6BenchmarkDatasetSchema.parse(JSON.parse(serialized));
}
