// ---------------------------------------------------------------------------
// Worker entry for off-thread archive scoring (issue #1674).
//
// Runs the archive-scoring loop on a worker thread so concurrent recall
// requests get genuine multi-core parallelism instead of serializing on
// the main JS thread. Loaded by ArchiveScoringWorkerPool.spawn via
// `new Worker(new URL(...))`.
//
// SELF-CONTAINED: the scoring function is inlined here (not imported) because
// tsx's TypeScript loader does not propagate into worker_threads — a worker
// that imports from a sibling .ts file fails with ERR_MODULE_NOT_FOUND under
// tsx. The canonical version is scoreArchiveMemories in archive-scoring.ts;
// this copy is kept byte-identical and equivalence is asserted by the test
// "worker scoring matches canonical scoreArchiveMemories".
//
// Wire protocol:
//   inbound  (ScoreTask):   { items: ArchiveScoreItem[]; tokens: string[] }
//   outbound (ScoreReply):  { ok: true; results: ArchiveScoreResult[] }
//                         | { ok: false; error: string }
// ---------------------------------------------------------------------------

import { parentPort } from "node:worker_threads";

interface ArchiveScoreItem {
  id: string;
  path: string;
  content: string;
  category: string;
  tags: string[];
}

interface ArchiveScoreResult {
  docid: string;
  path: string;
  score: number;
  snippet: string;
}

interface ScoreTask {
  items: ArchiveScoreItem[];
  tokens: string[];
}

type ScoreReply = { ok: true; results: ArchiveScoreResult[] } | { ok: false; error: string };

/**
 * Score archived memories against query tokens using substring overlap.
 * MUST be byte-identical to scoreArchiveMemories in archive-scoring.ts.
 */
function scoreArchiveMemories(
  items: ReadonlyArray<ArchiveScoreItem>,
  tokens: ReadonlyArray<string>,
): ArchiveScoreResult[] {
  if (items.length === 0 || tokens.length === 0) return [];

  const scored: ArchiveScoreResult[] = [];
  for (const item of items) {
    const haystack = [item.content, item.category, ...item.tags].join(" ").toLowerCase();
    let hits = 0;
    for (const token of tokens) {
      if (haystack.includes(token)) hits += 1;
    }
    if (hits === 0) continue;
    scored.push({
      docid: item.id,
      path: item.path,
      score: hits / tokens.length,
      snippet: item.content.slice(0, 400).replace(/\n/g, " "),
    });
  }
  return scored;
}

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
