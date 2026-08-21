import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { Orchestrator } from "../src/orchestrator.js";
import { parseConfig } from "../src/config.js";
import type { QmdSearchResult } from "../src/types.js";

async function makeOrchestrator(
  prefix: string,
  overrides: Record<string, unknown> = {},
): Promise<Orchestrator> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
    knowledgeIndexEnabled: false,
    compoundingInjectEnabled: false,
    memoryBoxesEnabled: false,
    temporalMemoryTreeEnabled: false,
    injectQuestions: false,
    ...overrides,
  });
  return new Orchestrator(config);
}

function fakeResult(
  docid: string,
  pathValue: string,
  snippet: string,
  score: number,
): QmdSearchResult {
  return { docid, path: pathValue, snippet, score };
}

test(
  "diversifyAndLimitRecallResults returns [] when limit is zero",
  async () => {
    // Regression for Cursor Bugbot Medium comment on PR #391: when
    // `recallResultLimit === 0` (e.g. `memoriesSectionEnabled === false`),
    // the helper must return an empty array instead of the full
    // diversified list. Otherwise a disabled memories section would still
    // get injected.
    const orch = await makeOrchestrator("remnic-mmr-zero-");
    const results: QmdSearchResult[] = [
      fakeResult("a", "p/a", "one", 0.9),
      fakeResult("b", "p/b", "two", 0.8),
      fakeResult("c", "p/c", "three", 0.7),
    ];
    const out = (orch as unknown as {
      diversifyAndLimitRecallResults(
        sectionId: string,
        r: QmdSearchResult[],
        limit: number,
      ): QmdSearchResult[];
    }).diversifyAndLimitRecallResults("memories", results, 0);
    assert.equal(
      out.length,
      0,
      "limit=0 must return an empty array (legacy slice(0, 0) semantics)",
    );
  },
);

test(
  "diversifyAndLimitRecallResults runs MMR on full pool before slicing to limit",
  async () => {
    // Regression for ChatGPT Codex P2 comment on PR #391: MMR must run on
    // the pre-truncation pool so diverse candidates sitting just below the
    // final recall limit can still be promoted into the injected set.
    const orch = await makeOrchestrator("remnic-mmr-preslice-");
    const results: QmdSearchResult[] = [
      fakeResult("a1", "p/a1", "alpha fact one", 0.99),
      fakeResult("a2", "p/a2", "alpha fact two", 0.98),
      fakeResult("a3", "p/a3", "alpha fact three", 0.97),
      fakeResult("a4", "p/a4", "alpha fact four", 0.96),
      fakeResult("a5", "p/a5", "alpha fact five", 0.95),
      fakeResult("d1", "p/d1", "orthogonal rocket fuel chemistry concept", 0.94),
    ];
    const out = (orch as unknown as {
      diversifyAndLimitRecallResults(
        sectionId: string,
        r: QmdSearchResult[],
        limit: number,
      ): QmdSearchResult[];
    }).diversifyAndLimitRecallResults("memories", results, 5);
    assert.equal(out.length, 5, "limit=5 must truncate to 5");
    const ids = out.map((r) => r.docid);
    assert.ok(
      ids.includes("d1"),
      `MMR-then-slice should pull the sub-cutoff diverse candidate into the head: ${ids.join(",")}`,
    );
  },
);

test(
  "diversifyAndLimitRecallResults honors recallMmrEnabled=false",
  async () => {
    // When MMR is disabled, the helper should fall back to a plain
    // score-ordered slice to the requested limit.
    const orch = await makeOrchestrator("remnic-mmr-off-", {
      recallMmrEnabled: false,
    });
    const results: QmdSearchResult[] = [
      fakeResult("a", "p/a", "one", 0.9),
      fakeResult("b", "p/b", "two", 0.8),
      fakeResult("c", "p/c", "three", 0.7),
    ];
    const out = (orch as unknown as {
      diversifyAndLimitRecallResults(
        sectionId: string,
        r: QmdSearchResult[],
        limit: number,
      ): QmdSearchResult[];
    }).diversifyAndLimitRecallResults("memories", results, 2);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((r) => r.docid), ["a", "b"]);
  },
);
