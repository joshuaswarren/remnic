import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TmtBuilder, hourNodePath, parseIsoDate, parseIsoHour } from "./tmt.js";

test("TMT timestamp helpers derive UTC path tokens only from strict ISO instants", () => {
  assert.equal(parseIsoDate("2026-05-22T01:30:00-05:00"), "2026-05-22");
  assert.equal(parseIsoHour("2026-05-22T01:30:00-05:00"), "06");
  assert.equal(parseIsoDate("../../evil"), "");
  assert.equal(parseIsoHour("2026-05-22"), "");
});

test("TMT skips malformed timestamps instead of using raw slices as paths", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-tmt-"));
  try {
    const builder = new TmtBuilder(dir, {
      temporalMemoryTreeEnabled: true,
      tmtHourlyMinMemories: 1,
      tmtSummaryMaxTokens: 100,
    });
    await builder.maybeRebuildNodes(
      [
        {
          path: "bad.md",
          id: "bad",
          created: "../../evilT99:99:99Z",
          content: "bad",
        },
        {
          path: "good.md",
          id: "good",
          created: "2026-05-22T01:30:00-05:00",
          content: "good",
        },
      ],
      async (items) => items.join("\n"),
    );

    assert.equal(
      await readFile(hourNodePath(dir, "2026-05-22", "06"), "utf8").then((value) => value.includes("good")),
      true,
    );
    await assert.rejects(() => readFile(path.join(dir, "tmt", "..", "..", "evil", "hour-99.md"), "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
