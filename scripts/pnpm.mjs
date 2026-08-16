import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pnpmArgs = ["exec", "--yes", "pnpm@10.32.1", "--", ...process.argv.slice(2)];
const command = process.platform === "win32" ? "npm.cmd" : "bash";
const args =
  process.platform === "win32"
    ? pnpmArgs
    : [fileURLToPath(new URL("./pnpm.sh", import.meta.url)), ...process.argv.slice(2)];
const result = spawnSync(command, args, { stdio: "inherit" });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
