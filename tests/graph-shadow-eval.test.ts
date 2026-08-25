import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { parseConfig } from "@remnic/core/config";
import { Orchestrator } from "@remnic/core/orchestrator";
import type { EngramTraceEvent } from "@remnic/core/types";

test("full-mode graph shadow eval keeps injected recall baseline-identical", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-graph-shadow-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: true,
    qmdCollection: "engram-test",
    qmdMaxResults: 3,
    recallPlannerEnabled: true,
    graphRecallEnabled: true,
    multiGraphMemoryEnabled: true,
    graphAssistInFullModeEnabled: true,
    graphAssistShadowEvalEnabled: true,
    graphAssistMinSeedResults: 1,
    verbatimArtifactsEnabled: false,
  });
  const orchestrator = new Orchestrator(cfg);

  const { id: seedId } = await orchestrator.storage.writeMemory("fact", "seed baseline memory");
  const seedMemory = await orchestrator.storage.getMemoryById(seedId);
  assert.ok(seedMemory);

  const { id: expandedId } = await orchestrator.storage.writeMemory("fact", "shadow-only memory");
  const expandedMemory = await orchestrator.storage.getMemoryById(expandedId);
  assert.ok(expandedMemory);

  (orchestrator as any).qmd = {
    isAvailable: () => true,
    hybridSearch: async () => [
      {
        docid: seedMemory!.frontmatter.id,
        path: seedMemory!.path,
        snippet: "seed baseline memory",
        score: 0.9,
      },
    ],
    search: async () => [],
  };

  (orchestrator as any).expandResultsViaGraph = async ({ memoryResults }: any) => ({
    merged: [
      {
        docid: expandedMemory!.frontmatter.id,
        path: expandedMemory!.path,
        snippet: "shadow-only memory",
        score: 0.99,
      },
      ...memoryResults,
    ],
    seedPaths: [seedMemory!.path],
    expandedPaths: [
      {
        path: expandedMemory!.path,
        score: 0.99,
        namespace: "default",
        seed: seedMemory!.path,
        hopDepth: 1,
        decayedWeight: 0.7,
        graphType: "entity",
      },
    ],
  });

  const out = await (orchestrator as any).recallInternal(
    "Summarize the current project state.",
    "session-graph-shadow-baseline",
  );

  assert.match(out, /Relevant Memories/);
  assert.match(out, /seed baseline memory/);
  assert.doesNotMatch(out, /shadow-only memory/);

  const raw = await readFile(path.join(memoryDir, "state", "last_graph_recall.json"), "utf-8");
  const snapshot = JSON.parse(raw) as {
    mode: string;
    seedCount: number;
    expandedCount: number;
  };
  assert.equal(snapshot.mode, "full");
  assert.equal(snapshot.seedCount, 1);
  assert.equal(snapshot.expandedCount, 1);
});

test("full-mode graph shadow eval emits overlap telemetry in recall timings", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-graph-shadow-telemetry-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: true,
    qmdCollection: "engram-test",
    qmdMaxResults: 3,
    recallPlannerEnabled: true,
    graphRecallEnabled: true,
    multiGraphMemoryEnabled: true,
    graphAssistInFullModeEnabled: true,
    graphAssistShadowEvalEnabled: true,
    graphAssistMinSeedResults: 1,
    verbatimArtifactsEnabled: false,
  });
  const orchestrator = new Orchestrator(cfg);

  const { id: seedId } = await orchestrator.storage.writeMemory("fact", "seed baseline memory");
  const seedMemory = await orchestrator.storage.getMemoryById(seedId);
  assert.ok(seedMemory);

  (orchestrator as any).qmd = {
    isAvailable: () => true,
    hybridSearch: async () => [
      {
        docid: seedMemory!.frontmatter.id,
        path: seedMemory!.path,
        snippet: "seed baseline memory",
        score: 0.9,
      },
    ],
    search: async () => [],
  };

  (orchestrator as any).expandResultsViaGraph = async ({ memoryResults }: any) => ({
    merged: memoryResults,
    seedPaths: [seedMemory!.path],
    expandedPaths: [],
  });

  const events: EngramTraceEvent[] = [];
  const previous = (globalThis as any).__openclawEngramTrace;
  (globalThis as any).__openclawEngramTrace = (event: EngramTraceEvent) => events.push(event);
  try {
    const out = await (orchestrator as any).recallInternal(
      "Summarize the current project state.",
      "session-graph-shadow-telemetry",
    );
    assert.match(out, /Relevant Memories/);
  } finally {
    (globalThis as any).__openclawEngramTrace = previous;
  }

  const recallEvent = events.find((event) => event.kind === "recall_summary");
  assert.ok(recallEvent && recallEvent.kind === "recall_summary");
  assert.ok(recallEvent.timings);
  assert.match(recallEvent.timings!.graphShadow ?? "", /^on b=\d+ g=\d+ ov=\d+ \(\d+\.\d{2}\) avgDelta=-?\d+\.\d{3}$/);
});
