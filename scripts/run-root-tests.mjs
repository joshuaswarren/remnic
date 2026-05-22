import { spawnSync } from "node:child_process";
import process from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { appendNodeOption } from "./root-test-runner-env.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tsxBin = process.platform === "win32" ? "tsx.cmd" : "tsx";
const testArgs = [
  "--test",
  "tests/**/*.test.ts",
  "packages/*/src/**/*.test.ts",
  "packages/*/src/**/*.test.tsx",
  "dashboard/lib/*.test.ts",
  "integrations/amb/*.test.mjs",
];

process.env.NODE_OPTIONS = appendNodeOption(
  process.env.NODE_OPTIONS,
  "--conditions=remnic-source",
);

const result = spawnSync(tsxBin, testArgs, {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
