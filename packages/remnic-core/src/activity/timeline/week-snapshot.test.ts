import assert from "node:assert/strict";
import test from "node:test";

import { renderWeekSnapshot } from "./week-snapshot.js";

const WEEK_START = "2026-07-13";

test("empty days print heading + (empty)", () => {
  assert.equal(
    renderWeekSnapshot({
      weekStart: WEEK_START,
      timezone: "UTC",
      days: [],
    }),
    [
      "# Week snapshot",
      "",
      `- weekStart: ${WEEK_START}`,
      "- timezone: UTC",
      "",
      "## Days",
      "(empty)",
      "",
    ].join("\n"),
  );
});

test("days are sorted by date regardless of input order", () => {
  const markdown = renderWeekSnapshot({
    weekStart: WEEK_START,
    timezone: "UTC",
    days: [{ date: "2026-07-15" }, { date: "2026-07-13" }, { date: "2026-07-14" }],
  });
  const headings = [...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(headings, ["2026-07-13", "2026-07-14", "2026-07-15"]);
  assert.match(markdown, /## 2026-07-13\n\(empty\)/);
});

test("timezone is echoed verbatim, not normalized", () => {
  const markdown = renderWeekSnapshot({
    weekStart: WEEK_START,
    timezone: "America/Chicago",
    days: [],
  });
  assert.match(markdown, /^- timezone: America\/Chicago$/m);
  assert.doesNotMatch(markdown, /America\/Chicago\/|UTC/);
});

test("input days are not mutated and reruns are stable", () => {
  const input = [{ date: "2026-07-15" }, { date: "2026-07-13" }];
  const first = renderWeekSnapshot({
    weekStart: WEEK_START,
    timezone: "UTC",
    days: input,
  });
  const second = renderWeekSnapshot({
    weekStart: WEEK_START,
    timezone: "UTC",
    days: input,
  });
  assert.deepEqual(
    input.map((day) => day.date),
    ["2026-07-15", "2026-07-13"],
  );
  assert.equal(first, second);
});
