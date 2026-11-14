import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

function discovery(apps, title, maxNodes, urlOnly, calls) {
  const env = { PATH: process.env.PATH, PYTHONPATH: STUB, STUB_ATSPI_TREE: JSON.stringify(apps) };
  if (calls) env.STUB_ATSPI_CALLS = calls;
  const args = [READER, "--pid", "4242", `--title=${title}`, "--max-nodes", String(maxNodes)];
  if (urlOnly) args.push("--url-only");
  const done = spawnSync("python3", args, { encoding: "utf8", env });
  assert.equal(done.status, 0, done.stderr);
  return JSON.parse(done.stdout);
}

function callLog(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "atspi-calls-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "calls.log");
  return { file, lines: () => readFileSync(file, "utf8").split("\n").filter(Boolean) };
}

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

test("hidden document subtrees leave the node budget for visible text and are never read", () => {
  const hidden = {
    role: "document web",
    name: "hidden secret",
    text: "hidden secret",
    states: [],
    attributes: { URI: "https://hidden.example.test/" },
    children: Array.from({ length: 60 }, () => ({ role: "label", text: "hidden child secret" })),
  };
  const shown = { role: "document web", text: "visible document content", attributes: { URI: "https://visible.example.test/" } };
  const tabs = { name: "Visible tab - Chromium", role: "frame", children: [hidden, shown] };
  for (const forbidContent of [false, true]) {
    hidden.forbid_content = forbidContent;
    const { out, json } = readWindow(chromium(tabs), tabs.name);
    assert.equal(json.url, "https://visible.example.test/");
    assert.ok(out.includes("visible document content"), "hidden descendants exhausted the visible document's node budget");
    assert.equal(out.includes("hidden secret"), false);
    assert.equal(out.includes("hidden child secret"), false);
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

test("URL discovery bounds wide trees independently of the content node limit", (t) => {
  const log = callLog(t);
  const wide = {
    name: "Wide", role: "frame",
    children: Array.from({ length: 3000 }, () => ({ role: "label" })),
  };
  for (const urlOnly of [false, true]) {
    const json = discovery(chromium(wide), wide.name, 1, urlOnly, log.file);
    assert.equal(json.url, null);
    assert.equal(json.url_incomplete, true);
    assert.ok(log.lines().filter((line) => line.startsWith("role ")).length <= 2000);
  }
});

test("URL discovery bounds child fetches through sparse trees", (t) => {
  const log = callLog(t);
  const sparse = {
    name: "Sparse", role: "frame",
    children: [...Array(5000).fill(null), { role: "document web", attributes: { URI: "https://deep.example/" } }],
  };
  const json = discovery(chromium(sparse), sparse.name, 1, true, log.file);
  assert.equal(json.url, null);
  assert.equal(json.url_incomplete, true);
  assert.ok(log.lines().filter((line) => line.startsWith("child ")).length <= 1003);
});

test("URL discovery does not enter a hidden frame", () => {
  const hidden = {
    name: "Hidden", role: "frame", states: [],
    children: [{ role: "document web", attributes: { URI: "https://hidden.example/" } }],
  };
  for (const more of [[], ["--url-only"]]) {
    const { out, json } = readWindow(chromium(hidden), hidden.name, ...more);
    assert.equal(json.url, null);
    assert.equal(out.includes("hidden.example"), false);
  }
});

test("URL discovery never reads attributes or children under a password field", (t) => {
  const log = callLog(t);
  const login = {
    name: "Sign in", role: "frame",
    children: [{ role: "password text", children: [{
      role: "document web", attributes: { URI: "https://secret.example/" },
    }] }],
  };
  const json = discovery(chromium(login), login.name, 1, true, log.file);
  assert.equal(json.url, null);
  assert.equal(log.lines().some((line) => line.startsWith("attrs ")), false);
  assert.equal(log.lines().includes("child password text"), false);
});

test("URL discovery finds a visible document even with a one-node content limit", () => {
  const page = frame("Docs", "public text", { attributes: { URI: "https://docs.example/" } });
  const json = discovery(chromium(page), page.name, 1, true);
  assert.equal(json.url, "https://docs.example/");
  assert.equal(json.url_incomplete, undefined);
});
