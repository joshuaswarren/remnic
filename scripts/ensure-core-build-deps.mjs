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
