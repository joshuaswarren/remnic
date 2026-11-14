import assert from "node:assert/strict";
import { test } from "node:test";

import { CaptureProcessor } from "./capture.js";
import { defaultDaemonConfig } from "./config.js";
import { type AxSnapshot, NativeHelper, type AxSnapshotOptions, type OcrWindowOptions, type WindowContext } from "./helper.js";
import { captureFromSnapshot, captureViaHelper } from "./live.js";

test("focus change between ax-snapshot and OCR: OCR targets the snapshot window id", async () => {
  const config = defaultDaemonConfig();
  const processor = new CaptureProcessor(config);
  const calls: OcrWindowOptions[] = [];
  // Simulate the focus flip: after the snapshot was taken the frontmost
  // window became a different one, so the frontmost path would read
  // WINDOW-B text while the candidate is stored under window A's identity.
  const helper: NativeHelper = new (class extends NativeHelper {
    constructor() {
      super("fake");
    }
    override async ocrWindow(opts: OcrWindowOptions = {}) {
      calls.push(opts);
      return opts.windowId === "A" ? "window A ocr text" : "WINDOW-B TEXT";
    }
  })();
  // kitty is terminal-class (DEFAULT_TERMINAL_APPS) and the tree carries no
  // text, so captureFromSnapshot must take the OCR path.
  const snap: AxSnapshot = {
    app: "kitty",
    windowTitle: "shell",
    windowId: "A",
    tree: { role: "AXWindow" },
  };

  const decision = await captureFromSnapshot(snap, helper, processor, config, "2026-08-17T00:00:00.000Z");

  assert.deepEqual(calls, [{ windowId: "A" }], "OCR must target the snapshot window, not the frontmost");
  assert.equal(decision.action, "store");
  if (decision.action === "store") {
    assert.equal(decision.snapshot.text, "window A ocr text");
    assert.equal(decision.snapshot.textSource, "ocr");
    assert.equal(decision.snapshot.app, "kitty");
  }
});

const AT = "2026-08-17T00:00:00.000Z";

/** A helper whose every call is logged, so a test can prove which calls a window caused. */
function loggedHelper(context: WindowContext, snap: AxSnapshot) {
  const calls: string[] = [];
  const helper: NativeHelper = new (class extends NativeHelper {
    constructor() {
      super("stub");
    }
    override async windowContext(): Promise<WindowContext> {
      calls.push("windowContext");
      return context;
    }
    override async axSnapshot(opts: AxSnapshotOptions = {}): Promise<AxSnapshot> {
      calls.push(`axSnapshot ${JSON.stringify(opts)}`);
      return snap;
    }
    override async ocrWindow(): Promise<string> {
      calls.push("ocrWindow");
      return "ocr text";
    }
  })();
  return { helper, calls };
}

test("a deny-listed app is never read: the helper is asked for the window facts and nothing else", async () => {
  const config = defaultDaemonConfig();
  const snap: AxSnapshot = { app: "1Password 8", windowTitle: "Vault", windowId: "W", tree: { role: "AXWindow" } };
  const { helper, calls } = loggedHelper({ app: "1Password 8", windowTitle: "Vault", windowId: "W" }, snap);
  const decision = await captureViaHelper(helper, new CaptureProcessor(config), config, AT);
  assert.deepEqual(calls, ["windowContext"]);
  assert.notEqual(decision.action, "store");
});

test("a deny-listed address is never read either", async () => {
  const config = { ...defaultDaemonConfig(), denyUrls: ["https://bank.example/*"] };
  const snap: AxSnapshot = { app: "chromium", windowTitle: "Accounts", windowId: "W", tree: { role: "window" } };
  const context = { app: "chromium", windowTitle: "Accounts", windowId: "W", browserUrl: "https://bank.example/accounts" };
  const { helper, calls } = loggedHelper(context, snap);
  const decision = await captureViaHelper(helper, new CaptureProcessor(config), config, AT);
  assert.deepEqual(calls, ["windowContext"]);
  assert.notEqual(decision.action, "store");
});

test("an allowed window is read once, pinned to the id and the title the window facts gave", async () => {
  const config = defaultDaemonConfig();
  const snap: AxSnapshot = {
    app: "Notes",
    windowTitle: "Meeting",
    windowId: "W",
    tree: { role: "AXWindow", children: [{ role: "AXStaticText", value: "agenda for the quarterly planning meeting" }] },
  };
  const { helper, calls } = loggedHelper({ app: "Notes", windowTitle: "Meeting", windowId: "W" }, snap);
  const decision = await captureViaHelper(helper, new CaptureProcessor(config), config, AT);
  assert.deepEqual(calls, [
    "windowContext",
    `axSnapshot ${JSON.stringify({ windowId: "W", expectTitle: "Meeting", maxNodes: config.maxNodes })}`,
  ]);
  assert.equal(decision.action, "store");
});

test("a helper that answered with the full snapshot is not asked for it a second time", async () => {
  const config = defaultDaemonConfig();
  const snap: AxSnapshot = {
    app: "Notes",
    windowTitle: "Meeting",
    tree: { role: "AXWindow", children: [{ role: "AXStaticText", value: "agenda for the quarterly planning meeting" }] },
  };
  const { helper, calls } = loggedHelper({ app: "Notes", windowTitle: "Meeting", snapshot: snap }, snap);
  const decision = await captureViaHelper(helper, new CaptureProcessor(config), config, AT);
  assert.deepEqual(calls, ["windowContext"]);
  assert.equal(decision.action, "store");
});
