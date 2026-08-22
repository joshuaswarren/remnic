/**
 * Graph-edge decay maintenance subject for the scenario-matrix harness.
 *
 * Every canonical row drives the REAL decay pass (`runGraphEdgeDecayMaintenance`)
 * over a temp memory dir seeded through the production `appendEdge` path, with
 * one fresh edge (inside the grace window) and one stale edge (long past it):
 *
 * - flush-transition rows (compaction / before_reset / session_end) exercise
 *   the DRY-RUN contract: telemetry is computed, but the graph JSONL stays
 *   byte-identical and no status file is written.
 * - the dedupe/replay row re-runs the pass at the same instant and asserts the
 *   documented idempotency (second pass decays nothing, rewrites nothing).
 * - the restart/reload row re-reads persisted state via a fresh
 *   `readGraphEdgeDecayStatus` call over the same disk.
 * - remaining rows assert the real write path: stale confidence drops to the
 *   floor on disk, fresh confidence is untouched, telemetry is persisted.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { appendEdge, graphFilePath, readEdgesStrict, type GraphEdge } from "../../graph.js";
import { DEFAULT_DECAY_FLOOR } from "../../graph-edge-reinforcement.js";
import {
  graphEdgeDecayStatusPath,
  readGraphEdgeDecayStatus,
  runGraphEdgeDecayMaintenance,
  type GraphEdgeDecayTelemetry,
} from "../../maintenance/graph-edge-decay.js";
import { type LifecycleSubject, runLifecycleMatrix } from "../lifecycle-matrix.js";

/** Fixed "now" so every row is deterministic. */
const NOW = "2026-06-01T00:00:00.000Z";
const FRESH_LABEL = "decay-subject-fresh";
const STALE_LABEL = "decay-subject-stale";

interface GraphEdgeDecayState {
  memoryDir: string;
  dryRun: boolean;
  edgesJsonBefore: string;
  edgesJsonAfterFirst: string | null;
  first: GraphEdgeDecayTelemetry | null;
  second: GraphEdgeDecayTelemetry | null;
  reloaded: GraphEdgeDecayTelemetry | null;
}

function freshEdge(): GraphEdge {
  return {
    from: "facts/2026-06-01/fresh.md",
    to: "facts/2026-06-01/fresh-peer.md",
    type: "entity",
    weight: 1,
    label: FRESH_LABEL,
    ts: NOW,
    confidence: 1,
    lastReinforcedAt: NOW,
  };
}

function staleEdge(): GraphEdge {
  return {
    from: "facts/2024-05-01/stale.md",
    to: "facts/2024-05-01/stale-peer.md",
    type: "entity",
    weight: 1,
    label: STALE_LABEL,
    ts: "2024-05-01T00:00:00.000Z",
    confidence: 0.9,
    lastReinforcedAt: "2024-05-01T00:00:00.000Z",
  };
}

const subject: LifecycleSubject<GraphEdgeDecayState> = {
  async setup(row) {
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-decay-subject-"));
    try {
      await appendEdge(memoryDir, freshEdge());
      await appendEdge(memoryDir, staleEdge());
    } catch (err) {
      await rm(memoryDir, { recursive: true, force: true });
      throw err;
    }
    return {
      memoryDir,
      dryRun: row.dimensions.flush !== "none",
      edgesJsonBefore: "",
      edgesJsonAfterFirst: null,
      first: null,
      second: null,
      reloaded: null,
    };
  },

  async exercise(state, row) {
    state.edgesJsonBefore = await readFile(graphFilePath(state.memoryDir, "entity"), "utf8");
    state.first = await runGraphEdgeDecayMaintenance(state.memoryDir, {
      now: NOW,
      dryRun: state.dryRun,
    });
    if (row.dimensions.dedupeOrReplay) {
      state.edgesJsonAfterFirst = await readFile(graphFilePath(state.memoryDir, "entity"), "utf8");
      state.second = await runGraphEdgeDecayMaintenance(state.memoryDir, {
        now: NOW,
        dryRun: state.dryRun,
      });
    }
    if (row.dimensions.restart) {
      state.reloaded = await readGraphEdgeDecayStatus(state.memoryDir);
    }
  },

  async invariants(state, row) {
    const first = state.first;
    assert.ok(first, "first pass returned telemetry");
    assert.equal(first.ranAt, NOW);
    assert.equal(first.edgesTotal, 2);
    assert.equal(first.edgesDecayed, 1);
    assert.equal(first.edgesBelowVisibilityThreshold, 1);
    assert.equal(first.perType.length, 3);
    assert.equal(first.topDecayedEntities[0]?.label, STALE_LABEL);

    const edges = await readEdgesStrict(state.memoryDir, "entity");
    const fresh = edges.find((e) => e.label === FRESH_LABEL);
    const stale = edges.find((e) => e.label === STALE_LABEL);
    assert.ok(fresh && stale, "seeded edges still present after the pass");

    if (state.dryRun) {
      assert.equal(fresh?.confidence, 1);
      const jsonNow = await readFile(graphFilePath(state.memoryDir, "entity"), "utf8");
      assert.equal(jsonNow, state.edgesJsonBefore, "dry-run must not rewrite the graph JSONL");
      await assert.rejects(
        readFile(graphEdgeDecayStatusPath(state.memoryDir), "utf8"),
        "dry-run must not persist a status file",
      );
      return;
    }

    assert.equal(fresh?.confidence, 1);
    assert.equal(stale?.confidence, DEFAULT_DECAY_FLOOR);
    const persisted = await readGraphEdgeDecayStatus(state.memoryDir);
    assert.ok(persisted, "status file persisted after a non-dry run");
    assert.equal(persisted?.ranAt, NOW);

    if (row.dimensions.dedupeOrReplay) {
      const second = state.second;
      assert.ok(second, "replay pass returned telemetry");
      assert.equal(second.edgesDecayed, 0, "second pass at the same instant must decay nothing");
      const jsonNow = await readFile(graphFilePath(state.memoryDir, "entity"), "utf8");
      assert.equal(jsonNow, state.edgesJsonAfterFirst, "replay pass must not rewrite the JSONL");
    }

    if (row.dimensions.restart) {
      assert.equal(state.reloaded?.ranAt, NOW, "a fresh reader recovers the persisted run state");
    }
  },

  async teardown(state) {
    await rm(state.memoryDir, { recursive: true, force: true });
  },
};

runLifecycleMatrix("graph-edge-decay", subject);
