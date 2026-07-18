import type { Orchestrator } from "@remnic/core/orchestrator";
import { composeSalvagedEnvelope } from "@remnic/core/salvage-envelope";
import { indexMemoryAsync, indexesExistAsync } from "./temporal-index.js";

/**
 * `memory_promote` executor — copy a memory into another namespace
 * (extracted from tools.ts; issue #1989 PR4 file-size discipline).
 * Returns the user-facing result message.
 */
export async function executeMemoryPromote(
  orchestrator: Orchestrator,
  params: { memoryId: string; fromNamespace?: string; toNamespace?: string; note?: string },
): Promise<string> {
  const { memoryId, fromNamespace, toNamespace, note } = params;
  const srcNs =
    fromNamespace && fromNamespace.length > 0 ? fromNamespace : orchestrator.config.defaultNamespace;
  const dstNs =
    toNamespace && toNamespace.length > 0 ? toNamespace : orchestrator.config.sharedNamespace;

  const src = await orchestrator.getStorage(srcNs);
  const mem = await src.getMemoryById(memoryId);
  if (!mem) {
    return `Memory not found in ${srcNs}: ${memoryId}`;
  }

  const dst = await orchestrator.getStorage(dstNs);
  // Sealed-envelope write (issue #1989 PR4): a promotion REPLAYS a stored
  // row — legacy data may predate current limits, so salvage.
  const promoteEnvelope = composeSalvagedEnvelope(
    "promote",
    {
      content: mem.content,
      category: mem.frontmatter.category,
      confidence: mem.frontmatter.confidence,
      tags: Array.from(
        new Set([
          ...(mem.frontmatter.tags ?? []),
          "promoted",
          `promotedFrom:${srcNs}:${memoryId}`,
          ...(note ? [`note:${note}`] : []),
        ]),
      ),
      entityRef: mem.frontmatter.entityRef,
    },
    { source: "promote" },
  );
  const { id: newId, tombstoneBlocked } = await dst.writeSealedMemory(promoteEnvelope, {
    importance: mem.frontmatter.importance,
    supersedes: mem.frontmatter.supersedes,
    links: mem.frontmatter.links,
  });

  // #1645 (review threads TWB/Yhu): if the destination namespace's tombstone
  // blocked this promotion, the copy landed pending_review (no active
  // promoted memory). Surface that honestly and SKIP query-aware indexing so
  // the blocked copy is not embedded as if it were active.
  if (tombstoneBlocked) {
    return `Promotion of ${srcNs}:${memoryId} → ${dstNs}:${newId} is queued for review (tombstone-blocked): no active promoted copy was created.`;
  }

  // Update temporal + tag indexes for the promoted copy (v8.1). Same guard
  // as memory_store: skip if indexes don't exist yet to avoid blocking the
  // full corpus bootstrap on the next extraction.
  if (
    orchestrator.config.queryAwareIndexingEnabled &&
    (await indexesExistAsync(orchestrator.config.memoryDir))
  ) {
    const promoted = await dst.getMemoryById(newId).catch(() => null);
    if (promoted?.path && promoted.frontmatter?.created) {
      await indexMemoryAsync(
        orchestrator.config.memoryDir,
        promoted.path,
        promoted.frontmatter.created,
        promoted.frontmatter.tags ?? [],
      );
    }
  }

  return `Promoted ${srcNs}:${memoryId} → ${dstNs}:${newId}`;
}
