import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import { parseConfig } from "../config.js";
import { RecallSearchPipelineCoordinator } from "./recall-search-pipeline.js";
import type { RecallSearchPipelineDeps } from "./recall-search-pipeline.js";
import type { MemoryFile, QmdSearchResult } from "../types.js";
import type { StorageManager } from "../index.js";

function result(path_: string, score = 1): QmdSearchResult {
  return { docid: `qmd-${path_}`, path: path_, score, snippet: path_ };
}

function memory(path_: string, fm: Partial<MemoryFile["frontmatter"]>): MemoryFile {
  return {
    path: path_,
    content: path_,
    frontmatter: {
      created: "2026-07-19T00:00:00.000Z",
      updated: "2026-07-19T00:00:00.000Z",
      ...fm,
    } as unknown as MemoryFile["frontmatter"],
  };
}

async function makeCoordinator(memoryDir: string): Promise<RecallSearchPipelineCoordinator> {
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    temporalSupersessionEnabled: true,
    temporalSupersessionIncludeInRecall: false,
  });
  assert.equal(config.recallStateViews, false, "parseConfig default must be false");
  const deps = {
    config,
    storage: {} as StorageManager,
    readQmdResultMemory: async () => null,
  } as unknown as RecallSearchPipelineDeps;
  return new RecallSearchPipelineCoordinator(deps);
}

const OLD = "facts/job-old.md";
const NEW = "facts/job-new.md";

function corpus(): { results: QmdSearchResult[]; memories: Map<string, MemoryFile> } {
  const results = [result(NEW, 0.9), result(OLD, 0.7)];
  const memories = new Map<string, MemoryFile>([
    [NEW, memory(NEW, { id: "m-new", status: "active" })],
    [
      OLD,
      memory(OLD, {
        id: "m-old",
        status: "superseded",
        supersededBy: "m-new",
        supersededAt: "2026-08-01",
      }),
    ],
  ]);
  return { results, memories };
}

test("state view admits a superseded candidate when its successor is in the set", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-sv-admit-"));
  try {
    const coordinator = await makeCoordinator(memoryDir);
    const { results, memories } = corpus();
    const safe = coordinator.filterSearchResultsByRecallSafety(results, memories, {
      stateViewActive: true,
    });
    assert.deepEqual(
      safe.map((r) => r.path).sort(),
      [NEW, OLD],
      "superseded row must be admitted alongside its successor",
    );
    const old = safe.find((r) => r.path === OLD);
    assert.equal(old?.id, "m-old", "admitted row carries the frontmatter id");
    assert.equal(old?.status, "superseded");
    assert.equal(old?.supersededBy, "m-new");
    assert.equal(old?.supersededAt, "2026-08-01");
    // Successor stays unlabeled by the filter — labeling is the inject seam's job.
    assert.equal(safe.find((r) => r.path === NEW)?.supersededBy, undefined);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
test("default (stateViewActive unset) keeps filtering superseded — zero-diff baseline", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-sv-off-"));
  try {
    const coordinator = await makeCoordinator(memoryDir);
    const { results, memories } = corpus();
    const baseline = coordinator.filterSearchResultsByRecallSafety(results, memories);
    const explicitOff = coordinator.filterSearchResultsByRecallSafety(results, memories, {
      stateViewActive: false,
    });
    assert.deepEqual(baseline.map((r) => r.path), [NEW]);
    assert.deepEqual(explicitOff.map((r) => r.path), [NEW]);
    // No chain fields leak onto survivors when the view is off.
    assert.equal(baseline[0]?.supersededBy, undefined);
    assert.equal(baseline[0]?.id, undefined);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("state view does NOT admit a superseded candidate whose successor is absent", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-sv-orphan-"));
  try {
    const coordinator = await makeCoordinator(memoryDir);
    const results = [result(OLD, 0.7)];
    const memories = new Map<string, MemoryFile>([
      [
        OLD,
        memory(OLD, {
          id: "m-old",
          status: "superseded",
          supersededBy: "m-absent",
          supersededAt: "2026-08-01",
        }),
      ],
    ]);
    const safe = coordinator.filterSearchResultsByRecallSafety(results, memories, {
      stateViewActive: true,
    });
    assert.deepEqual(safe, [], "orphaned superseded row must stay filtered");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a successor rejected by the status gate cannot anchor its superseded row (no slot consumed)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-sv-anchor-status-"));
  try {
    const coordinator = await makeCoordinator(memoryDir);
    const OTHER = "facts/unrelated.md";
    const results = [result(OLD, 0.9), result(NEW, 0.8), result(OTHER, 0.7)];
    const memories = new Map<string, MemoryFile>([
      [
        OLD,
        memory(OLD, {
          id: "m-old",
          status: "superseded",
          supersededBy: "m-new",
          supersededAt: "2026-08-01",
        }),
      ],
      // In memoryByPath (pre-filter) but rejected by the forgotten-status
      // gate — pre-fix this id anchored m-old and admitted it.
      [NEW, memory(NEW, { id: "m-new", status: "forgotten" })],
      [OTHER, memory(OTHER, { id: "m-other", status: "active" })],
    ]);
    const safe = coordinator.filterSearchResultsByRecallSafety(results, memories, {
      stateViewActive: true,
    });
    assert.deepEqual(
      safe.map((r) => r.path),
      [OTHER],
      "a filter-rejected successor must not anchor its superseded row, and the orphaned row must not consume a slot",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a successor rejected by the dedicated-surface gate cannot anchor its superseded row", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-sv-anchor-surface-"));
  try {
    const coordinator = await makeCoordinator(memoryDir);
    const results = [result(OLD, 0.9), result(NEW, 0.8)];
    const memories = new Map<string, MemoryFile>([
      [
        OLD,
        memory(OLD, {
          id: "m-old",
          status: "superseded",
          supersededBy: "m-new",
          supersededAt: "2026-08-01",
        }),
      ],
      [NEW, memory(NEW, { id: "m-new", status: "active", memoryKind: "dream" })],
    ]);
    const safe = coordinator.filterSearchResultsByRecallSafety(results, memories, {
      stateViewActive: true,
    });
    assert.deepEqual(safe, [], "dream-surface successors must not anchor superseded rows");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("an anchored predecessor keeps its rank position when admitted", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-sv-anchor-order-"));
  try {
    const coordinator = await makeCoordinator(memoryDir);
    const { results, memories } = corpus();
    const safe = coordinator.filterSearchResultsByRecallSafety(results, memories, {
      stateViewActive: true,
    });
    assert.deepEqual(
      safe.map((r) => r.path),
      [NEW, OLD],
      "admission must not reorder candidates relative to their incoming rank",
    );
    assert.equal(safe[1]?.supersededBy, "m-new", "admitted row carries the chain fields");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("#2859 namespace fanout collision: a same-id successor in another namespace cannot anchor", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-sv-fanout-"));
  try {
    const coordinator = await makeCoordinator(memoryDir);
    const A_OLD = "facts/a-old.md";
    const B_NEW = "facts/b-new.md";
    // ns-a: superseded predecessor whose successor id m-1 is NOT in the
    // candidate set. ns-b: an unrelated active row that reuses id m-1.
    // Bare-id matching (pre-#2859) admitted the ns-a predecessor on the
    // ns-b anchor; qualified keys must not.
    const results: QmdSearchResult[] = [
      { ...result(B_NEW, 0.9), namespace: "ns-b" },
      { ...result(A_OLD, 0.7), namespace: "ns-a" },
    ];
    const memories = new Map<string, MemoryFile>([
      [`ns-b\0${B_NEW}`, memory(B_NEW, { id: "m-1", status: "active" })],
      [
        `ns-a\0${A_OLD}`,
        memory(A_OLD, {
          id: "m-0",
          status: "superseded",
          supersededBy: "m-1",
          supersededAt: "2026-08-01",
        }),
      ],
    ]);
    const safe = coordinator.filterSearchResultsByRecallSafety(results, memories, {
      stateViewActive: true,
    });
    assert.deepEqual(
      safe.map((r) => r.path),
      [B_NEW],
      "a foreign-namespace successor must never anchor the superseded row"
    );

    // Positive control: ns-a's own m-1 present → the pair is admitted.
    const A_NEW = "facts/a-new.md";
    const pairResults: QmdSearchResult[] = [
      { ...result(A_NEW, 0.9), namespace: "ns-a" },
      { ...result(A_OLD, 0.7), namespace: "ns-a" },
    ];
    const pairMemories = new Map<string, MemoryFile>([
      [`ns-a\0${A_NEW}`, memory(A_NEW, { id: "m-1", status: "active" })],
      [`ns-a\0${A_OLD}`, memories.get(`ns-a\0${A_OLD}`)!],
    ]);
    const pair = coordinator.filterSearchResultsByRecallSafety(pairResults, pairMemories, {
      stateViewActive: true,
    });
    assert.deepEqual(
      pair.map((r) => r.path),
      [A_NEW, A_OLD],
      "the same-namespace successor anchors the pair as before"
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("#2859 back-pointer anchors a deferred row whose supersededBy is absent", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-sv-backptr-"));
  try {
    const coordinator = await makeCoordinator(memoryDir);
    const results = [result(NEW, 0.9), result(OLD, 0.7)];
    const memories = new Map<string, MemoryFile>([
      [NEW, memory(NEW, { id: "m-new", status: "active", supersedes: "m-old" })],
      [
        OLD,
        memory(OLD, {
          id: "m-old",
          status: "superseded",
          supersededAt: "2026-08-01",
        }),
      ],
    ]);
    const safe = coordinator.filterSearchResultsByRecallSafety(results, memories, {
      stateViewActive: true,
    });
    assert.deepEqual(
      safe.map((r) => r.path),
      [NEW, OLD],
      "the successor's supersedes back-pointer must admit its predecessor"
    );
    assert.equal(safe[1]?.supersedes, undefined, "the admitted row itself has no back-pointer");
    assert.equal(safe[0]?.supersedes, "m-old", "the survivor carries its supersedes back-pointer");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
