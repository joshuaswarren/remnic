import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTool } from "./exec.mjs";
import { focusedWindow, readableWindow, windowById, windowOfPid } from "./hypr.mjs";

const READER = path.join(path.dirname(fileURLToPath(import.meta.url)), "atspi.py");
const DEFAULT_MAX_NODES = 5000;
const SECURE_ROLE = "AXSecureTextField";
const OBJECT_MARK = /\uFFFC/g;
const AT_SPI_PASSWORD_ROLES = new Set(["password text"]);

/** The text-bearing fields of one AT-SPI node, each present only when it holds something. */
function nodeFields(raw) {
  const value = (raw.text ?? "").replace(OBJECT_MARK, "").trim();
  return {
    ...(raw.name ? { title: raw.name } : {}),
    ...(value ? { value } : {}),
    ...(raw.description ? { description: raw.description } : {}),
    ...(raw.showing === false ? { offScreen: true } : {}),
  };
}

/**
 * One AT-SPI node as the capture daemon's AxNode. A password field keeps only its role, so no text of it or
 * of anything under it can leave the helper. Nodes past `budget.left` are dropped.
 */
function toAxNode(raw, budget) {
  budget.left -= 1;
  if (AT_SPI_PASSWORD_ROLES.has(raw.role)) return { role: SECURE_ROLE };
  const children = [];
  for (const child of raw.children ?? []) {
    if (budget.left <= 0) break;
    children.push(toAxNode(child, budget));
  }
  return { role: raw.role, ...nodeFields(raw), ...(children.length > 0 ? { children } : {}) };
}

/**
 * The AT-SPI facts for one window, or null (with the reason on stderr) when AT-SPI cannot be read.
 * `urlOnly` keeps every node name and text out of the reader's answer.
 */
async function readAtspi(window, maxNodes, urlOnly) {
  try {
    const args = [READER, "--pid", String(window.pid), `--title=${window.title}`, "--max-nodes", String(maxNodes)];
    if (urlOnly) args.push("--url-only");
    const out = await runTool("python3", args, { hint: "install python and its gobject bindings" });
    return JSON.parse(out.toString("utf8"));
  } catch (error) {
    process.stderr.write(`remnic-capture-helper: AT-SPI is not available: ${error.stderr ?? error.message}\n`);
    return null;
  }
}

async function targetWindow({ pid, windowId }) {
  if (windowId !== undefined) return windowById(windowId);
  return pid === undefined ? focusedWindow() : windowOfPid(pid);
}

/**
 * `ax-snapshot`: the focused window, the window of `--pid` or the window `--window` names, with its
 * accessibility tree. With `--window-only` the answer has the window's app, title, id and address and no tree.
 * With `--title T`, a window that no longer has the title T is answered like an app without an accessibility
 * tree: its facts with the new title and no read, so the caller checks the new title before anything is read.
 */
export async function axSnapshot({ pid, windowId, expectTitle, windowOnly = false, maxNodes = DEFAULT_MAX_NODES }) {
  const window = await targetWindow({ pid, windowId });
  const retitled = expectTitle !== undefined && window.title !== expectTitle;
  const facts = retitled ? null : await readAtspi(window, maxNodes, windowOnly);
  const snapshot = { app: window.class, windowTitle: window.title, windowId: window.address };
  if (!windowOnly) {
    snapshot.tree = facts?.found ? toAxNode(facts.root, { left: maxNodes }) : { role: "window" };
  }
  if (facts?.found && typeof facts.url === "string" && facts.url) snapshot.browserUrl = facts.url;
  process.stdout.write(`${JSON.stringify(snapshot)}\n`);
  return 0;
}

/**
 * `ocr-window`: the text of one window. The pixels come from the output at the window's rectangle and go
 * through two pipes, so nothing is written to disk. A window that is hidden, off screen or covered is refused.
 */
export async function ocrWindow({ windowId }) {
  const target = windowId === undefined ? await focusedWindow() : { address: windowId };
  const window = await readableWindow(target.address);
  const [x, y] = window.at;
  const [width, height] = window.size;
  const hint = (name) => `install the ${name} package`;
  const png = await runTool("grim", ["-g", `${x},${y} ${width}x${height}`, "-t", "png", "-"], { hint: hint("grim") });
  const text = await runTool("tesseract", ["stdin", "stdout", "-l", "eng"], { input: png, hint: hint("tesseract") });
  process.stdout.write(`${JSON.stringify({ text: text.toString("utf8").trimEnd() })}\n`);
  return 0;
}
