import type { LcmDag, SummaryNode } from "./dag.js";
import type { LcmArchive } from "./archive.js";
import { log } from "../logger.js";

export interface LcmRecallConfig {
  freshTailTurns: number;
  budgetChars: number;
}

/**
 * Assemble a compressed session history section from the summary DAG.
 *
 * Strategy:
 * 1. For the "fresh tail" (most recent N turns), use leaf-level summaries for maximum detail.
 * 2. For older portions, use the deepest available summary nodes (most compressed).
 * 3. Fill within budget, prioritizing recent content.
 */
export function assembleCompressedHistory(
  dag: LcmDag,
  archive: LcmArchive,
  sessionId: string,
  config: LcmRecallConfig,
): string {
  const maxTurn = archive.getMaxTurnIndex(sessionId);
  if (maxTurn < 0) return "";

  const allNodes = dag.getAllNodes(sessionId);
  if (allNodes.length === 0) return "";

  const freshTailStart = Math.max(0, maxTurn - config.freshTailTurns + 1);
  const sections: string[] = [];
  let usedChars = 0;

  // Collect nodes covering the "old" portion (before fresh tail)
  if (freshTailStart > 0) {
    const oldNodes = selectBestCoverage(allNodes, 0, freshTailStart - 1);
    for (const node of oldNodes) {
      const label = formatRangeLabel(node, maxTurn);
      const entry = `**${label}** (depth ${node.depth}):\n${node.summary_text}`;
      if (usedChars + entry.length > config.budgetChars) break;
      sections.push(entry);
      usedChars += entry.length;
    }
  }

  // Collect leaf nodes that overlap with the fresh tail region.
  // The old section uses deep nodes (depth > 0), so leaf nodes included here
  // won't duplicate old-section content. Use msg_end >= freshTailStart to
  // include straddling leaf nodes that partially cover the fresh region.
  const freshNodes = allNodes
    .filter(
      (n) => n.depth === 0 && n.msg_end >= freshTailStart && n.msg_end <= maxTurn,
    )
    .sort((a, b) => a.msg_start - b.msg_start);

  for (const node of freshNodes) {
    const label = `Recent (turns ${node.msg_start}-${node.msg_end})`;
    const entry = `**${label}**:\n${node.summary_text}`;
    if (usedChars + entry.length > config.budgetChars) break;
    sections.push(entry);
    usedChars += entry.length;
  }

  if (sections.length === 0) return "";

  return `## Session History (Compressed)\n\n${sections.join("\n\n")}`;
}

/**
 * Select the best coverage for a turn range.
 * Prefers deeper (more compressed) nodes. Avoids overlapping coverage.
 */
function selectBestCoverage(
  allNodes: SummaryNode[],
  fromTurn: number,
  toTurn: number,
): SummaryNode[] {
  // Filter to nodes fully contained in the requested range. Straddling nodes
  // would duplicate protected fresh-tail turns while still emitting their full
  // summary text and range label.
  const candidates = allNodes.filter(
    (n) => n.msg_start >= fromTurn && n.msg_end <= toTurn,
  );

  if (candidates.length === 0) return [];

  // Sort by msg_start ascending, then depth descending (prefer deeper at same position)
  candidates.sort((a, b) => {
    if (a.msg_start !== b.msg_start) return a.msg_start - b.msg_start;
    return b.depth - a.depth;
  });

  // Greedily select non-overlapping nodes, preferring deeper coverage.
  const selected: SummaryNode[] = [];
  let coveredUpTo = fromTurn - 1;

  for (const node of candidates) {
    if (node.msg_start > coveredUpTo) {
      selected.push(node);
      coveredUpTo = node.msg_end;
      if (coveredUpTo >= toTurn) break;
    }
  }

  // Re-sort selected by msg_start for chronological output
  selected.sort((a, b) => a.msg_start - b.msg_start);
  return selected;
}

function formatRangeLabel(node: SummaryNode, maxTurn: number): string {
  const startPct = Math.round((node.msg_start / Math.max(1, maxTurn)) * 100);
  const endPct = Math.round((node.msg_end / Math.max(1, maxTurn)) * 100);

  if (startPct < 33) return `Early session (turns ${node.msg_start}-${node.msg_end})`;
  if (endPct < 66) return `Mid session (turns ${node.msg_start}-${node.msg_end})`;
  return `Later session (turns ${node.msg_start}-${node.msg_end})`;
}
