import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildStandup, parseStandupDate, previousDate } from "./build.js";

test("parseStandupDate rejects garbage and defaults to UTC today", () => {
  assert.equal(parseStandupDate(undefined, new Date("2026-08-18T12:00:00Z")), "2026-08-18");
  assert.throws(() => parseStandupDate("nope"), /YYYY-MM-DD/);
  assert.equal(previousDate("2026-08-18"), "2026-08-17");
});

test("buildStandup is deterministic and marks missing days", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-standup-"));
  try {
    await mkdir(path.join(memoryDir, "activity"), { recursive: true });
    await writeFile(
      path.join(memoryDir, "activity", "2026-08-18.md"),
      "---\ndate: 2026-08-18\n---\n# Today\n- shipped standup\n- blocker: waiting on review\n",
      "utf8",
    );
    const a = buildStandup(memoryDir, "2026-08-18");
    const b = buildStandup(memoryDir, "2026-08-18");
    assert.equal(a.markdown, b.markdown);
    assert.equal(a.yesterday, "2026-08-17");
    assert.match(a.markdown, /blocker: waiting on review/);
    assert.match(a.activityGrid, /yesterday \| \./);
    assert.match(a.activityGrid, /today \| x/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
