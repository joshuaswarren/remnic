import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePackageBuild } from "./build-staleness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
