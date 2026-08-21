import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PINNED_PNPM = "pnpm@10.32.1";
const PINNED_VERSION = PINNED_PNPM.slice("pnpm@".length);

const forwarded = process.argv.slice(2);
const isWindows = process.platform === "win32";

/**
 * True when a pnpm on PATH reports exactly the pinned version.
 *
 * The `npm exec` fallback is an npm-registry round trip per invocation, and the
 * root `check-types` script invokes this wrapper three times. A transient
 * registry failure there (observed: ETIMEDOUT resolving the pnpm package) fails
 * the `checks` job and cascades into the required `quality` gate on a PR whose
 * code is clean. CI already installs the pinned version via pnpm/action-setup,
 * so preferring PATH removes that network dependency. Version equality keeps
 * the pin authoritative — a different local pnpm still routes through npm.
 */
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
