import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { parseConfig } from "../src/config.js";
import { TranscriptManager } from "../src/transcript.js";

test("transcript range reads use an exclusive end timestamp", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-transcript-boundary-"));
  try {
    const config = parseConfig({
      memoryDir,
      transcriptEnabled: true,
    });
    const transcript = new TranscriptManager(config);
    await transcript.initialize();

    const sessionKey = "agent:generalist:main";
    const start = new Date();
    start.setUTCHours(10, 0, 0, 0);
    const middle = new Date(start.getTime() + 30 * 60 * 1000);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const after = new Date(end.getTime() + 1);

    await transcript.append({
      timestamp: start.toISOString(),
      role: "user",
      content: "start",
      sessionKey,
      turnId: "start",
    });
    await transcript.append({
      timestamp: middle.toISOString(),
      role: "assistant",
      content: "middle",
      sessionKey,
      turnId: "middle",
    });
    await transcript.append({
      timestamp: end.toISOString(),
      role: "user",
      content: "end-boundary",
      sessionKey,
      turnId: "end-boundary",
    });
    await transcript.append({
      timestamp: after.toISOString(),
      role: "assistant",
      content: "after",
      sessionKey,
      turnId: "after",
    });

    const rangeEntries = await transcript.readRange(
      start.toISOString(),
      end.toISOString(),
      sessionKey,
    );
    assert.deepEqual(rangeEntries.map((entry) => entry.turnId), ["start", "middle"]);

    const sessionEntries = await (transcript as unknown as {
      readRecentForSession(start: Date, end: Date, sessionKey: string): Promise<Array<{ turnId: string }>>;
    }).readRecentForSession(start, end, sessionKey);
    assert.deepEqual(sessionEntries.map((entry) => entry.turnId), ["start", "middle"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
