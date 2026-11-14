import { runTool } from "./exec.mjs";

const HINT = "the Linux screen helper needs Hyprland";

async function hyprJson(subcommand) {
  const out = await runTool("hyprctl", ["-j", subcommand], { hint: HINT });
  try {
    return JSON.parse(out.toString("utf8"));
  } catch {
    throw new Error(`hyprctl ${subcommand} did not return JSON`);
  }
}

const isWindow = (c) => c.mapped !== false && c.hidden !== true;

/** The window with keyboard focus. Rejects when none has it. */
export async function focusedWindow() {
  const active = await hyprJson("activewindow");
  if (!active?.address) throw new Error("no focused window");
  return active;
}

/** The mapped windows, in Hyprland order. */
export async function windows() {
  return (await hyprJson("clients")).filter(isWindow);
}

/** The window whose process is `pid`; the first one when a process has several. */
export async function windowOfPid(pid) {
  const found = (await windows()).find((w) => w.pid === pid);
  if (!found) throw new Error(`no window for process ${pid}`);
  return found;
}

/** The mapped window at `address`. Rejects when it is gone. */
export async function windowById(address) {
  const found = (await windows()).find((w) => w.address === address);
  if (!found) throw new Error(`no window ${address}`);
  return found;
}

const overlaps = (a, b) =>
  a.at[0] < b.at[0] + b.size[0] && b.at[0] < a.at[0] + a.size[0] && a.at[1] < b.at[1] + b.size[1] && b.at[1] < a.at[1] + a.size[1];

/** The ids of the workspaces a monitor shows right now, including a shown special workspace. */
const visibleWorkspaces = (monitors) =>
  new Set(monitors.flatMap((m) => [m.activeWorkspace?.id, m.specialWorkspace?.id]).filter((id) => id));

export async function workspaceVisible(window) {
  return visibleWorkspaces(await hyprJson("monitors")).has(window.workspace?.id);
}

/** The window at `address`, plus the data to decide if its pixels can be read right now. */
export async function readableWindow(address) {
  const [all, monitors] = await Promise.all([windows(), hyprJson("monitors")]);
  const target = all.find((w) => w.address === address);
  if (!target) throw new Error(`no window ${address}`);
  const visible = visibleWorkspaces(monitors);
  if (!visible.has(target.workspace?.id)) throw new Error(`window ${address} is not on a visible workspace`);
  if (all.some((w) => w.address !== address && visible.has(w.workspace?.id) && overlaps(target, w))) {
    throw new Error(`window ${address} is covered by another window; not reading it`);
  }
  return target;
}
