import path from "node:path";
import { readFile } from "node:fs/promises";
import type { GraphEdge, GraphType } from "./graph.js";
import { graphEdgeKey } from "./graph-dashboard-key.js";

export interface GraphSnapshotNode {
  id: string;
}

export interface GraphSnapshotStats {
  nodes: number;
  edges: number;
  malformedLines: number;
  filesMissing: GraphType[];
}

export interface GraphSnapshot {
  generatedAt: string;
  nodes: GraphSnapshotNode[];
  edges: GraphEdge[];
  stats: GraphSnapshotStats;
}

const GRAPH_TYPES: GraphType[] = ["entity", "time", "causal"];

function graphFile(memoryDir: string, type: GraphType): string {
  return path.join(memoryDir, "state", "graphs", `${type}.jsonl`);
}

function isGraphEdge(raw: unknown, expectedType: GraphType): raw is GraphEdge {
  if (!raw || typeof raw !== "object") return false;
  const edge = raw as Record<string, unknown>;
  return (
    edge.type === expectedType &&
    typeof edge.from === "string" &&
    edge.from.length > 0 &&
    typeof edge.to === "string" &&
    edge.to.length > 0 &&
    typeof edge.weight === "number" &&
    Number.isFinite(edge.weight) &&
    typeof edge.label === "string" &&
    typeof edge.ts === "string"
  );
}

export async function graphSnapshotFromMemoryDir(memoryDir: string): Promise<GraphSnapshot> {
  const nodes = new Set<string>();
  const edges: GraphEdge[] = [];
  const filesMissing: GraphType[] = [];
  let malformedLines = 0;
  const seenEdges = new Set<string>();

  for (const type of GRAPH_TYPES) {
    const filePath = graphFile(memoryDir, type);
    let raw = "";
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
      filesMissing.push(type);
      continue;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        malformedLines += 1;
        continue;
      }
      if (!isGraphEdge(parsed, type)) {
        malformedLines += 1;
        continue;
      }
      const key = graphEdgeKey(parsed);
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push(parsed);
      nodes.add(parsed.from);
      nodes.add(parsed.to);
    }
  }

  const sortedEdges = edges.sort((a, b) =>
    a.type.localeCompare(b.type) ||
    a.from.localeCompare(b.from) ||
    a.to.localeCompare(b.to) ||
    a.ts.localeCompare(b.ts)
  );
  const sortedNodes = [...nodes].sort((a, b) => a.localeCompare(b)).map((id) => ({ id }));

  return {
    generatedAt: new Date().toISOString(),
    nodes: sortedNodes,
    edges: sortedEdges,
    stats: {
      nodes: sortedNodes.length,
      edges: sortedEdges.length,
      malformedLines,
      filesMissing,
    },
  };
}
