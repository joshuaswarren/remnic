import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { CaptureProcessor } from "./capture.js";
import { defaultDaemonConfig } from "./config.js";
import { type AxSnapshot, NativeHelper, type AxSnapshotOptions, type OcrWindowOptions, type WindowContext } from "./helper.js";
import { captureFromSnapshot, captureViaHelper, captureWindow } from "./live.js";

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

  assert.deepEqual(
    calls,
    [{ windowId: "A", expectTitle: "shell" }],
    "OCR must target the snapshot window and read it only while it has the title the deny list checked",
  );
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

test("captureViaHelper gives the window facts the node limit, so a legacy helper's fallback tree stays bounded", async () => {
  const config = { ...defaultDaemonConfig(), maxNodes: 77 };
  const seen: { frontmost?: boolean; maxNodes?: number }[] = [];
  const helper = new (class extends NativeHelper {
    constructor() {
      super("stub");
    }
    override async windowContext(opts: { frontmost?: boolean; maxNodes?: number } = {}): Promise<WindowContext> {
      seen.push(opts);
      return { app: "kitty", windowTitle: "shell", windowId: "A" };
    }
    override async axSnapshot(): Promise<AxSnapshot> {
      return { app: "kitty", windowTitle: "shell", windowId: "A", tree: { role: "AXWindow" } };
    }
    override async ocrWindow(): Promise<string> {
      return "";
    }
  })();
  await captureViaHelper(helper, new CaptureProcessor(config), config, AT);
  assert.deepEqual(seen, [{ frontmost: true, maxNodes: 77 }], "the poll's window facts carry the configured node limit");
});

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
  const decision = await captureWindow(context, helper, new CaptureProcessor(config), config, AT);
  assert.deepEqual(calls, []);
  assert.deepEqual(decision, { action: "denied", rule: "url:https://bank.example/*" });
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

test("a window retitled after the approved facts is skipped, not stored", async () => {
  const config = defaultDaemonConfig();
  const snap: AxSnapshot = { app: "chromium", windowTitle: "Accounts - Denied Site", windowId: "W", tree: { role: "window" } };
  const { helper, calls } = loggedHelper(
    { app: "chromium", windowTitle: "Accounts", windowId: "W", browserUrl: "https://allowed.example/" },
    snap,
  );
  const decision = await captureViaHelper(helper, new CaptureProcessor(config), config, AT);
  assert.deepEqual(
    calls,
    ["windowContext", `axSnapshot ${JSON.stringify({ windowId: "W", expectTitle: "Accounts", maxNodes: config.maxNodes })}`],
    "no OCR may run for a window whose identity changed after the approved facts",
  );
  assert.deepEqual(decision, { action: "skipped", reason: "identity-changed" });
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

test("a helper that cannot pin OCR and read a deny-listed title stores nothing under the old title", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "csr-live-"));
  const file = path.join(dir, "legacy.js");
  writeFileSync(
    file,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--title")) process.exit(2);
process.stdout.write(JSON.stringify({ text: "PRIVATE VAULT CONTENT", windowTitle: "PRIVATE VAULT" }));
`,
  );
  chmodSync(file, 0o755);
  const config = defaultDaemonConfig();
  const snap: AxSnapshot = { app: "kitty", windowTitle: "shell", windowId: "A", tree: { role: "AXWindow" } };
  const decision = await captureFromSnapshot(snap, new NativeHelper(file), new CaptureProcessor(config), config, AT);
  assert.notEqual(decision.action, "store");
});
