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
ensurePackageBuild(
  repoRoot,
  "@remnic/export-weclone",
  path.join(repoRoot, "packages", "export-weclone", "dist", "index.js"),
  [
    path.join(repoRoot, "packages", "export-weclone", "src"),
    path.join(repoRoot, "packages", "export-weclone", "package.json"),
    path.join(repoRoot, "packages", "export-weclone", "tsup.config.ts"),
    path.join(repoRoot, "packages", "export-weclone", "tsconfig.json"),
  ],
);
