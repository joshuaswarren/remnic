import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePackageBuild, runPnpm } from "./build-staleness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(args) {
  runPnpm(repoRoot, args);
}

const coreSourcePaths = [
  path.join(repoRoot, "packages", "remnic-core", "src"),
  path.join(repoRoot, "packages", "remnic-core", "package.json"),
  path.join(repoRoot, "packages", "remnic-core", "tsup.config.ts"),
  path.join(repoRoot, "packages", "remnic-core", "tsconfig.json"),
];
const benchSourcePaths = [
  path.join(repoRoot, "packages", "bench", "src"),
  path.join(repoRoot, "packages", "bench", "package.json"),
  path.join(repoRoot, "packages", "bench", "tsup.config.ts"),
  path.join(repoRoot, "packages", "bench", "tsconfig.json"),
];

ensurePackageBuild(
  repoRoot,
  "@remnic/core",
  path.join(repoRoot, "packages", "remnic-core", "dist", "index.js"),
  coreSourcePaths,
);
ensurePackageBuild(
  repoRoot,
  "@remnic/bench",
  path.join(repoRoot, "packages", "bench", "dist", "index.js"),
  benchSourcePaths,
);

run(["exec", "tsx", "packages/remnic-cli/src/index.ts", "bench", ...process.argv.slice(2)]);
