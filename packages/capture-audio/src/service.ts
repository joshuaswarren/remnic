/**
 * `install-service` support (issue #1897) — render and install a per-user
 * background service that runs the capture-audio daemon in live-capture mode.
 *
 * macOS uses a launchd LaunchAgent (`~/Library/LaunchAgents/<label>.plist`);
 * Linux uses a systemd user unit (`~/.config/systemd/user/<name>.service`).
 * The renderers are pure (deterministic strings) and `installService` /
 * `uninstallService` take injected filesystem + environment seams so the whole
 * surface is testable without touching the real user launch directories.
 */

import path from "node:path";

import { CaptureConfigError } from "./errors.js";

export const DEFAULT_SERVICE_LABEL = "com.remnic.capture-audio";
const SYSTEMD_UNIT_NAME = "remnic-capture-audio.service";

export interface ServiceSpec {
  /** argv that launches the daemon, e.g. [node, cliEntry, "start", "--foreground", "--capture"]. */
  programArguments: string[];
  logPath: string;
  label?: string;
}

export interface ServicePlan {
  platform: NodeJS.Platform;
  /** Absolute path the unit file is written to. */
  path: string;
  contents: string;
  /** One-line operator instruction to load/enable the service. */
  loadHint: string;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Render a launchd LaunchAgent plist that keeps the daemon alive at login. */
export function renderLaunchAgent(spec: ServiceSpec): string {
  const label = spec.label ?? DEFAULT_SERVICE_LABEL;
  const args = spec.programArguments.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(spec.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(spec.logPath)}</string>
</dict>
</plist>
`;
}

/** systemd quotes args that contain whitespace or its quote/backslash chars. */
function systemdArg(value: string): string {
  if (value === "" || /[\s"'\\]/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

/** Render a systemd user unit that restarts the daemon on failure. */
export function renderSystemdUnit(spec: ServiceSpec): string {
  const execStart = spec.programArguments.map(systemdArg).join(" ");
  return `[Unit]
Description=Remnic desktop audio capture daemon
After=default.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export interface PlanServiceDeps {
  platform: NodeJS.Platform;
  home: string;
  spec: ServiceSpec;
}

/** Decide the unit file path + contents for the current platform. */
export function planService(deps: PlanServiceDeps): ServicePlan {
  const label = deps.spec.label ?? DEFAULT_SERVICE_LABEL;
  if (deps.platform === "darwin") {
    const target = path.join(deps.home, "Library", "LaunchAgents", `${label}.plist`);
    return {
      platform: deps.platform,
      path: target,
      contents: renderLaunchAgent(deps.spec),
      loadHint: `launchctl load ${target}`,
    };
  }
  if (deps.platform === "linux") {
    const target = path.join(deps.home, ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
    return {
      platform: deps.platform,
      path: target,
      contents: renderSystemdUnit(deps.spec),
      loadHint: `systemctl --user enable --now ${SYSTEMD_UNIT_NAME}`,
    };
  }
  throw new CaptureConfigError(`install-service is unsupported on platform "${deps.platform}"`);
}

export interface InstallServiceDeps extends PlanServiceDeps {
  mkdir: (dir: string) => void;
  writeFile: (file: string, contents: string) => void;
  /** True to overwrite an already-installed unit. */
  force?: boolean;
  exists?: (file: string) => boolean;
}

/** Write the planned unit file, creating its directory. Returns the plan. */
export function installService(deps: InstallServiceDeps): ServicePlan {
  const plan = planService(deps);
  if (!deps.force && deps.exists?.(plan.path)) {
    throw new CaptureConfigError(`a capture-audio service is already installed at ${plan.path} (use --force to replace)`);
  }
  deps.mkdir(path.dirname(plan.path));
  deps.writeFile(plan.path, plan.contents);
  return plan;
}

export interface UninstallServiceDeps extends PlanServiceDeps {
  remove: (file: string) => void;
  exists: (file: string) => boolean;
}

/** Remove the installed unit file. Returns the plan + whether a file was removed. */
export function uninstallService(deps: UninstallServiceDeps): { plan: ServicePlan; removed: boolean } {
  const plan = planService(deps);
  if (!deps.exists(plan.path)) return { plan, removed: false };
  deps.remove(plan.path);
  return { plan, removed: true };
}
