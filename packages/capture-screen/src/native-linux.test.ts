import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { transientDesktop, runOcr, CANARY } from "../../capture-native-linux/test/frame-privacy-harness.mjs";

import { CaptureProcessor } from "./capture.js";
import { defaultDaemonConfig } from "./config.js";
import { NativeHelper } from "./helper.js";
import { captureViaHelper } from "./live.js";
import { Spool } from "./spool.js";

const AT = "2026-11-13T10:00:00.000Z";

for (const mode of ["partial", "late", "title", "ax"]) {
  test(`native Linux capture protects the stored identity: ${mode}`, async (t) => {
    const desktop = await transientDesktop(t, mode);
    if (mode === "ax") {
      writeFileSync(path.join(desktop.dir, "atspi.json"), JSON.stringify({
        found: true, root: { role: "frame", children: [{ role: "text", text: "public accessible note" }] },
      }));
    }
    const prior = new Map(Object.keys(desktop.env).map((key) => [key, process.env[key]]));
    const spool = new Spool(":memory:");
    try {
      Object.assign(process.env, desktop.env);
      const config = { ...defaultDaemonConfig(), denyApps: ["pinentry"], denyTitles: ["*Vault*"] };
      const decision = await captureViaHelper(new NativeHelper(desktop.wrapper), new CaptureProcessor(config), config, AT);
      if (decision.action === "store") spool.insertSnapshot(decision.snapshot, config.sessionGapSeconds);
      const stored = spool.querySnapshots({ date: "2026-11-13", timezone: "UTC", limit: 10 }).snapshots;
      if (mode === "ax") {
        assert.equal(stored[0]?.text, "public accessible note");
        assert.equal(stored[0]?.textSource, "ax");
      } else {
        assert.deepEqual(decision, { action: "skipped", reason: "ocr-unavailable" });
        assert.deepEqual(stored, [], `the denied cover must not reach the spool: ${CANARY}`);
      }
      assert.deepEqual(desktop.calls("grim"), [], "no composited pixels may be acquired without a frame owner");
      assert.deepEqual(desktop.calls("tesseract"), []);
    } finally {
      spool.close();
      for (const [key, value] of prior) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
}

test("native Linux screenshot failure cannot leave an event watcher alive", async (t) => {
  const desktop = await transientDesktop(t, "grim-failed");
  const result = await runOcr(desktop);
  assert.equal(result.timedOut, false, "the helper must exit without a leaked event socket");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /OCR is unavailable.*frame-bound/);
  assert.deepEqual(desktop.calls("grim"), []);
});
