import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensurePackageBuild } from "./build-staleness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Release builds must seed the same freshness marker the recursive wave's
// prebuilds check (scripts/ensure-bench-build-deps.mjs). A plain
// `pnpm --filter @remnic/core build` writes dist without the fingerprint
// sidecar, so the first prebuild inside `pnpm -r` treats core as stale,
// rebuilds it (cleaning dist), and a sibling package's concurrent tsup DTS
// worker reads the half-cleaned dist and fails with TS2307/TS7016
// ("Cannot find module '@remnic/core'").
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
