/**
 * Unit tests for `runGraphEdgeDecayMaintenance` (issue #681 PR 2/3).
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { withTempDir as managedWithTempDir } from "../testing/tmp-dir.js";

import { appendEdge, graphFilePath, graphsDir, type GraphEdge } from "../graph.js";
import {
  DEFAULT_DECAY_FLOOR,
  DEFAULT_DECAY_PER_WINDOW,
  DEFAULT_DECAY_WINDOW_MS,
} from "../graph-edge-reinforcement.js";
import {
  discoverGraphNamespaceRoots,
  graphEdgeDecayStatusPath,
  readGraphEdgeDecayStatus,
  runGraphEdgeDecayMaintenance,
  runGraphEdgeDecayMaintenanceAcrossNamespaces,
} from "./graph-edge-decay.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function freshEdge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    from: "facts/2026-04-01/a.md",
    to: "facts/2026-04-01/b.md",
    type: "entity",
    weight: 1,
    label: "fresh-label",
    ts: "2026-04-20T00:00:00.000Z",
    confidence: 1,
    lastReinforcedAt: "2026-04-20T00:00:00.000Z",
    ...overrides,
  };
}

function midDecayEdge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  // ~150 days old (one window past the 90-day grace), confidence 0.6.
  return {
    from: "facts/2025-11-01/c.md",
    to: "facts/2025-11-01/d.md",
    type: "entity",
    weight: 1,
    label: "mid-label",
    ts: "2025-11-01T00:00:00.000Z",
    confidence: 0.6,
    lastReinforcedAt: "2025-11-01T00:00:00.000Z",
    ...overrides,
  };
}

function staleEdge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  // ~700 days old, already at the floor — should not move below the floor.
  return {
    from: "facts/2024-05-01/e.md",
    to: "facts/2024-05-01/f.md",
    type: "entity",
    weight: 1,
    label: "stale-label",
    ts: "2024-05-01T00:00:00.000Z",
    confidence: 0.1,
    lastReinforcedAt: "2024-05-01T00:00:00.000Z",
    ...overrides,
  };
}

async function seedEdges(memoryDir: string, edges: GraphEdge[]): Promise<void> {
  const filePath = graphFilePath(memoryDir, "entity");
  await mkdir(graphsDir(memoryDir), { recursive: true });
  const body = edges.map((e) => JSON.stringify(e)).join("\n") + (edges.length > 0 ? "\n" : "");
  await writeFile(filePath, body, "utf-8");
}

async function readEdgesFile(memoryDir: string): Promise<GraphEdge[]> {
  const filePath = graphFilePath(memoryDir, "entity");
  const raw = await readFile(filePath, "utf-8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as GraphEdge);
}

const withTempDir = (fn: (dir: string) => Promise<void>): Promise<void> =>
  managedWithTempDir(fn, "remnic-graph-decay-test-");

test("runs end-to-end on a fixture graph with fresh, mid-decay, stale edges", async () => {
  await withTempDir(async (memoryDir) => {
    await seedEdges(memoryDir, [freshEdge(), midDecayEdge(), staleEdge()]);

    // "now" = 2026-04-25, ~175 days past stale anchor, ~175 days past mid anchor,
    // 5 days past the fresh anchor (well within grace).
    const telemetry = await runGraphEdgeDecayMaintenance(memoryDir, {
      now: "2026-04-25T00:00:00.000Z",
    });

    assert.equal(telemetry.edgesTotal, 3);
    // Fresh: no decay. Mid: drops from 0.6. Stale: already at floor, no decay.
    assert.equal(telemetry.edgesDecayed, 1);
    // visibilityThreshold default 0.2 — only the stale edge (0.1) is below.
    assert.equal(telemetry.edgesBelowVisibilityThreshold, 1);
    assert.equal(telemetry.topDecayedEntities[0]?.label, "mid-label");
    assert.ok(telemetry.topDecayedEntities[0]?.totalDrop > 0);

    const written = await readEdgesFile(memoryDir);
    const fresh = written.find((e) => e.label === "fresh-label");
    const mid = written.find((e) => e.label === "mid-label");
    const stale = written.find((e) => e.label === "stale-label");
    assert.ok(fresh && mid && stale);
    assert.equal(fresh.confidence, 1, "fresh edge confidence preserved");
    assert.ok(mid.confidence !== undefined && mid.confidence < 0.6, "mid edge decayed");
    assert.equal(stale.confidence, 0.1, "stale edge stays at floor");
    // Fresh edge anchor preserved (no decay path advanced it).
    assert.equal(fresh.lastReinforcedAt, "2026-04-20T00:00:00.000Z");
  });
});

test("idempotent re-run produces no further decay (anchors advance correctly)", async () => {
  await withTempDir(async (memoryDir) => {
    await seedEdges(memoryDir, [midDecayEdge()]);
    const now = "2026-04-25T00:00:00.000Z";

    const first = await runGraphEdgeDecayMaintenance(memoryDir, { now });
    const after1 = (await readEdgesFile(memoryDir))[0];
    assert.equal(first.edgesDecayed, 1);

    const second = await runGraphEdgeDecayMaintenance(memoryDir, { now });
    const after2 = (await readEdgesFile(memoryDir))[0];

    // Second pass must not decay further: the anchor advanced past the
    // first pass's window, putting the edge back inside its grace window.
    assert.equal(second.edgesDecayed, 0);
    assert.equal(after2.confidence, after1.confidence, "confidence stable on re-run");
    assert.equal(
      after2.lastReinforcedAt,
      after1.lastReinforcedAt,
      "lastReinforcedAt anchor stable on re-run",
    );
  });
});

test("dry-run computes telemetry without rewriting graph files or status", async () => {
  await withTempDir(async (memoryDir) => {
    await seedEdges(memoryDir, [midDecayEdge()]);
    const before = await readEdgesFile(memoryDir);
    const beforeBytes = JSON.stringify(before);

    const telemetry = await runGraphEdgeDecayMaintenance(memoryDir, {
      now: "2026-04-25T00:00:00.000Z",
      dryRun: true,
    });

    assert.equal(telemetry.edgesDecayed, 1);
    const after = await readEdgesFile(memoryDir);
    assert.equal(JSON.stringify(after), beforeBytes, "graph file untouched in dry-run");
    const status = await readGraphEdgeDecayStatus(memoryDir);
    assert.equal(status, null, "status file not written in dry-run");
  });
});

test("telemetry record has the expected shape and is persisted", async () => {
  await withTempDir(async (memoryDir) => {
    await seedEdges(memoryDir, [
      freshEdge({ label: "alpha" }),
      midDecayEdge({ label: "beta" }),
      midDecayEdge({
        label: "gamma",
        from: "facts/x/y.md",
        to: "facts/x/z.md",
      }),
    ]);

    const telemetry = await runGraphEdgeDecayMaintenance(memoryDir, {
      now: "2026-04-25T00:00:00.000Z",
    });

    assert.ok(typeof telemetry.ranAt === "string" && telemetry.ranAt.length > 0);
    assert.ok(Number.isFinite(telemetry.durationMs) && telemetry.durationMs >= 0);
    assert.equal(telemetry.windowMs, DEFAULT_DECAY_WINDOW_MS);
    assert.equal(telemetry.perWindow, DEFAULT_DECAY_PER_WINDOW);
    assert.equal(telemetry.floor, DEFAULT_DECAY_FLOOR);
    assert.ok(Array.isArray(telemetry.perType));
    const types = telemetry.perType.map((p) => p.type).sort();
    assert.deepEqual(types, ["causal", "entity", "time"]);
    // Top decayed entities listed in descending totalDrop order, max 5,
    // labels deterministic.
    assert.ok(telemetry.topDecayedEntities.length <= 5);
    for (let i = 1; i < telemetry.topDecayedEntities.length; i += 1) {
      const prev = telemetry.topDecayedEntities[i - 1];
      const cur = telemetry.topDecayedEntities[i];
      assert.ok(prev.totalDrop >= cur.totalDrop);
    }

    // Persisted to the status file.
    const status = await readGraphEdgeDecayStatus(memoryDir);
    assert.ok(status, "status file exists");
    assert.equal(status?.edgesTotal, telemetry.edgesTotal);
    assert.equal(status?.edgesDecayed, telemetry.edgesDecayed);

    // Status path is under <memoryDir>/state/.
    const expectedPath = path.join(memoryDir, "state", "graph-edge-decay-status.json");
    assert.equal(graphEdgeDecayStatusPath(memoryDir), expectedPath);
  });
});

test("custom visibility threshold is honored", async () => {
  await withTempDir(async (memoryDir) => {
    await seedEdges(memoryDir, [
      midDecayEdge({ label: "x", confidence: 0.45, lastReinforcedAt: "2026-04-20T00:00:00.000Z" }),
    ]);

    // Edge confidence 0.45, age 5 days < 90-day grace — no decay, but it sits
    // below threshold 0.5 so the "below visibility" counter must include it.
    const telemetry = await runGraphEdgeDecayMaintenance(memoryDir, {
      now: "2026-04-25T00:00:00.000Z",
      visibilityThreshold: 0.5,
    });

    assert.equal(telemetry.edgesDecayed, 0);
    assert.equal(telemetry.edgesBelowVisibilityThreshold, 1);
    assert.equal(telemetry.visibilityThreshold, 0.5);
  });
});

test("missing graph files are treated as empty (fail-open)", async () => {
  await withTempDir(async (memoryDir) => {
    // Do not seed any edges — directory is empty.
    const telemetry = await runGraphEdgeDecayMaintenance(memoryDir, {
      now: "2026-04-25T00:00:00.000Z",
    });
    assert.equal(telemetry.edgesTotal, 0);
    assert.equal(telemetry.edgesDecayed, 0);
    assert.equal(telemetry.edgesBelowVisibilityThreshold, 0);
    assert.deepEqual(telemetry.topDecayedEntities, []);
  });
});

test("disabled flag is honored by the parsed config (default = false)", async () => {
  // Verifies that the public Config defaults the flag to disabled, so the
  // call sites that gate the cron / MCP tool on `cfg.graphEdgeDecayEnabled`
  // start as no-ops out of the box (opt-in posture).
  const { parseConfig } = await import("../config.js");
  const parsed = parseConfig({});
  assert.equal(parsed.graphEdgeDecayEnabled, false);
  assert.equal(parsed.graphEdgeDecayCadenceMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(parsed.graphEdgeDecayWindowMs, 90 * 24 * 60 * 60 * 1000);
  assert.equal(parsed.graphEdgeDecayPerWindow, 0.1);
  assert.equal(parsed.graphEdgeDecayFloor, 0.1);
  assert.equal(parsed.graphEdgeDecayVisibilityThreshold, 0.2);

  // Boolean coercion: strings "false"/"0"/"off" must remain false (gotcha #36).
  assert.equal(parseConfig({ graphEdgeDecayEnabled: "false" }).graphEdgeDecayEnabled, false);
  assert.equal(parseConfig({ graphEdgeDecayEnabled: "0" }).graphEdgeDecayEnabled, false);
  assert.equal(parseConfig({ graphEdgeDecayEnabled: "off" }).graphEdgeDecayEnabled, false);
  assert.equal(parseConfig({ graphEdgeDecayEnabled: true }).graphEdgeDecayEnabled, true);
  assert.equal(parseConfig({ graphEdgeDecayEnabled: "true" }).graphEdgeDecayEnabled, true);
});

test("concurrent appendEdge calls during a decay run preserve every appended edge", async () => {
  // Issue #729 / Codex P1, line 224: the decay rewrite must hold the
  // same write lock as `appendEdge` so an ingestion that lands between
  // the read-snapshot and the rewrite is not silently dropped.
  await withTempDir(async (memoryDir) => {
    // Seed an existing edge that the decay run will scan.
    await seedEdges(memoryDir, [midDecayEdge()]);

    const concurrentAppends = 25;
    const decayPromise = runGraphEdgeDecayMaintenance(memoryDir, {
      now: "2026-04-25T00:00:00.000Z",
    });

    // Fire many concurrent appends while the decay rewrite is in flight.
    // Without the per-file lock, some of these would be lost when the
    // decay job's snapshot replaces the file.
    const appendPromises: Promise<void>[] = [];
    for (let i = 0; i < concurrentAppends; i += 1) {
      appendPromises.push(
        appendEdge(memoryDir, {
          from: `facts/2026-04-22/append-${i}.md`,
          to: `facts/2026-04-22/target.md`,
          type: "entity",
          weight: 1,
          label: `concurrent-append-${i}`,
          ts: "2026-04-22T00:00:00.000Z",
          confidence: 1,
          lastReinforcedAt: "2026-04-22T00:00:00.000Z",
        }),
      );
    }

    await Promise.all([decayPromise, ...appendPromises]);

    const final = await readEdgesFile(memoryDir);
    const appendedLabels = new Set(
      final
        .map((e) => e.label)
        .filter((l) => typeof l === "string" && l.startsWith("concurrent-append-")),
    );
    assert.equal(
      appendedLabels.size,
      concurrentAppends,
      `expected ${concurrentAppends} concurrent-append-* edges to survive, found ${appendedLabels.size}`,
    );
    // The pre-seeded edge must still be present too.
    const preserved = final.some((e) => e.label === "mid-label");
    assert.ok(preserved, "expected pre-seeded mid-decay edge to remain after concurrent run");
  });
});

test("read failures other than ENOENT surface as a thrown error", async () => {
  // Issue #729 / Codex P1, line 120: the decay job must distinguish
  // ENOENT (no edges yet) from real I/O outages so operators see a
  // failed run rather than silent zero-count "success" telemetry.
  await withTempDir(async (memoryDir) => {
    await mkdir(graphsDir(memoryDir), { recursive: true });
    const filePath = graphFilePath(memoryDir, "entity");
    // Replace the file location with a directory so readFile gets EISDIR
    // (a non-ENOENT error path that previously was silently swallowed).
    await mkdir(filePath, { recursive: true });

    await assert.rejects(
      runGraphEdgeDecayMaintenance(memoryDir, { now: "2026-04-25T00:00:00.000Z" }),
      (err: unknown) => {
        if (!(err instanceof Error)) return false;
        const code = (err as NodeJS.ErrnoException).code;
        return code !== "ENOENT";
      },
    );
  });
});

test("namespace discovery enumerates default + every safe subdir under namespaces/", async () => {
  // Codex P2 / gotcha #42: the multi-root runner must reach every
  // namespace storage root, not just `memoryDir`.
  await withTempDir(async (memoryDir) => {
    await mkdir(path.join(memoryDir, "namespaces", "team-alpha"), { recursive: true });
    await mkdir(path.join(memoryDir, "namespaces", "team-beta"), { recursive: true });

    const enabled = await discoverGraphNamespaceRoots(memoryDir, {
      namespacesEnabled: true,
      defaultNamespace: "default",
    });
    const enabledNames = new Set(enabled.map((r) => r.namespace));
    assert.ok(enabledNames.has("default"));
    assert.ok(enabledNames.has("team-alpha"));
    assert.ok(enabledNames.has("team-beta"));
    const alphaRoot = enabled.find((r) => r.namespace === "team-alpha")?.storageRoot;
    assert.equal(alphaRoot, path.join(memoryDir, "namespaces", "team-alpha"));

    // namespacesEnabled=false returns only the default root.
    const disabled = await discoverGraphNamespaceRoots(memoryDir, {
      namespacesEnabled: false,
      defaultNamespace: "default",
    });
    assert.equal(disabled.length, 1);
    assert.equal(disabled[0].namespace, "default");
    assert.equal(disabled[0].storageRoot, memoryDir);
  });
});

test("multi-root decay runs against every namespace storage root", async () => {
  // Issue #729 / Codex P2: the MCP handler previously only ran decay
  // against memoryDir, leaving non-default namespace graphs un-decayed.
  await withTempDir(async (memoryDir) => {
    // Seed default namespace at memoryDir.
    await seedEdges(memoryDir, [midDecayEdge({ label: "default-ns-edge" })]);
    // Seed a team-alpha namespace under memoryDir/namespaces/team-alpha.
    const alphaRoot = path.join(memoryDir, "namespaces", "team-alpha");
    await mkdir(graphsDir(alphaRoot), { recursive: true });
    await writeFile(
      graphFilePath(alphaRoot, "entity"),
      JSON.stringify(midDecayEdge({ label: "alpha-ns-edge" })) + "\n",
      "utf-8",
    );

    const results = await runGraphEdgeDecayMaintenanceAcrossNamespaces(memoryDir, {
      namespacesEnabled: true,
      defaultNamespace: "default",
      now: "2026-04-25T00:00:00.000Z",
    });

    const byNamespace = new Map(results.map((r) => [r.namespace, r]));
    assert.ok(byNamespace.has("default"), "default namespace must be in results");
    assert.ok(byNamespace.has("team-alpha"), "team-alpha namespace must be in results");

    const defaultResult = byNamespace.get("default")!;
    const alphaResult = byNamespace.get("team-alpha")!;
    assert.ok(defaultResult.telemetry, "default namespace must have telemetry");
    assert.ok(alphaResult.telemetry, "team-alpha namespace must have telemetry");
    assert.equal(defaultResult.telemetry!.edgesTotal, 1);
    assert.equal(alphaResult.telemetry!.edgesTotal, 1);
    // Both seeded mid-decay edges should have actually been decayed.
    assert.equal(defaultResult.telemetry!.edgesDecayed, 1);
    assert.equal(alphaResult.telemetry!.edgesDecayed, 1);
  });
});

// Suppress unused-import warning for `DAY_MS` when `node --test` strips it.
void DAY_MS;
