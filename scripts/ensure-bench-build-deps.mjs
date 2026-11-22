import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePackageBuild } from "./build-staleness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
