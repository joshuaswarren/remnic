import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pnpmArgs = ["exec", "--yes", "pnpm@10.32.1", "--", ...process.argv.slice(2)];
const isWindows = process.platform === "win32";
const command = isWindows ? process.env.ComSpec ?? "cmd.exe" : "bash";
const args = isWindows
  ? ["/d", "/s", "/c", "npm.cmd", ...pnpmArgs]
  : [fileURLToPath(new URL("./pnpm.sh", import.meta.url)), ...process.argv.slice(2)];
const result = spawnSync(command, args, { stdio: "inherit" });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
