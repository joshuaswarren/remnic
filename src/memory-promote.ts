import { createHash } from "node:crypto";
import type { Orchestrator } from "@remnic/core/orchestrator";
import { composeSalvagedEnvelope } from "@remnic/core/salvage-envelope";
import {
  STRUCTURED_ATTRIBUTE_LIMITS,
  TAG_LIMITS,
} from "@remnic/core/write-envelope";
import { stripAttributesSuffix } from "@remnic/core/storage";
import { displayErrorDetail } from "@remnic/core/runtime/better-sqlite";
import { isSafeRouteNamespace } from "@remnic/core/routing/engine";
import { indexMemoryAsync, indexesExistAsync } from "./temporal-index.js";
/**
 * `memory_promote` executor — copy a memory into another namespace
 * (extracted from tools.ts; issue #1989 PR4 file-size discipline).
 * Returns the user-facing result message.
 */

function buildPromotionOrigin(
  srcNamespace: string,
  memoryId: string,
): {
  tag: string;
  structuredAttributes: Record<string, string>;
} {
  const memoryIdHash = createHash("sha256").update(memoryId).digest("hex");
  const fullTag = `promotedFrom:${srcNamespace}:${memoryId}`;
  return {
    tag:
      fullTag.length <= TAG_LIMITS.maxTagLength
        ? fullTag
        : `promotedFromHash:${memoryIdHash}`,
    structuredAttributes: {
      promotedFromNamespace: srcNamespace,
      promotedFromMemoryIdHash: memoryIdHash,
      ...(memoryId.length <= STRUCTURED_ATTRIBUTE_LIMITS.maxValueLength
        ? { promotedFromMemoryId: memoryId }
        : {}),
    },
  };
}

export async function executeMemoryPromote(
  orchestrator: Orchestrator,
  params: {
    memoryId: string;
    fromNamespace?: string;
    toNamespace?: string;
    note?: string;
  },
): Promise<string> {
  const { memoryId, fromNamespace, toNamespace, note } = params;
  // Reject invalid input instead of reinterpreting it: a blank namespace or
  // non-string memory reference must not silently select a different target.
  // `null` is treated as absent because optional tool parameters historically
  // used it interchangeably with omission.
  if (typeof memoryId !== "string" || memoryId.length === 0) {
    return `Invalid memoryId: ${JSON.stringify(memoryId)} — expected a non-empty memory ID.`;
  }
  // Namespace validation reuses the SAME contract as core routing
  // (isSafeRouteNamespace), so every namespace core accepts is accepted here.
  for (const [name, value] of [
    ["fromNamespace", fromNamespace],
    ["toNamespace", toNamespace],
  ] as const) {
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== "string" || !isSafeRouteNamespace(value))
    ) {
      return `Invalid ${name}: ${JSON.stringify(value)} — expected a path-safe namespace name.`;
    }
  }
  const srcNs = fromNamespace ?? orchestrator.config.defaultNamespace;
  const dstNs = toNamespace ?? orchestrator.config.sharedNamespace;

  const src = await orchestrator.getStorage(srcNs);
  const mem = await src.getMemoryById(memoryId);
  if (!mem) {
    return `Memory not found in ${srcNs}: ${memoryId}`;
  }

  const dst = await orchestrator.getStorage(dstNs);
  const promotionOrigin = buildPromotionOrigin(srcNs, memoryId);

  // Sealed-envelope write (issue #1989 PR4): a promotion REPLAYS a stored
  // row — legacy data may predate current limits, so salvage.
  const promoteEnvelope = composeSalvagedEnvelope(
    "promote",
    {
      content: mem.frontmatter.structuredAttributes
        ? stripAttributesSuffix(mem.content)
        : mem.content,
      category: mem.frontmatter.category,
      confidence: mem.frontmatter.confidence,
      tags: (() => {
        const promotionTags = [
          "promoted",
          promotionOrigin.tag,
          ...(note ? [`note:${note}`] : []),
        ];
        const sourceTags = mem.frontmatter.tags ?? [];
        return Array.from(new Set([...promotionTags, ...sourceTags])).slice(
          0,
          TAG_LIMITS.maxTags,
        );
      })(),
      structuredAttributes: promotionOrigin.structuredAttributes,
      entityRef: mem.frontmatter.entityRef,
    },
    { source: "promote" },
  );
  const { id: newId, tombstoneBlocked } = await dst.writeSealedMemory(
    promoteEnvelope,
    {
      importance: mem.frontmatter.importance,
      supersedes: mem.frontmatter.supersedes,
      links: mem.frontmatter.links,
    },
  );

  // #1645 (review threads TWB/Yhu): if the destination namespace's tombstone
  // blocked this promotion, the copy landed pending_review (no active
  // promoted memory). Surface that honestly and SKIP query-aware indexing so
  // the blocked copy is not embedded as if it were active.
  if (tombstoneBlocked) {
    return `Promotion of ${srcNs}:${memoryId} → ${dstNs}:${newId} is queued for review (tombstone-blocked): no active promoted copy was created.`;
  }

  // Update temporal + tag indexes for the promoted copy (v8.1). Same guard
  // as memory_store: skip if indexes don't exist yet to avoid blocking the
  // full corpus bootstrap on the next extraction. Indexing is a SIDE
  // EFFECT: the promotion is durable already, so an index failure reports
  // instead of throwing — a thrown error here would read as a failed
  // promotion and invite a duplicating retry (#2022 review).
  try {
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
  } catch (err) {
    // displayErrorDetail strips absolute paths and stack noise before the
    // detail reaches a user-facing tool result (MCP/tool clients).
    return `Promoted ${srcNs}:${memoryId} → ${dstNs}:${newId} (index refresh failed — recall picks it up on the next maintenance pass: ${displayErrorDetail(err)})`;
  }

  return `Promoted ${srcNs}:${memoryId} → ${dstNs}:${newId}`;
}
