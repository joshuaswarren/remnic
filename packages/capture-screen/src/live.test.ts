import assert from "node:assert/strict";
import { test } from "node:test";

import { CaptureProcessor } from "./capture.js";
import { defaultDaemonConfig } from "./config.js";
import type { AxSnapshot, NativeHelper, OcrWindowOptions } from "./helper.js";
import { captureFromSnapshot } from "./live.js";

test("focus change between ax-snapshot and OCR: OCR targets the snapshot window id", async () => {
  const config = defaultDaemonConfig();
  const processor = new CaptureProcessor(config);
  const calls: OcrWindowOptions[] = [];
  // Simulate the focus flip: after the snapshot was taken the frontmost
  // window became a different one, so the frontmost path would read
  // WINDOW-B text while the candidate is stored under window A's identity.
  const helper = {
    ocrWindow: async (opts: OcrWindowOptions) => {
      calls.push(opts);
      return opts.windowId === "A" ? "window A ocr text" : "WINDOW-B TEXT";
    },
  } as unknown as NativeHelper;
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
