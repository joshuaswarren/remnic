import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildStandup, parseStandupDate, previousActiveDate } from "./build.js";

const FRONTMATTER = (date: string): string => `---\nid: digest-${date}\ncategory: fact\nstatus: active\n---\n`;

test("parseStandupDate defaults only on absence, rejects garbage and empty", () => {
  assert.equal(parseStandupDate(undefined, new Date("2026-08-18T12:00:00Z")), "2026-08-18");
  assert.equal(parseStandupDate(null, new Date("2026-08-18T12:00:00Z")), "2026-08-18");
  assert.throws(() => parseStandupDate("nope"), /YYYY-MM-DD/);
  // An explicitly empty date is user input, not absence (§39: reject, never
  // silently default).
  assert.throws(() => parseStandupDate(""), /YYYY-MM-DD/);
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
    await writeFile(path.join(memoryDir, "activity", "2026-08-14.md"), "x\n", "utf8");
    assert.equal(previousActiveDate(memoryDir, "2026-08-17"), "2026-08-14");
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

function digestBody(spans: string[]): string {
  return ["## Timeline", "", ...spans].join("\n");
}

test("buildStandup derives every section from the prior active day and stays deterministic", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-standup-"));
  try {
    await mkdir(path.join(memoryDir, "activity"), { recursive: true });
    // Friday 2026-08-14 has the activity; Monday 2026-08-17 is the standup day.
    await writeFile(
      path.join(memoryDir, "activity", "2026-08-14.md"),
      FRONTMATTER("2026-08-14") +
        digestBody([
          "- [09:00] Editor — refactor",
          "- [09:30] Editor — refactor",
          "- [10:15] Terminal — build",
          "- [11:40] Editor — review",
          "- [14:05] Browser — docs",
          "- [15:20] Editor — blocker: waiting on review",
        ]),
      "utf8",
    );
    const a = buildStandup(memoryDir, "2026-08-17");
    const b = buildStandup(memoryDir, "2026-08-17");
    assert.equal(a.markdown, b.markdown);

    assert.equal(a.yesterday, "2026-08-14");
    // Highlights come from the PRIOR day (issue #1981), and frontmatter
    // fields never leak into rendered sections.
    assert.ok(a.highlights.length > 0);
    for (const line of a.highlights) {
      assert.doesNotMatch(line, /^id: |^category: |^status: |^---$/);
    }
    assert.match(a.markdown, /## Highlights\n- \[09:00\] Editor — refactor/);
    // Blockers strip list markers (no doubled bullets) and come from P.
    assert.ok(a.blockers.some((line) => line === "[15:20] Editor — blocker: waiting on review"));
    assert.doesNotMatch(a.markdown, /- - /);
    // Grid: exactly hours 9, 10, 11, 14, 15 non-empty; Monday empty.
    assert.match(a.activityGrid, /^prior day 2026-08-14 — 24 hour buckets/);
    assert.match(a.activityGrid, /^non-empty hours: 9, 10, 11, 14, 15$/m);
    assert.match(a.markdown, /## Today \(2026-08-17\)\n_No activity digest._/);
    // Zero commitments → explicit empty-priorities message, never invented.
    assert.match(a.markdown, /## Today's priorities\n- \(no tracked commitments — add priorities manually\)/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("buildStandup renders an empty grid row when the prior day has no digest", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-standup-"));
  try {
    const brief = buildStandup(memoryDir, "2026-08-18");
    assert.match(brief.activityGrid, /^prior day 2026-08-17: no activity digest \(empty\)$/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("buildStandup lists open commitments as priorities and overdue ones as blocker candidates", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-standup-"));
  try {
    await mkdir(path.join(memoryDir, "facts", "2026-08-10"), { recursive: true });
    const commitment = (id: string, extra: string): string =>
      `---\nid: ${id}\ncategory: commitment\nstatus: active\ncreated: 2026-08-10T00:00:00Z\nupdated: 2026-08-10T00:00:00Z\nsource: test\nconfidence: 0.8\nconfidenceTier: reported\ntags: []\n${extra}---\n${id} says: ship the thing\n`;
    await writeFile(path.join(memoryDir, "facts", "2026-08-10", "open.md"), commitment("open-1", ""), "utf8");
    await writeFile(
      path.join(memoryDir, "facts", "2026-08-10", "due-soon.md"),
      commitment("due-soon", "expiresAt: 2026-08-19T00:00:00Z\n"),
      "utf8",
    );
    await writeFile(
      path.join(memoryDir, "facts", "2026-08-10", "overdue.md"),
      commitment("overdue-1", "expiresAt: 2026-08-15T00:00:00Z\n"),
      "utf8",
    );
    await writeFile(
      path.join(memoryDir, "facts", "2026-08-10", "fulfilled.md"),
      commitment("done-1", "tags: [fulfilled]\n"),
      "utf8",
    );
    await writeFile(
      path.join(memoryDir, "facts", "2026-08-10", "review.md"),
      commitment("pending-1", "status: pending_review\n"),
      "utf8",
    );
    await writeFile(
      path.join(memoryDir, "facts", "2026-08-10", "plain-fact.md"),
      `---\nid: fact-1\ncategory: fact\nstatus: active\ncreated: 2026-08-10T00:00:00Z\nupdated: 2026-08-10T00:00:00Z\nsource: test\nconfidence: 0.8\nconfidenceTier: reported\ntags: []\n---\nnot a commitment\n`,
      "utf8",
    );

    const brief = buildStandup(memoryDir, "2026-08-17");
    // Overdue commitment is a blocker candidate, not a priority.
    assert.ok(brief.blockers.some((line) => line.startsWith("commitment past due: overdue-1 says: ship the thing")));
    // Fulfiled, pending-review, and non-commitment facts never appear.
    const priorities = brief.priorities.join("\n");
    assert.ok(priorities.includes("due-soon says: ship the thing (due 2026-08-19)"));
    assert.ok(priorities.includes("open-1 says: ship the thing"));
    assert.ok(!priorities.includes("done-1"));
    assert.ok(!priorities.includes("pending-1"));
    assert.ok(!priorities.includes("not a commitment"));
    // Due-first ordering: expiresAt before bare created.
    assert.ok(priorities.indexOf("due-soon") < priorities.indexOf("open-1"));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
