import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePackageBuild } from "./build-staleness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.REMNIC_SKIP_CORE_REBUILD !== "1") {
  ensurePackageBuild(
    repoRoot,
    "@remnic/core",
    path.join(repoRoot, "packages", "remnic-core", "dist", "index.js"),
    [
      path.join(repoRoot, "packages", "remnic-core", "src"),
      path.join(repoRoot, "packages", "remnic-core", "package.json"),
      path.join(repoRoot, "packages", "remnic-core", "tsup.config.ts"),
      path.join(repoRoot, "packages", "remnic-core", "tsconfig.json"),
    ],
  );
}

// #1557: bench now depends on @remnic/coding-graph for the coding-graph
// benchmark harness. Ensure its dist is built before bench's tsup DTS
// generation runs, mirroring the @remnic/core call above.
//
// Guard against recursion: @remnic/coding-graph's own prebuild script calls
// this file. Without the guard, building coding-graph would trigger building
// coding-graph again (infinite loop).
if (!process.env.REMNIC_BUILDING_CODING_GRAPH) {
  process.env.REMNIC_BUILDING_CODING_GRAPH = "1";
  ensurePackageBuild(
    repoRoot,
    "@remnic/coding-graph",
    path.join(repoRoot, "packages", "coding-graph", "dist", "index.js"),
    [
      path.join(repoRoot, "packages", "coding-graph", "src"),
      path.join(repoRoot, "packages", "coding-graph", "package.json"),
      path.join(repoRoot, "packages", "coding-graph", "tsup.config.ts"),
      path.join(repoRoot, "packages", "coding-graph", "tsconfig.json"),
    ],
  );
  delete process.env.REMNIC_BUILDING_CODING_GRAPH;
}
