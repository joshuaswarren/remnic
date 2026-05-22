import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LcmArchive } from "./lcm/archive.js";
import { LcmDag } from "./lcm/dag.js";
import { assembleCompressedHistory } from "./lcm/recall.js";
import { ensureLcmStateDir, openLcmDatabase } from "./lcm/schema.js";

test("assembleCompressedHistory excludes old summaries that straddle the fresh tail", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-lcm-recall-"));
  await ensureLcmStateDir(memoryDir);
  const db = openLcmDatabase(memoryDir);

  try {
    const archive = new LcmArchive(db);
    const dag = new LcmDag(db);
    const sessionId = "session-1";

    for (let turn = 0; turn < 32; turn += 1) {
      archive.appendMessage(sessionId, turn, "user", `turn ${turn}`);
    }

    for (const [start, end] of [
      [0, 7],
      [8, 15],
      [16, 23],
      [24, 31],
    ] as const) {
      dag.insertNode({
        id: `leaf-${start}-${end}`,
        session_id: sessionId,
        depth: 0,
        parent_id: null,
        summary_text: `leaf summary ${start}-${end}`,
        token_count: 1,
        msg_start: start,
        msg_end: end,
        escalation: 0,
      });
    }

    dag.insertNode({
      id: "parent-0-31",
      session_id: sessionId,
      depth: 1,
      parent_id: null,
      summary_text: "parent summary 0-31 should not appear",
      token_count: 1,
      msg_start: 0,
      msg_end: 31,
      escalation: 0,
    });

    const section = assembleCompressedHistory(dag, archive, sessionId, {
      freshTailTurns: 16,
      budgetChars: 10_000,
    });

    assert.doesNotMatch(section, /parent summary 0-31/);
    assert.match(section, /leaf summary 0-7/);
    assert.match(section, /leaf summary 8-15/);
    assert.match(section, /leaf summary 16-23/);
    assert.match(section, /leaf summary 24-31/);
  } finally {
    db.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
