import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

class FakeElement {
  value = "";
  textContent = "";
  disabled = false;
  className = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};

  addEventListener(): void {}
  appendChild(): void {}
  removeChild(): void {}
  get firstChild(): null {
    return null;
  }
}

/** Minimal fake canvas context — records calls but does nothing. */
class FakeCanvasContext {
  calls: string[] = [];
  save() { this.calls.push("save"); }
  restore() { this.calls.push("restore"); }
  clearRect() { this.calls.push("clearRect"); }
  scale() {}
  translate() {}
  beginPath() {}
  arc() {}
  fill() {}
  stroke() {}
  moveTo() {}
  lineTo() {}
  fillText() {}
  get fillStyle() { return ""; }
  set fillStyle(_v: string) {}
  get strokeStyle() { return ""; }
  set strokeStyle(_v: string) {}
  get lineWidth() { return 1; }
  set lineWidth(_v: number) {}
  get globalAlpha() { return 1; }
  set globalAlpha(_v: number) {}
  get font() { return ""; }
  set font(_v: string) {}
  get textAlign() { return ""; }
  set textAlign(_v: string) {}
}

class FakeCanvas extends FakeElement {
  width = 0;
  height = 0;
  offsetWidth = 800;
  offsetHeight = 520;
  _ctx = new FakeCanvasContext();
  getContext(_type: string) { return this._ctx; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 520 }; }
}

async function loadAdminConsoleContext(pageSizeValue: string, extraElements: Record<string, FakeElement> = {}) {
  const scriptPath = path.resolve("admin-console/public/app.js");
  const script = await readFile(scriptPath, "utf8");
  const elements = new Map<string, FakeElement>([
    ["memoryPrevButton", new FakeElement()],
    ["memoryNextButton", new FakeElement()],
    ["memoryPageStatus", new FakeElement()],
    ["memoryPageSize", Object.assign(new FakeElement(), { value: pageSizeValue })],
    ...Object.entries(extraElements),
  ]);
  const session = new Map<string, string>();
  const context = vm.createContext({
    console,
    URLSearchParams,
    requestAnimationFrame: (_fn: () => void) => 0,
    cancelAnimationFrame: (_id: number) => {},
    document: {
      getElementById(id: string) {
        return elements.get(id) ?? null;
      },
      createElement() {
        return new FakeElement();
      },
    },
    window: {
      devicePixelRatio: 1,
      sessionStorage: {
        getItem(key: string) {
          return session.get(key) ?? "";
        },
        setItem(key: string, value: string) {
          session.set(key, value);
        },
        removeItem(key: string) {
          session.delete(key);
        },
      },
    },
    navigator: {},
  });
  vm.runInContext(script, context, { filename: scriptPath });

  type GraphNode = { id: string; label: string; kind: string; score: number; lastUpdated: string; x: number; y: number; vx: number; vy: number; _memoryId: null };
  type GraphEdge = { source: string; target: string; kind: string; weight: number; label: string; confidence: number; _srcNode: GraphNode; _tgtNode: GraphNode };
  type GraphData = { nodes: GraphNode[]; edges: GraphEdge[] } | null;
  type OrphanEdge = { source: string; target: string; kind: string; weight?: number; label?: string; confidence?: number };
  type AppEvent = { type: string; payload: Record<string, unknown>; ts: string };

  return {
    browserState: vm.runInContext("browserState", context) as { limit: number; offset: number; total: number },
    copyMemoryPath: vm.runInContext("copyMemoryPath", context) as () => void,
    renderQuality: vm.runInContext("renderQuality", context) as (response: unknown) => void,
    stepMemoryPage: vm.runInContext("stepMemoryPage", context) as (direction: number) => void,
    graphColorForCategory: vm.runInContext("graphColorForCategory", context) as (cat: string) => string,
    createForceSimulation: vm.runInContext("createForceSimulation", context) as (
      nodes: Array<{ id: string; score: number; kind: string; x?: number; y?: number; vx?: number; vy?: number }>,
      edges: Array<{ _srcNode: unknown; _tgtNode: unknown }>,
      width: number,
      height: number,
    ) => { start: (fn: () => void) => void; stop: () => void },
    drawGraph: vm.runInContext("drawGraph", context) as () => void,
    graphData: vm.runInContext("graphData", context) as GraphData,
    graphView: vm.runInContext("graphView", context) as { tx: number; ty: number; scale: number },
    resolveHighlights: vm.runInContext("resolveHighlights", context) as (
      nodes: Array<{ id: string }>,
      results: Array<{ id: string; path?: string }>,
    ) => Map<string, string>,
    applyGraphEvent: vm.runInContext("applyGraphEvent", context) as (event: AppEvent) => void,
    loadMemoryGraph: vm.runInContext("loadMemoryGraph", context) as () => Promise<void>,
    _orphanEdgeQueue: vm.runInContext("_orphanEdgeQueue", context) as OrphanEdge[],
    getContext: () => context,
  };
}

test("admin console pagination step reads the current page size before advancing", async () => {
  const { browserState, stepMemoryPage } = await loadAdminConsoleContext("10");
  browserState.limit = 25;
  browserState.offset = 50;

  stepMemoryPage(1);

  assert.equal(browserState.limit, 10);
  assert.equal(browserState.offset, 60);
});

test("admin console pagination step reads the current page size before retreating", async () => {
  const { browserState, stepMemoryPage } = await loadAdminConsoleContext("10");
  browserState.limit = 25;
  browserState.offset = 50;

  stepMemoryPage(-1);

  assert.equal(browserState.limit, 10);
  assert.equal(browserState.offset, 40);
});

test("admin console quality renderer tolerates a missing JSON mount", async () => {
  const { renderQuality } = await loadAdminConsoleContext("25", {
    qualitySummary: new FakeElement(),
  });

  assert.doesNotThrow(() => {
    renderQuality({
      totalMemories: 2,
      archivePressure: { pendingReview: 1, archived: 0 },
      latestGovernanceRun: { qualityScore: { score: 90 } },
    });
  });
});

test("admin console copy path fails cleanly when no memory is selected", async () => {
  const detailStatus = new FakeElement();
  const { copyMemoryPath } = await loadAdminConsoleContext("25", {
    memoryDetailStatus: detailStatus,
    memoryRawPath: new FakeElement(),
  });

  copyMemoryPath();

  assert.equal(detailStatus.textContent, "No memory path to copy.");
  assert.equal(detailStatus.className, "status error");
});

// ─────────────────────────────────────────────────────────────────────────────
// Memory Graph pane — issue #691 PR 3/5
// ─────────────────────────────────────────────────────────────────────────────

test("graph category colour palette returns a stable colour for known categories", async () => {
  const { graphColorForCategory } = await loadAdminConsoleContext("25");
  const c1 = graphColorForCategory("fact");
  const c2 = graphColorForCategory("fact");
  // Same category always yields the same colour.
  assert.equal(c1, c2);
  // Unknown / empty yields the grey fallback.
  assert.equal(graphColorForCategory("unknown"), "#aaa");
  assert.equal(graphColorForCategory(""), "#aaa");
});

test("graph category colour palette assigns different colours to distinct categories", async () => {
  const { graphColorForCategory } = await loadAdminConsoleContext("25");
  const factColor = graphColorForCategory("fact");
  const decisionColor = graphColorForCategory("decision");
  // Two distinct categories must not share the same colour
  // (palette has 8 entries; the first two are always different).
  assert.notEqual(factColor, decisionColor);
});

test("force simulation places all nodes with x/y after start", async () => {
  const { createForceSimulation } = await loadAdminConsoleContext("25");

  const nodes = [
    { id: "a", score: 0.9, kind: "fact" },
    { id: "b", score: 0.5, kind: "decision" },
    { id: "c", score: 0.3, kind: "fact" },
  ];
  const edges = [
    { _srcNode: nodes[0], _tgtNode: nodes[1] },
    { _srcNode: nodes[1], _tgtNode: nodes[2] },
  ];

  const sim = createForceSimulation(nodes, edges, 800, 520);
  // start with a no-op draw callback; raf is stubbed to 0 so no loop runs.
  sim.start(() => {});
  sim.stop();

  for (const n of nodes) {
    assert.ok(typeof (n as { x?: number }).x === "number", `node ${n.id} missing x`);
    assert.ok(typeof (n as { y?: number }).y === "number", `node ${n.id} missing y`);
    assert.ok(!Number.isNaN((n as { x?: number }).x));
    assert.ok(!Number.isNaN((n as { y?: number }).y));
  }
});

test("drawGraph is a no-op when graphData is null", async () => {
  const canvas = new FakeCanvas();
  const graphStatus = new FakeElement();
  const { drawGraph } = await loadAdminConsoleContext("25", {
    graphCanvas: canvas,
    graphStatus,
  });

  // graphData starts null; drawGraph must not throw.
  assert.doesNotThrow(() => drawGraph());
  // Canvas context must not have been touched (no save calls).
  assert.equal(canvas._ctx.calls.length, 0);
});

test("loadMemoryGraph keeps an empty snapshot subscribed for live graph events", async () => {
  const { getContext, loadMemoryGraph, _orphanEdgeQueue } = await loadAdminConsoleContext("25", {
    graphCanvas: new FakeCanvas(),
    graphStatus: new FakeElement(),
    graphLegend: new FakeElement(),
  });
  const context = getContext();
  _orphanEdgeQueue.push({
    source: "facts/old-a.md",
    target: "facts/old-b.md",
    kind: "entity",
  });

  vm.runInContext(
    `
      globalThis.__closedGraphEventSource = false;
      graphEventSource = { close() { globalThis.__closedGraphEventSource = true; } };
      globalThis.__graphEventSourceUrl = "";
      EventSource = class {
        constructor(url) {
          globalThis.__graphEventSourceUrl = url;
        }
        close() {}
      };
      writeToken("graph-token");
      fetchJson = async () => ({ nodes: [], edges: [], generatedAt: "2026-05-31T00:00:00.000Z" });
    `,
    context,
  );

  await loadMemoryGraph();

  assert.equal(vm.runInContext("globalThis.__closedGraphEventSource", context), true);
  assert.notEqual(vm.runInContext("graphEventSource", context), null);
  assert.equal(
    vm.runInContext("globalThis.__graphEventSourceUrl", context),
    "/engram/v1/graph/events?token=graph-token",
  );
  assert.equal(vm.runInContext("graphData.nodes.length", context), 0);
  assert.equal(_orphanEdgeQueue.length, 0);

  vm.runInContext(
    `
      applyGraphEvent({
        type: "node-added",
        payload: { nodeId: "facts/live.md", kind: "fact", label: "Live" },
        ts: "2026-05-31T00:00:01.000Z",
      });
    `,
    context,
  );

  assert.equal(vm.runInContext("graphData.nodes.length", context), 1);
});

test("loadMemoryGraph materializes missing edge endpoints from snapshot edges", async () => {
  const { getContext, loadMemoryGraph } = await loadAdminConsoleContext("25", {
    graphCanvas: new FakeCanvas(),
    graphStatus: new FakeElement(),
    graphLegend: new FakeElement(),
  });
  const context = getContext();

  vm.runInContext(
    `
      fetchJson = async () => ({
        nodes: [],
        edges: [{ source: "facts/a.md", target: "facts/b.md", kind: "entity", weight: 1, label: "", confidence: 1 }],
        generatedAt: "2026-05-31T00:00:00.000Z",
      });
    `,
    context,
  );

  await loadMemoryGraph();

  assert.equal(vm.runInContext("graphData.nodes.length", context), 2);
  assert.equal(vm.runInContext("graphData.edges.length", context), 1);
  assert.equal(vm.runInContext("graphData.edges[0]._srcNode.id", context), "facts/a.md");
  assert.equal(vm.runInContext("graphData.edges[0]._tgtNode.id", context), "facts/b.md");
  assert.match(vm.runInContext('document.getElementById("graphStatus").textContent', context), /Loaded 2 nodes, 1 edges/);
});

test("stale graph refresh failure does not restore an older simulation over newer data", async () => {
  const { getContext, loadMemoryGraph } = await loadAdminConsoleContext("25", {
    graphCanvas: new FakeCanvas(),
    graphStatus: new FakeElement(),
    graphLegend: new FakeElement(),
  });
  const context = getContext();

  vm.runInContext(
    `
      fetchJson = async () => ({
        nodes: [{ id: "facts/old.md", label: "Old", kind: "fact", score: 1, metadata: {}, lastUpdated: "" }],
        edges: [],
        generatedAt: "2026-05-31T00:00:00.000Z",
      });
    `,
    context,
  );
  await loadMemoryGraph();
  vm.runInContext("globalThis.__oldGraphSim = graphSim;", context);

  vm.runInContext(
    `
      globalThis.__rejectFirstRefresh = null;
      let refreshCalls = 0;
      fetchJson = () => {
        refreshCalls += 1;
        if (refreshCalls === 1) {
          return new Promise((_, reject) => {
            globalThis.__rejectFirstRefresh = reject;
          });
        }
        return Promise.resolve({
          nodes: [{ id: "facts/new.md", label: "New", kind: "decision", score: 1, metadata: {}, lastUpdated: "" }],
          edges: [],
          generatedAt: "2026-05-31T00:00:01.000Z",
        });
      };
    `,
    context,
  );

  const staleRefresh = loadMemoryGraph();
  const currentRefresh = loadMemoryGraph();
  await currentRefresh;
  vm.runInContext("globalThis.__rejectFirstRefresh(new Error('stale refresh failed'));", context);
  await staleRefresh;

  assert.equal(vm.runInContext("graphData.nodes[0].id", context), "facts/new.md");
  assert.equal(vm.runInContext("graphSim === globalThis.__oldGraphSim", context), false);
});

test("graph pane HTML elements are present in index.html", async () => {
  const htmlPath = path.resolve("admin-console/public/index.html");
  const html = await readFile(htmlPath, "utf8");

  assert.ok(html.includes('id="graphCanvas"'), "graphCanvas element missing");
  assert.ok(html.includes('id="graphTooltip"'), "graphTooltip element missing");
  assert.ok(html.includes('id="graphStatus"'), "graphStatus element missing");
  assert.ok(html.includes('id="graphLegend"'), "graphLegend element missing");
  assert.ok(html.includes('id="refreshGraphButton"'), "refreshGraphButton missing");
  assert.ok(html.includes('id="resetGraphViewButton"'), "resetGraphViewButton missing");
  assert.ok(html.includes('id="graphLimit"'), "graphLimit select missing");
  assert.ok(html.includes('id="graphFocusNodeId"'), "graphFocusNodeId input missing");
});

// ─────────────────────────────────────────────────────────────────────────────
// Semantic-search highlight + drill-through — issue #691 PR 4/5
// ─────────────────────────────────────────────────────────────────────────────

test("graph search highlight HTML elements are present in index.html", async () => {
  const htmlPath = path.resolve("admin-console/public/index.html");
  const html = await readFile(htmlPath, "utf8");

  assert.ok(html.includes('id="graphSearchQuery"'), "graphSearchQuery input missing");
  assert.ok(html.includes('id="graphSearchButton"'), "graphSearchButton missing");
  assert.ok(html.includes('id="graphClearSearchButton"'), "graphClearSearchButton missing");
  assert.ok(html.includes('id="graphNodePanel"'), "graphNodePanel missing");
  assert.ok(html.includes('id="graphNodeFrontmatter"'), "graphNodeFrontmatter missing");
  assert.ok(html.includes('id="graphNodeContent"'), "graphNodeContent missing");
  assert.ok(html.includes('id="graphNodeEdges"'), "graphNodeEdges missing");
});

test("resolveHighlights returns empty map when results array is empty", async () => {
  const { resolveHighlights } = await loadAdminConsoleContext("25");
  const nodes = [{ id: "facts/foo.md" }, { id: "facts/bar.md" }];
  const result = resolveHighlights(nodes, []);
  assert.equal(result.size, 0);
});

test("resolveHighlights matches via result.path suffix against node.id (production case)", async () => {
  const { resolveHighlights } = await loadAdminConsoleContext("25");
  // Typical production: node.id is relative path, result carries absolute path + frontmatter id.
  const nodes = [
    { id: "facts/foo.md" },
    { id: "facts/bar.md" },
    { id: "decisions/baz.md" },
  ];
  const results = [
    { id: "fact-abc123", path: "/Users/me/.remnic/facts/foo.md" },
    { id: "decision-xyz", path: "/Users/me/.remnic/decisions/baz.md" },
  ];
  const matched = resolveHighlights(nodes, results);
  assert.equal(matched.size, 2);
  // Map keys are node IDs; values are frontmatter IDs for the detail endpoint.
  assert.ok(matched.has("facts/foo.md"));
  assert.equal(matched.get("facts/foo.md"), "fact-abc123");
  assert.ok(matched.has("decisions/baz.md"));
  assert.equal(matched.get("decisions/baz.md"), "decision-xyz");
  assert.ok(!matched.has("facts/bar.md"));
});

test("resolveHighlights falls back to frontmatter id match when path absent", async () => {
  const { resolveHighlights } = await loadAdminConsoleContext("25");
  // When result has no path, fall back to id-based suffix matching.
  const nodes = [{ id: "facts/foo.md" }];
  const results = [{ id: "facts/foo.md" }];
  const matched = resolveHighlights(nodes, results);
  assert.equal(matched.size, 1);
  assert.ok(matched.has("facts/foo.md"));
});

test("resolveHighlights matches when result id is a suffix of node id (no path)", async () => {
  const { resolveHighlights } = await loadAdminConsoleContext("25");
  const nodes = [{ id: "/Users/me/.remnic/facts/foo.md" }];
  const results = [{ id: "facts/foo.md" }];
  const matched = resolveHighlights(nodes, results);
  assert.equal(matched.size, 1);
  assert.ok(matched.has("/Users/me/.remnic/facts/foo.md"));
});

test("resolveHighlights matches when node id is a suffix of result path", async () => {
  const { resolveHighlights } = await loadAdminConsoleContext("25");
  const nodes = [{ id: "facts/foo.md" }];
  const results = [{ id: "fact-xyz", path: "/Users/me/.remnic/facts/foo.md" }];
  const matched = resolveHighlights(nodes, results);
  assert.equal(matched.size, 1);
  // Value is the frontmatter ID, not the path.
  assert.equal(matched.get("facts/foo.md"), "fact-xyz");
});

test("resolveHighlights does not match unrelated ids", async () => {
  const { resolveHighlights } = await loadAdminConsoleContext("25");
  const nodes = [{ id: "facts/alpha.md" }, { id: "facts/beta.md" }];
  const results = [{ id: "decision-xyz", path: "/Users/me/.remnic/decisions/gamma.md" }];
  const matched = resolveHighlights(nodes, results);
  assert.equal(matched.size, 0);
});

test("resolveHighlights handles nodes with missing ids gracefully", async () => {
  const { resolveHighlights } = await loadAdminConsoleContext("25");
  const nodes = [{ id: "" }, { id: "facts/foo.md" }] as Array<{ id: string }>;
  const results = [{ id: "fact-abc", path: "/Users/me/.remnic/facts/foo.md" }];
  const matched = resolveHighlights(nodes, results);
  assert.equal(matched.size, 1);
  assert.ok(matched.has("facts/foo.md"));
});

test("resolveHighlights returns empty map when nodes array is empty", async () => {
  const { resolveHighlights } = await loadAdminConsoleContext("25");
  const matched = resolveHighlights([], [{ id: "fact-abc", path: "/Users/me/.remnic/facts/foo.md" }]);
  assert.equal(matched.size, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Orphan edge queue — issue #691 PR 5/5 (Codex thread PRRT_kwDORJXyws59soGK)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal graphData-aware context for applyGraphEvent unit tests.
 * We initialise graphData using a small VM snippet that assigns the script's
 * own `let graphData` binding, so applyGraphEvent's closure sees the value.
 */
async function loadGraphEventContext() {
  const ctx = await loadAdminConsoleContext("25");
  const ts = new Date().toISOString();
  // Run a snippet inside the same VM context that assigns the module-level
  // `graphData` variable directly.  Setting vmCtx.graphData would NOT work
  // because the script's `let graphData` shadows the context property.
  vm.runInContext("graphData = { nodes: [], edges: [] };", ctx.getContext());
  // Expose a live reference to the array objects via the VM's own getter.
  const getGraphData = vm.runInContext("() => graphData", ctx.getContext()) as () => { nodes: unknown[]; edges: unknown[] };
  return { ...ctx, ts, getGraphData };
}

test("edge-added with both nodes present is applied immediately (no orphan queue)", async () => {
  const { applyGraphEvent, _orphanEdgeQueue, getGraphData, ts } = await loadGraphEventContext();

  applyGraphEvent({ type: "node-added", payload: { nodeId: "facts/a.md", kind: "fact", label: "A" }, ts });
  applyGraphEvent({ type: "node-added", payload: { nodeId: "facts/b.md", kind: "fact", label: "B" }, ts });
  applyGraphEvent({ type: "edge-added", payload: { source: "facts/a.md", target: "facts/b.md", kind: "entity", weight: 1, label: "", confidence: 1 }, ts });

  assert.equal(getGraphData().edges.length, 1, "edge must be applied immediately when both nodes exist");
  assert.equal(_orphanEdgeQueue.length, 0, "orphan queue must be empty when both nodes were present");
});

test("edge-added with missing source node is queued and applied when node arrives", async () => {
  const { applyGraphEvent, _orphanEdgeQueue, getGraphData, ts } = await loadGraphEventContext();

  // Only target node present.
  applyGraphEvent({ type: "node-added", payload: { nodeId: "facts/b.md", kind: "fact", label: "B" }, ts });

  // Edge arrives before source node.
  applyGraphEvent({ type: "edge-added", payload: { source: "facts/a.md", target: "facts/b.md", kind: "entity", weight: 1, label: "", confidence: 1 }, ts });

  assert.equal(getGraphData().edges.length, 0, "edge must not be applied while source node is absent");
  assert.equal(_orphanEdgeQueue.length, 1, "edge must be queued while source node is absent");

  // Source node arrives later.
  applyGraphEvent({ type: "node-added", payload: { nodeId: "facts/a.md", kind: "fact", label: "A" }, ts });

  assert.equal(getGraphData().edges.length, 1, "queued edge must be applied once source node arrives");
  assert.equal(_orphanEdgeQueue.length, 0, "orphan queue must be drained after source node arrives");
});

test("edge-added with missing target node is queued and applied when node arrives", async () => {
  const { applyGraphEvent, _orphanEdgeQueue, getGraphData, ts } = await loadGraphEventContext();

  // Only source node present.
  applyGraphEvent({ type: "node-added", payload: { nodeId: "facts/a.md", kind: "fact", label: "A" }, ts });
  applyGraphEvent({ type: "edge-added", payload: { source: "facts/a.md", target: "facts/c.md", kind: "entity", weight: 0.8, label: "x", confidence: 0.9 }, ts });

  assert.equal(getGraphData().edges.length, 0);
  assert.equal(_orphanEdgeQueue.length, 1);

  applyGraphEvent({ type: "node-added", payload: { nodeId: "facts/c.md", kind: "fact", label: "C" }, ts });

  assert.equal(getGraphData().edges.length, 1);
  assert.equal(_orphanEdgeQueue.length, 0);
  // Weight and confidence must be preserved through the queue.
  const edge = getGraphData().edges[0] as Record<string, unknown>;
  assert.equal(edge.weight, 0.8);
  assert.equal(edge.confidence, 0.9);
});

test("orphan edge with both nodes missing is applied once the second node arrives", async () => {
  const { applyGraphEvent, _orphanEdgeQueue, getGraphData, ts } = await loadGraphEventContext();

  // Neither endpoint node is present yet.
  applyGraphEvent({ type: "edge-added", payload: { source: "facts/x.md", target: "facts/y.md", kind: "entity", weight: 1, label: "", confidence: 1 }, ts });

  assert.equal(_orphanEdgeQueue.length, 1, "edge must be queued when both nodes are absent");

  // First node arrives — still can't apply edge.
  applyGraphEvent({ type: "node-added", payload: { nodeId: "facts/x.md", kind: "fact", label: "X" }, ts });
  assert.equal(getGraphData().edges.length, 0, "edge still pending after only one node arrives");
  assert.equal(_orphanEdgeQueue.length, 1, "edge still in queue after only one node arrives");

  // Second node arrives — edge can now be applied.
  applyGraphEvent({ type: "node-added", payload: { nodeId: "facts/y.md", kind: "fact", label: "Y" }, ts });
  assert.equal(getGraphData().edges.length, 1, "edge applied once second node arrives");
  assert.equal(_orphanEdgeQueue.length, 0, "orphan queue empty after both nodes arrived");
});

test("duplicate orphan edges are not queued twice", async () => {
  const { applyGraphEvent, _orphanEdgeQueue, ts } = await loadGraphEventContext();

  // Same edge twice before either node arrives.
  applyGraphEvent({ type: "edge-added", payload: { source: "facts/p.md", target: "facts/q.md", kind: "entity", weight: 1, label: "", confidence: 1 }, ts });
  applyGraphEvent({ type: "edge-added", payload: { source: "facts/p.md", target: "facts/q.md", kind: "entity", weight: 1, label: "", confidence: 1 }, ts });

  assert.equal(_orphanEdgeQueue.length, 1, "duplicate orphan edge must not be queued twice");
});

test("edge-removed mutates graph arrays in place for the active simulation", async () => {
  const { applyGraphEvent, getContext, getGraphData, ts } = await loadGraphEventContext();
  const context = getContext();

  vm.runInContext(
    `
      const a = { id: "facts/a.md", label: "A", kind: "fact", score: 1, x: 10, y: 10, vx: 0, vy: 0 };
      const b = { id: "facts/b.md", label: "B", kind: "fact", score: 1, x: 20, y: 20, vx: 0, vy: 0 };
      const c = { id: "facts/c.md", label: "C", kind: "fact", score: 1, x: 30, y: 30, vx: 0, vy: 0 };
      graphData.nodes.push(a, b, c);
      graphData.edges.push({ source: "facts/a.md", target: "facts/b.md", kind: "entity", weight: 1, label: "", confidence: 1, _srcNode: a, _tgtNode: b });
      graphSim = createForceSimulation(graphData.nodes, graphData.edges, 800, 520);
      globalThis.__nodesRef = graphData.nodes;
      globalThis.__edgesRef = graphData.edges;
    `,
    context,
  );

  const before = getGraphData();
  applyGraphEvent({
    type: "edge-removed",
    payload: { source: "facts/a.md", target: "facts/b.md", kind: "entity" },
    ts,
  });
  const after = getGraphData();

  assert.equal(after.nodes, before.nodes, "node array identity must be preserved");
  assert.equal(after.edges, before.edges, "edge array identity must be preserved");
  assert.equal(after.edges.length, 0);
  assert.equal(after.nodes.map((node) => (node as { id: string }).id).join(","), "facts/c.md");
  assert.equal(vm.runInContext("globalThis.__nodesRef === graphData.nodes", context), true);
  assert.equal(vm.runInContext("globalThis.__edgesRef === graphData.edges", context), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// applyGraphEvent: guard for graphData === null
// ─────────────────────────────────────────────────────────────────────────────

test("applyGraphEvent is a no-op when graphData is null", async () => {
  const ctx = await loadAdminConsoleContext("25");
  // graphData starts as null; applyGraphEvent must not throw.
  assert.doesNotThrow(() =>
    ctx.applyGraphEvent({
      type: "edge-added",
      payload: { source: "facts/a.md", target: "facts/b.md", kind: "entity", weight: 1, label: "", confidence: 1 },
      ts: new Date().toISOString(),
    }),
  );
});
