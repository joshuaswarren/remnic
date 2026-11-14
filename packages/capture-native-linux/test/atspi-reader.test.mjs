import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

test("the address is the one of the document that is showing, not of a hidden document before it", () => {
  const hidden = { role: "document web", text: "allowed page", states: [], attributes: { URI: "https://allowed.example.test/" } };
  const shown = { role: "document web", text: "vault page", attributes: { URI: "https://vault.example.test/" } };
  const tabs = { name: "Two tabs - Chromium", role: "frame", children: [hidden, shown] };
  for (const more of [[], ["--url-only"]]) {
    const { json } = readWindow(chromium(tabs), "Two tabs - Chromium", ...more);
    assert.equal(json.url, "https://vault.example.test/");
  }
});

test("a password field is never read: no name, description or text of it or of its children leaves the reader", () => {
  const log = path.join(mkdtempSync(path.join(tmpdir(), "atspi-log-")), "reads.log");
  const login = {
    name: "Sign in",
    role: "frame",
    children: [
      { role: "label", text: "Account", name: "Account" },
      {
        role: "password text",
        name: "PIN 4471",
        description: "your pin",
        text: "hunter2",
        children: [{ role: "label", name: "inner-secret", text: "inner-secret" }],
      },
    ],
  };
  const done = spawnSync("python3", [READER, "--pid", "4242", "--title=Sign in", "--max-nodes", "50"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, PYTHONPATH: STUB, STUB_ATSPI_TREE: JSON.stringify(chromium(login)), STUB_ATSPI_LOG: log },
  });
  assert.equal(done.status, 0, done.stderr);
  for (const secret of ["hunter2", "PIN 4471", "your pin", "inner-secret"]) {
    assert.equal(done.stdout.includes(secret), false, `${secret} left the reader`);
  }
  const password = JSON.parse(done.stdout).root.children.find((node) => node.role === "password text");
  assert.deepEqual(password, { role: "password text" });
  const reads = existsSync(log) ? readFileSync(log, "utf8").split("\n") : [];
  assert.equal(reads.includes("password text"), false, "the reader asked for the text of a password field");
  assert.equal(reads.includes("label"), true, "other text is still read");
});
