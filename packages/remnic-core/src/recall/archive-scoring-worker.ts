// ---------------------------------------------------------------------------
// Worker entry for off-thread archive scoring (issue #1674).
//
// Runs the pure `scoreArchiveMemories` function on a worker thread so
// concurrent recall requests get genuine multi-core parallelism instead of
// serializing on the main JS thread. This file is loaded by
// `ArchiveScoringWorkerPool.spawn` via `new Worker(new URL(...))`.
//
// The wire protocol is a pair of plain-serializable envelopes:
//   inbound  (ScoreTask):   { items: ArchiveScoreItem[]; tokens: string[] }
//   outbound (ScoreReply):  { ok: true; results: ArchiveScoreResult[] }
//                         | { ok: false; error: string }
//
// The worker is stateless: each inbound message produces exactly one outbound
// reply. No shared state, no cross-request leakage — the scoring function is
// pure over its inputs.
// ---------------------------------------------------------------------------

import { parentPort } from "node:worker_threads";
import { scoreArchiveMemories, type ScoreTask, type ScoreReply } from "./archive-scoring.js";

if (parentPort) {
  const port = parentPort;
  port.on("message", (task: ScoreTask) => {
    try {
      const results = scoreArchiveMemories(task.items, task.tokens);
      const reply: ScoreReply = { ok: true, results };
      port.postMessage(reply);
    } catch (err) {
      const reply: ScoreReply = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      port.postMessage(reply);
    }
  });
}
