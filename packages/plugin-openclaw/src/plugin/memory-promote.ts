import { createHash } from "node:crypto";
import type { Orchestrator } from "@remnic/core/orchestrator";
import { composeSalvagedEnvelope } from "@remnic/core/salvage-envelope";
import {
  STRUCTURED_ATTRIBUTE_LIMITS,
  TAG_LIMITS,
} from "@remnic/core/write-envelope";
import { stripAttributesSuffix } from "@remnic/core/storage";
import { isSupportPassportPrivateMemory } from "@remnic/core/support-passport";
import { displayErrorDetail } from "@remnic/core/runtime/better-sqlite";
import { isSafeRouteNamespace } from "@remnic/core/routing/engine";
import { indexMemoryAsync, indexesExistAsync } from "@remnic/core/temporal-index";

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
  if (typeof memoryId !== "string" || memoryId.length === 0) {
    return `Invalid memoryId: ${JSON.stringify(memoryId)} — expected a non-empty memory ID.`;
  }
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
  if (!mem || isSupportPassportPrivateMemory(mem)) {
    return `Memory not found in ${srcNs}: ${memoryId}`;
  }

  const dst = await orchestrator.getStorage(dstNs);
  const promotionOrigin = buildPromotionOrigin(srcNs, memoryId);

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

  if (tombstoneBlocked) {
    return `Promotion of ${srcNs}:${memoryId} → ${dstNs}:${newId} is queued for review (tombstone-blocked): no active promoted copy was created.`;
  }

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
    return `Promoted ${srcNs}:${memoryId} → ${dstNs}:${newId} (index refresh failed — recall picks it up on the next maintenance pass: ${displayErrorDetail(err)})`;
  }

  return `Promoted ${srcNs}:${memoryId} → ${dstNs}:${newId}`;
}
