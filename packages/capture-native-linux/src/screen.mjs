import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTool } from "./exec.mjs";
import { focusedWindow, readableWindow, windowById, windowOfPid, workspaceVisible } from "./hypr.mjs";

const READER = path.join(path.dirname(fileURLToPath(import.meta.url)), "atspi.py");
const DEFAULT_MAX_NODES = 5000;
const SECURE_ROLE = "AXSecureTextField";
const OBJECT_MARK = /\uFFFC/g;
const AT_SPI_PASSWORD_ROLES = new Set(["password text"]);


/** The text-bearing fields of one AT-SPI node, each present only when it holds something. */
function nodeFields(raw) {
  const value = (raw.text ?? "").replace(OBJECT_MARK, "").trim();
  const fields = {};
  if (raw.name) fields.title = raw.name;
  if (value) fields.value = value;
  if (raw.description) fields.description = raw.description;
  if (raw.showing === false) fields.offScreen = true;
  return fields;
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
  const node = { role: raw.role, ...nodeFields(raw) };
  if (children.length > 0) node.children = children;
  return node;
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
  let facts = null;
  if (!retitled) {
    if (await workspaceVisible(window)) facts = await readAtspi(window, maxNodes, windowOnly);
    else process.stderr.write(`remnic-capture-helper: window ${window.address} is not on a visible workspace; not reading it\n`);
  }
  const snapshot = { app: window.class, windowTitle: window.title, windowId: window.address };
  if (!windowOnly) {
    snapshot.tree = facts?.found ? toAxNode(facts.root, { left: maxNodes }) : { role: "window" };
  }
  if (facts?.found && facts.url) snapshot.browserUrl = String(facts.url);
  process.stdout.write(`${JSON.stringify(snapshot)}\n`);
  return 0;
}

/** Composited crops cannot establish frame-bound window ownership. Keep the preflight, but never sample pixels. */
export async function ocrWindow({ windowId, expectTitle }) {
  const target = windowId === undefined ? await focusedWindow() : { address: windowId };
  const window = await readableWindow(target.address);
  const retitled = (now) => expectTitle !== undefined && now.title !== expectTitle;
  const refuse = (now) => process.stdout.write(`${JSON.stringify({ text: "", windowTitle: now.title })}\n`);
  if (retitled(window)) {
    refuse(window);
    return 0;
  }
  throw new Error("OCR is unavailable on Linux: composited crops have no frame-bound window identity; use AT-SPI accessibility capture");
}
