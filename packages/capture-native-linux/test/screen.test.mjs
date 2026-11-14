import assert from "node:assert/strict";
import test from "node:test";

import { run } from "./harness.mjs";
import { client, fakeDesktop } from "./screen-harness.mjs";

const EDITOR = client();
const BROWSER = client({ address: "0xb2", at: [900, 80], size: [800, 600], class: "chromium", title: "Docs - Chromium", pid: 5151 });
const SENTENCE = "The quick brown fox jumps over the lazy dog 4172";

const atspiTree = (children) => ({
  found: true,
  root: { role: "frame", name: "Notes - Editor", showing: true, children },
});

async function helper(args, desktop) {
  const child = run(args, desktop.env);
  const { code } = await child.exited;
  return { code, stdout: child.stdout(), stderr: child.stderr(), json: () => JSON.parse(child.stdout()) };
}

test("ax-snapshot returns app, title, window id and the tree of the focused window", async () => {
  const desktop = fakeDesktop({
    active: EDITOR,
    clients: [EDITOR, BROWSER],
    atspi: atspiTree([{ role: "text", name: "", text: SENTENCE, showing: true, children: [] }]),
  });
  const result = await helper(["ax-snapshot", "--frontmost"], desktop);
  assert.equal(result.code, 0, result.stderr);
  const snapshot = result.json();
  assert.equal(snapshot.app, "org.example.editor");
  assert.equal(snapshot.windowTitle, "Notes - Editor");
  assert.equal(snapshot.windowId, "0xa1");
  assert.equal(snapshot.tree.role, "frame");
  assert.deepEqual(snapshot.tree.children, [{ role: "text", value: SENTENCE }]);
  const [call] = desktop.calls("python3");
  assert.match(call, /--pid 4242 /);
  assert.match(call, /--title=Notes - Editor/);
});

test("ax-snapshot --pid reads the window of that process, not the focused one", async () => {
  const desktop = fakeDesktop({ active: EDITOR, clients: [EDITOR, BROWSER], atspi: atspiTree([]) });
  const result = await helper(["ax-snapshot", "--pid", "5151"], desktop);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json().windowId, "0xb2");
  assert.equal(result.json().app, "chromium");
  assert.match(desktop.calls("python3")[0], /--pid 5151 /);
});

test("ax-snapshot --window-only gives the window facts and url and asks the reader for no node text", async () => {
  const desktop = fakeDesktop({
    active: BROWSER,
    clients: [BROWSER],
    atspi: { found: true, url: "https://example.org/a", root: { role: "frame", name: "x", text: SENTENCE, showing: true, children: [] } },
  });
  const result = await helper(["ax-snapshot", "--frontmost", "--window-only"], desktop);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.json(), {
    app: "chromium",
    windowTitle: "Docs - Chromium",
    windowId: "0xb2",
    browserUrl: "https://example.org/a",
  });
  assert.doesNotMatch(result.stdout, new RegExp(SENTENCE));
  assert.match(desktop.calls("python3")[0], /--url-only/);
});

test("ax-snapshot --window-only on an app outside the accessibility bus still answers with no url", async () => {
  const desktop = fakeDesktop({ active: EDITOR, clients: [EDITOR], atspi: { found: false } });
  const result = await helper(["ax-snapshot", "--window-only"], desktop);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.json(), { app: "org.example.editor", windowTitle: "Notes - Editor", windowId: "0xa1" });
});

test("ax-snapshot --window ID reads that window's tree, not the focused one", async () => {
  const desktop = fakeDesktop({ active: EDITOR, clients: [EDITOR, BROWSER], atspi: atspiTree([]) });
  const result = await helper(["ax-snapshot", "--window", "0xb2"], desktop);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json().windowId, "0xb2");
  assert.equal(result.json().app, "chromium");
  assert.match(desktop.calls("python3")[0], /--pid 5151 /);
  assert.doesNotMatch(desktop.calls("python3")[0], /--url-only/);
});

test("ax-snapshot --title reads the tree only while the window still has that title", async () => {
  const desktop = fakeDesktop({ active: EDITOR, clients: [EDITOR, BROWSER], atspi: atspiTree([]) });
  const same = await helper(["ax-snapshot", "--window", "0xa1", "--title", "Notes - Editor"], desktop);
  assert.equal(same.code, 0, same.stderr);
  assert.equal(same.json().tree.role, "frame");
  assert.equal(desktop.calls("python3").length, 1);
});

test("ax-snapshot --title on a window retitled since the caller looked reads no tree and reports the new title", async () => {
  const desktop = fakeDesktop({ active: EDITOR, clients: [EDITOR, BROWSER], atspi: atspiTree([{ role: "text", text: SENTENCE }]) });
  const result = await helper(["ax-snapshot", "--window", "0xa1", "--title", "Quarterly plan - Editor"], desktop);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.json(), { app: "org.example.editor", windowTitle: "Notes - Editor", windowId: "0xa1", tree: { role: "window" } });
  assert.deepEqual(desktop.calls("python3"), [], "the retitled window's tree was never asked for");
});

test("ax-snapshot --window with an unknown id exits 1 and reads nothing", async () => {
  const desktop = fakeDesktop({ active: EDITOR, clients: [EDITOR], atspi: atspiTree([]) });
  const result = await helper(["ax-snapshot", "--window", "0xdead"], desktop);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no window 0xdead/);
  assert.deepEqual(desktop.calls("python3"), []);
});

test("--window and --pid together are a usage error", async () => {
  const desktop = fakeDesktop({ active: EDITOR, clients: [EDITOR] });
  assert.equal((await helper(["ax-snapshot", "--window", "0xa1", "--pid", "4242"], desktop)).code, 2);
});

test("a password field is never read: its role says so, its text and subtree are gone", async () => {
  const desktop = fakeDesktop({
    active: EDITOR,
    clients: [EDITOR],
    atspi: atspiTree([
      {
        role: "password text",
        name: "Password",
        text: "hunter2",
        showing: true,
        children: [{ role: "label", name: "hunter2 again", showing: true, children: [] }],
      },
      { role: "label", name: "Sign in", showing: true, children: [] },
    ]),
  });
  const result = await helper(["ax-snapshot"], desktop);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(!result.stdout.includes("hunter2"), "no secret text reaches the output");
  assert.deepEqual(result.json().tree.children, [{ role: "AXSecureTextField" }, { role: "label", title: "Sign in" }]);
});

test("nodes that are not showing are flagged off screen and object marks are stripped", async () => {
  const desktop = fakeDesktop({
    active: EDITOR,
    clients: [EDITOR],
    atspi: atspiTree([
      { role: "text", name: "", text: "\uFFFChello\uFFFC", showing: true, children: [] },
      { role: "label", name: "behind a tab", showing: false, children: [] },
    ]),
  });
  const result = await helper(["ax-snapshot"], desktop);
  assert.deepEqual(result.json().tree.children, [
    { role: "text", value: "hello" },
    { role: "label", title: "behind a tab", offScreen: true },
  ]);
});

test("a browser document reports its address as browserUrl", async () => {
  const desktop = fakeDesktop({
    active: BROWSER,
    clients: [BROWSER],
    atspi: { ...atspiTree([]), url: "https://example.test/page" },
  });
  const result = await helper(["ax-snapshot"], desktop);
  assert.equal(result.json().browserUrl, "https://example.test/page");
});

test("an app that is not on the accessibility bus gives its window and a tree with no text, so OCR runs", async () => {
  const desktop = fakeDesktop({ active: EDITOR, clients: [EDITOR], atspi: { found: false } });
  const result = await helper(["ax-snapshot"], desktop);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.json().tree, { role: "window" });
  assert.equal(result.json().windowTitle, "Notes - Editor");
  assert.equal(result.json().windowId, "0xa1");
});

test("when the AT-SPI reader cannot run, ax-snapshot still answers with the window and says why on stderr", async () => {
  const desktop = fakeDesktop({ active: EDITOR, clients: [EDITOR], atspi: "ModuleNotFoundError: gi", atspiExit: 3 });
  const result = await helper(["ax-snapshot"], desktop);
  assert.equal(result.code, 0);
  assert.deepEqual(result.json().tree, { role: "window" });
  assert.match(result.stderr, /AT-SPI is not available/);
});

test("a window title that starts with a dash is passed to the reader as one value", async () => {
  const dashed = client({ title: "-x notes" });
  const desktop = fakeDesktop({ active: dashed, clients: [dashed] });
  await helper(["ax-snapshot"], desktop);
  assert.match(desktop.calls("python3")[0], /--title=-x notes --max-nodes/);
});

test("--max-nodes bounds the tree the helper returns and is passed to the reader", async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ role: "label", name: `row ${i}`, showing: true, children: [] }));
  const desktop = fakeDesktop({ active: EDITOR, clients: [EDITOR], atspi: atspiTree(many) });
  const result = await helper(["ax-snapshot", "--max-nodes", "10"], desktop);
  const count = (node) => 1 + (node.children ?? []).reduce((sum, child) => sum + count(child), 0);
  assert.ok(count(result.json().tree) <= 10);
  assert.match(desktop.calls("python3")[0], /--max-nodes 10/);
});

test("ax-snapshot with no focused window exits 1 with one plain line", async () => {
  const desktop = fakeDesktop({ active: {}, clients: [] });
  const result = await helper(["ax-snapshot"], desktop);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /no focused window/);
});

test("ocr-window --window reads that window and not the focused one", async () => {
  const desktop = fakeDesktop({ active: EDITOR, clients: [EDITOR, BROWSER], ocrText: `${SENTENCE}\n\n` });
  const result = await helper(["ocr-window", "--window", "0xb2"], desktop);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.json(), { text: SENTENCE });
  assert.deepEqual(desktop.calls("grim"), ["-g 900,80 800x600 -t png -"]);
});

test("ocr-window --frontmost reads the focused window", async () => {
  const desktop = fakeDesktop({ active: EDITOR, clients: [EDITOR, BROWSER], ocrText: SENTENCE });
  const result = await helper(["ocr-window", "--frontmost"], desktop);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(desktop.calls("grim"), ["-g 100,80 800x600 -t png -"]);
});

test("a window with no text gives an empty string, not an error", async () => {
  const desktop = fakeDesktop({ active: EDITOR, clients: [EDITOR], ocrText: "  \n" });
  const result = await helper(["ocr-window"], desktop);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.json(), { text: "" });
});

test("a window that another window covers is not read", async () => {
  const cover = client({ address: "0xc3", at: [500, 300], size: [800, 600], class: "pinentry", title: "Unlock", pid: 1 });
  const desktop = fakeDesktop({ active: EDITOR, clients: [EDITOR, cover], ocrText: "secret" });
  const result = await helper(["ocr-window", "--window", "0xa1"], desktop);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /covered by another window/);
  assert.deepEqual(desktop.calls("grim"), [], "no screen read happened");
});

test("a window on a workspace that is not showing is not read", async () => {
  const away = client({ address: "0xd4", workspace: { id: 2, name: "2" } });
  const desktop = fakeDesktop({ active: EDITOR, clients: [EDITOR, away], ocrText: "elsewhere" });
  const result = await helper(["ocr-window", "--window", "0xd4"], desktop);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not on a visible workspace/);
  assert.deepEqual(desktop.calls("grim"), []);
});

test("an unknown window id exits 1 and reads nothing", async () => {
  const desktop = fakeDesktop({ active: EDITOR, clients: [EDITOR] });
  const result = await helper(["ocr-window", "--window", "0xdead"], desktop);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no window 0xdead/);
  assert.deepEqual(desktop.calls("grim"), []);
});

test("missing programs are named with the package that provides them", async () => {
  const noGrim = await helper(["ocr-window"], fakeDesktop({ active: EDITOR, clients: [EDITOR], without: ["grim"] }));
  assert.equal(noGrim.code, 1);
  assert.match(noGrim.stderr, /grim was not found; install the grim package/);
  const noOcr = await helper(["ocr-window"], fakeDesktop({ active: EDITOR, clients: [EDITOR], without: ["tesseract"] }));
  assert.equal(noOcr.code, 1);
  assert.match(noOcr.stderr, /tesseract was not found; install the tesseract package/);
  const noHypr = await helper(["ax-snapshot"], fakeDesktop({ without: ["hyprctl"] }));
  assert.equal(noHypr.code, 1);
  assert.match(noHypr.stderr, /hyprctl was not found; the Linux screen helper needs Hyprland/);
});

test("unknown screen flags are a usage error", async () => {
  const desktop = fakeDesktop({ active: EDITOR, clients: [EDITOR] });
  assert.equal((await helper(["ax-snapshot", "--bogus"], desktop)).code, 2);
  assert.equal((await helper(["ocr-window", "--window"], desktop)).code, 2);
  assert.equal((await helper(["ax-snapshot", "--max-nodes", "0"], desktop)).code, 2);
});
