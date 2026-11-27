import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PINNED_PNPM = "pnpm@10.32.1";
const PINNED_VERSION = PINNED_PNPM.slice("pnpm@".length);

const forwarded = process.argv.slice(2);
const isWindows = process.platform === "win32";

function pinnedPnpmOnPath() {
  const probe = spawnSync(isWindows ? "pnpm.cmd" : "pnpm", ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (probe.error || probe.status !== 0) return false;
  return (probe.stdout ?? "").trim() === PINNED_VERSION;
}

const result = pinnedPnpmOnPath()
  ? spawnSync(isWindows ? "pnpm.cmd" : "pnpm", forwarded, {
      stdio: "inherit",
      windowsHide: true,
      shell: isWindows,
    })
  : spawnSync(
      isWindows ? process.env.ComSpec ?? "cmd.exe" : "bash",
      isWindows
        ? ["/d", "/s", "/c", "npm.cmd", "exec", "--yes", PINNED_PNPM, "--", ...forwarded]
        : [fileURLToPath(new URL("./pnpm.sh", import.meta.url)), ...forwarded],
      { stdio: "inherit" },
    );

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
