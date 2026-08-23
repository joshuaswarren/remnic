import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePackageBuild } from "./build-staleness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// @remnic/bench-ui resolves @remnic/bench through the dependency's dist
// types/import exports; only its test script opts into the remnic-source
// condition. In a fresh workspace with no packages/bench/dist, the
// documented dev/check-types/build commands fail before doing any work,
// so prepare the dependency build the same way @remnic/cli does via
// ensure-cli-bench-build-deps.mjs. Building @remnic/bench runs its own
// prebuild, which first ensures @remnic/core and @remnic/coding-graph.
ensurePackageBuild(
  repoRoot,
  "@remnic/bench",
  path.join(repoRoot, "packages", "bench", "dist", "index.js"),
  [
    path.join(repoRoot, "packages", "bench", "src"),
    path.join(repoRoot, "packages", "bench", "package.json"),
    path.join(repoRoot, "packages", "bench", "tsup.config.ts"),
    path.join(repoRoot, "packages", "bench", "tsconfig.json"),
  ],
);
