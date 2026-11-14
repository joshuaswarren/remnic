import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { transientDesktop, runOcr, CANARY } from "../../capture-native-linux/test/frame-privacy-harness.mjs";

import { CaptureProcessor } from "./capture.js";
import { defaultDaemonConfig } from "./config.js";
import { NativeHelper } from "./helper.js";
import { captureViaHelper } from "./live.js";
import { CaptureScheduler } from "./scheduler.js";
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

for (const firstUrl of ["https://allowed.example/", null]) {
for (const entrypoint of ["snapshot", "scheduler"]) {
test(`same-title URL navigation cannot read denied content: ${entrypoint}, ${firstUrl}`, async (t) => {
  const desktop = await transientDesktop(t, "ax");
  const giStub = fileURLToPath(new URL("../../capture-native-linux/test/fixtures/stub-gi/", import.meta.url));
  const readLog = path.join(desktop.dir, "text-reads.log");
  writeFileSync(path.join(desktop.dir, "bin/python3"), `#!${process.execPath}
const cp = require("node:child_process");
const navigated = !process.argv.includes("--url-only");
const tree = [{pid:4242,children:[{role:"frame",name:"Notes - Editor",children:[{
  role:"document web",text:${JSON.stringify(CANARY)},
  attributes:{URI:navigated ? "https://bank.example/accounts" : ${JSON.stringify(firstUrl)}}
}]}]}];
const result = cp.spawnSync("/usr/bin/python3", process.argv.slice(2), {
  env:{...process.env,PYTHONPATH:${JSON.stringify(giStub)},STUB_ATSPI_TREE:JSON.stringify(tree),
    STUB_ATSPI_LOG:${JSON.stringify(readLog)}},stdio:"inherit"
});
process.exit(result.status ?? 1);
`);
  const prior = new Map(Object.keys(desktop.env).map((key) => [key, process.env[key]]));
  const spool = new Spool(":memory:");
  try {
    Object.assign(process.env, desktop.env);
    const config = { ...defaultDaemonConfig(), settleMs: 0, denyUrls: ["https://bank.example/*"] };
    const helper = new NativeHelper(desktop.wrapper);
    const processor = new CaptureProcessor(config);
    if (entrypoint === "snapshot") {
      const decision = await captureViaHelper(helper, processor, config, AT);
      if (decision.action === "store") spool.insertSnapshot(decision.snapshot, config.sessionGapSeconds);
    } else {
      const scheduler = new CaptureScheduler(helper, processor, spool, config);
      await scheduler.tick();
      await scheduler.tick();
    }
    const reads = existsSync(readLog) ? readFileSync(readLog, "utf8") : "";
    assert.equal(reads.includes("document web"), false, "the deny check must run before any page text read");
    assert.deepEqual(spool.querySnapshots({ date: "2026-11-13", timezone: "UTC", limit: 10 }).snapshots, []);
  } finally {
    spool.close();
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
}
}
