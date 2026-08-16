import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendNodeOption } from "./root-test-runner-env.mjs";
import { ensurePackageBuild } from "./build-staleness.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const rawArgs = process.argv.slice(2);
const separatorIndex = rawArgs.indexOf("--");
const fileArgs = separatorIndex === -1 ? rawArgs : rawArgs.slice(0, separatorIndex);
const runnerArgs = separatorIndex === -1 ? [] : rawArgs.slice(separatorIndex + 1);

if (fileArgs.length === 0) {
  console.error("Usage: npm run test:file -- <test-file> [...test-files] [-- <tsx-args>]");
  process.exit(1);
}

const files = fileArgs.map((fileArg) => {
  const filePath = isAbsolute(fileArg) ? fileArg : resolve(process.cwd(), fileArg);
  if (!existsSync(filePath)) {
    console.error(`Test file not found: ${fileArg}`);
    process.exit(1);
  }
  if (!statSync(filePath).isFile()) {
    console.error(`Test path is not a file: ${fileArg}`);
    process.exit(1);
  }
  return filePath;
});
ensurePackageBuild(
  repoRoot,
  "@remnic/bench",
  join(repoRoot, "packages", "bench", "dist", "index.js"),
  [
    join(repoRoot, "packages", "bench", "src"),
    join(repoRoot, "packages", "bench", "package.json"),
    join(repoRoot, "packages", "bench", "tsup.config.ts"),
    join(repoRoot, "packages", "bench", "tsconfig.json"),
  ],
);

const tsxBin = process.platform === "win32" ? "tsx.cmd" : "tsx";
const workspaceBinDir = join(repoRoot, "node_modules", ".bin");
const result = spawnSync(tsxBin, ["--test", ...runnerArgs, ...files], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PATH: `${workspaceBinDir}${delimiter}${process.env.PATH ?? ""}`,
    NODE_OPTIONS: appendNodeOption(process.env.NODE_OPTIONS, "--conditions=remnic-source"),
  },
  stdio: "inherit",
});

if (result.error) {
  console.error(`Failed to launch ${tsxBin}: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
