import { spawnSync } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("Usage: node scripts/with-source-conditions.mjs <command> [args...]");
  process.exit(2);
}

const nodeOptions = [process.env.NODE_OPTIONS?.trim(), "--conditions=remnic-source"].filter(Boolean).join(" ");
const result = spawnSync(command, args, {
  stdio: "inherit",
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
