import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildStandup, parseStandupDate, previousActiveDate } from "./build.js";

test("parseStandupDate rejects garbage and defaults to UTC today", () => {
  assert.equal(parseStandupDate(undefined, new Date("2026-08-18T12:00:00Z")), "2026-08-18");
  assert.throws(() => parseStandupDate("nope"), /YYYY-MM-DD/);
});

test("previousActiveDate falls back to calendar-previous when no digests exist", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-standup-"));
  try {
    assert.equal(previousActiveDate(memoryDir, "2026-08-18"), "2026-08-17");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("previousActiveDate skips idle weekend days (Monday resolves to Friday)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-standup-"));
  try {
    await mkdir(path.join(memoryDir, "activity"), { recursive: true });
    // 2026-08-17 is a Monday; 2026-08-14 is the prior Friday (derived from
    // `date -d`, not memory). Weekend has no digest files.
    await writeFile(
      path.join(memoryDir, "activity", "2026-08-14.md"),
      "---\ndate: 2026-08-14\n---\n# Friday\n- shipped cards\n",
      "utf8",
    );
    assert.equal(previousActiveDate(memoryDir, "2026-08-17"), "2026-08-14");
    const brief = buildStandup(memoryDir, "2026-08-17");
    assert.equal(brief.yesterday, "2026-08-14");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("previousActiveDate picks the most recent active day, not a fixed weekday", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-standup-"));
  try {
    await mkdir(path.join(memoryDir, "activity"), { recursive: true });
    // Sunday activity counts: prior day is the latest day WITH data.
    await writeFile(path.join(memoryDir, "activity", "2026-08-16.md"), "x\n", "utf8");
    assert.equal(previousActiveDate(memoryDir, "2026-08-17"), "2026-08-16");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
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
