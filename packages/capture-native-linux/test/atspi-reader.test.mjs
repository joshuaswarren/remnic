import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Runs the real atspi.py against a stub gi module, so the frame it picks is the one under test.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READER = path.join(HERE, "..", "src", "atspi.py");
const STUB = path.join(HERE, "fixtures", "stub-gi");

const frame = (name, text, extra = {}) => ({ name, role: "frame", children: [{ role: "document web", text, ...extra }] });
const chromium = (...frames) => [{ pid: 4242, children: frames }];

function readWindow(apps, title, ...more) {
  const done = spawnSync("python3", [READER, "--pid", "4242", `--title=${title}`, "--max-nodes", "50", ...more], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, PYTHONPATH: STUB, STUB_ATSPI_TREE: JSON.stringify(apps) },
  });
  assert.equal(done.status, 0, done.stderr);
  return { out: done.stdout, json: JSON.parse(done.stdout) };
}

const VAULT = frame("Vault notes - Chromium", "vault secret: 4471");
const PLAN = frame("Quarterly plan - Chromium", "plan text");

test("the frame named exactly like the window is the one read", () => {
  const { json } = readWindow(chromium(VAULT, PLAN), "Quarterly plan - Chromium");
  assert.equal(json.found, true);
  assert.equal(json.root.name, "Quarterly plan - Chromium");
  assert.equal(JSON.stringify(json).includes("vault secret"), false);
});

test("a title that matches no frame reads nothing, even when one frame is active", () => {
  const active = frame("Vault notes - Chromium", "vault secret: 4471", {});
  active.states = ["showing", "active"];
  const { out, json } = readWindow(chromium(active, PLAN), "Quarterly plan \u2013 Chromium");
  assert.deepEqual(json, { found: false });
  assert.equal(out.includes("vault secret"), false);
});

test("a process with one frame of another name is not read either", () => {
  const { json } = readWindow(chromium(VAULT), "Quarterly plan - Chromium");
  assert.deepEqual(json, { found: false });
});

test("two frames with the same name are ambiguous and are not read", () => {
  const { json } = readWindow(chromium(frame("New Tab", "first"), frame("New Tab", "second")), "New Tab");
  assert.deepEqual(json, { found: false });
});

test("--url-only on a title that matches no frame reports no address", () => {
  const apps = chromium(frame("Vault notes - Chromium", "x", { attributes: { URI: "https://vault.example.test/" } }));
  const { json } = readWindow(apps, "Quarterly plan - Chromium", "--url-only");
  assert.deepEqual(json, { found: false });
});
