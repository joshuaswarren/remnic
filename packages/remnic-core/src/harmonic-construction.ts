import { createHash } from "node:crypto";
import {
  type AbstractionNode,
  HARMONIC_SOURCE_MEMORY_INSERTED_AT_KEY,
  upsertAbstractionNodes,
} from "./abstraction-nodes.js";
import { type CueAnchor, type CueAnchorType, upsertCueAnchors } from "./cue-anchors.js";
import { compareDeterministicStrings } from "./deterministic-order.js";
import { normalizeRecallTokens } from "./recall-tokenization.js";

export interface HarmonicCueAnchorInput {
  type: CueAnchorType;
  value: string;
}

export interface HarmonicConstructionInput {
  sessionKey: string;
  recordedAt: string;
  episodeTitle?: string | null;
  persistedFacts: Array<{
    memoryId: string;
    content: string;
    category: string;
    tags: string[];
    insertedAt?: string;
    entityRef?: string | null;
    cueAnchors?: HarmonicCueAnchorInput[] | null;
    validAt?: string | null;
  }>;
  entityMentions: Array<{
    name: string;
    type: string;
    facts?: string[];
  }>;
}

const CUE_ANCHOR_TYPES: Record<CueAnchorType, true> = {
  entity: true,
  file: true,
  tool: true,
  outcome: true,
  constraint: true,
  date: true,
};
function hashId(prefix: string, value: string): string {
  return `${prefix}${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareDeterministicStrings);
}

export function harmonicEntitySegment(name: string): string {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const start = normalized.startsWith("-") ? 1 : 0;
  const end = normalized.endsWith("-") ? normalized.length - 1 : normalized.length;
  const segment = normalized.slice(start, end);
  return segment || hashId("entity-", name).slice(0, 23);
}

export function normalizedHarmonicEntityIdentity(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}
export function harmonicEntityReferenceMatches(
  entityRef: string,
  entityName: string,
  allowSegmentFallback: boolean
): boolean {
  if (normalizedHarmonicEntityIdentity(entityRef) === normalizedHarmonicEntityIdentity(entityName)) {
    return true;
  }
  return allowSegmentFallback && harmonicEntitySegment(entityRef) === harmonicEntitySegment(entityName);
}

export function normalizeCueAnchorInputs(value: unknown, maxAnchors = 3): HarmonicCueAnchorInput[] {
  if (!Array.isArray(value) || maxAnchors <= 0) return [];
  const byIdentity = new Map<string, HarmonicCueAnchorInput>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    if (typeof record.type !== "string" || !Object.hasOwn(CUE_ANCHOR_TYPES, record.type)) {
      continue;
    }
    if (typeof record.value !== "string") continue;
    const anchorValue = record.value.trim();
    if (anchorValue.length === 0 || anchorValue.length > 120) continue;
    const type = record.type as CueAnchorType;
    const normalizedCue = normalizeRecallTokens(anchorValue).join(" ");
    if (normalizedCue.length === 0) continue;
    const identity = `${type}:${normalizedCue}`;
    const existing = byIdentity.get(identity);
    if (!existing || compareDeterministicStrings(anchorValue, existing.value) < 0) {
      byIdentity.set(identity, { type, value: anchorValue });
    }
  }
  return [...byIdentity.entries()]
    .sort(([left], [right]) => compareDeterministicStrings(left, right))
    .slice(0, maxAnchors)
    .map(([, anchor]) => anchor);
}

function validAtDate(validAt: string | null | undefined): string | undefined {
  if (typeof validAt !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(validAt);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    !Number.isFinite(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return match[0];
}

function sourceMemoryInsertedAtMetadata(
  facts: Array<{ memoryId: string; insertedAt: string }>
): Record<string, string> {
  const insertedAtById = Object.fromEntries(
    facts
      .map((fact) => [fact.memoryId, fact.insertedAt] as const)
      .sort(([left], [right]) => compareDeterministicStrings(left, right))
  );
  return {
    [HARMONIC_SOURCE_MEMORY_INSERTED_AT_KEY]: JSON.stringify(insertedAtById),
  };
}

export function deriveHarmonicRecords(input: HarmonicConstructionInput): {
  nodes: AbstractionNode[];
  anchors: CueAnchor[];
} {
  const persistedFacts = input.persistedFacts
    .map((fact) => ({
      ...fact,
      memoryId: fact.memoryId.trim(),
      content: fact.content.trim(),
      insertedAt:
        fact.insertedAt && Number.isFinite(Date.parse(fact.insertedAt))
          ? new Date(fact.insertedAt).toISOString()
          : input.recordedAt,
      tags: sortedUnique(fact.tags.map((tag) => tag.trim()).filter(Boolean)),
      entityRef: fact.entityRef?.trim() || undefined,
      cueAnchors: normalizeCueAnchorInputs(fact.cueAnchors),
    }))
    .filter((fact) => fact.memoryId.length > 0 && fact.content.length > 0)
    .sort(
      (left, right) =>
        compareDeterministicStrings(left.memoryId, right.memoryId) ||
        compareDeterministicStrings(left.content, right.content)
    );

  if (persistedFacts.length === 0) return { nodes: [], anchors: [] };

  const sourceMemoryIds = sortedUnique(persistedFacts.map((fact) => fact.memoryId));
  const episodeNodeId = hashId("ep-", `${input.sessionKey}|${input.recordedAt}|${sourceMemoryIds.join("|")}`);
  const episodeTitle = input.episodeTitle?.trim() || persistedFacts[0]?.content || "Memory episode";
  const episodeNode: AbstractionNode = {
    schemaVersion: 1,
    nodeId: episodeNodeId,
    recordedAt: input.recordedAt,
    sessionKey: input.sessionKey,
    kind: "episode",
    abstractionLevel: "micro",
    title: truncate(episodeTitle, 80),
    summary: truncate(
      persistedFacts
        .slice(0, 3)
        .map((fact) => fact.content)
        .join("; "),
      400
    ),
    sourceMemoryIds,
    entityRefs: sortedUnique(persistedFacts.flatMap((fact) => (fact.entityRef ? [fact.entityRef] : []))),
    tags: sortedUnique(persistedFacts.flatMap((fact) => fact.tags)),
    metadata: sourceMemoryInsertedAtMetadata(persistedFacts),
  };

  const mentionGroups = new Map<string, { names: string[]; types: string[]; facts: string[]; segment: string }>();
  for (const mention of input.entityMentions) {
    const name = mention.name.trim();
    if (name.length === 0) continue;
    const identity = normalizedHarmonicEntityIdentity(name);
    const group = mentionGroups.get(identity) ?? {
      names: [],
      types: [],
      facts: [],
      segment: harmonicEntitySegment(name),
    };
    group.names.push(name);
    group.types.push(mention.type.trim().toLowerCase());
    group.facts.push(...(mention.facts ?? []).map((fact) => fact.trim()).filter(Boolean));
    mentionGroups.set(identity, group);
  }
  const groupsPerSegment = new Map<string, number>();
  for (const group of mentionGroups.values()) {
    groupsPerSegment.set(group.segment, (groupsPerSegment.get(group.segment) ?? 0) + 1);
  }

  const topicEntries = [...mentionGroups.entries()]
    .sort(([left], [right]) => compareDeterministicStrings(left, right))
    .flatMap(([identity, group]) => {
      const matchingFacts = persistedFacts.filter((fact) => {
        if (!fact.entityRef) return false;
        return harmonicEntityReferenceMatches(
          fact.entityRef,
          sortedUnique(group.names)[0] ?? identity,
          groupsPerSegment.get(group.segment) === 1
        );
      });
      const nodeSegment = `${group.segment}-${hashId("", identity)}`;
      const mentionSummary = sortedUnique(group.facts).join("; ");
      const node: AbstractionNode = {
        schemaVersion: 1,
        nodeId: `topic-${nodeSegment}`,
        recordedAt: input.recordedAt,
        sessionKey: input.sessionKey,
        kind: group.types.includes("project") ? "project" : "topic",
        abstractionLevel: "meso",
        title: sortedUnique(group.names)[0] ?? group.segment,
        summary: truncate(
          mentionSummary ||
            matchingFacts
              .slice(0, 3)
              .map((fact) => fact.content)
              .join("; ") ||
            sortedUnique(group.names)[0] ||
            group.segment,
          400
        ),
        sourceMemoryIds: sortedUnique(matchingFacts.map((fact) => fact.memoryId)),
        entityRefs: sortedUnique(group.names),
        tags: sortedUnique(matchingFacts.flatMap((fact) => fact.tags)),
        metadata: sourceMemoryInsertedAtMetadata(matchingFacts),
      };
      return [{ identity, segment: group.segment, node }];
    });
  const topicNodes = topicEntries.map((entry) => entry.node);
  const topicNodeIdByIdentity = new Map(topicEntries.map((entry) => [entry.identity, entry.node.nodeId]));
  const topicEntriesBySegment = new Map<string, typeof topicEntries>();
  for (const entry of topicEntries) {
    const entries = topicEntriesBySegment.get(entry.segment) ?? [];
    entries.push(entry);
    topicEntriesBySegment.set(entry.segment, entries);
  }
  const topicNodeIdForEntityRef = (entityRef: string): string | undefined => {
    const exact = topicNodeIdByIdentity.get(normalizedHarmonicEntityIdentity(entityRef));
    if (exact) return exact;
    const segmentEntries = topicEntriesBySegment.get(harmonicEntitySegment(entityRef));
    return segmentEntries?.length === 1 ? segmentEntries[0]?.node.nodeId : undefined;
  };
  const anchorsById = new Map<string, CueAnchor>();
  for (const fact of persistedFacts) {
    const deterministicAnchors: HarmonicCueAnchorInput[] = [];
    if (fact.entityRef) {
      deterministicAnchors.push({ type: "entity", value: fact.entityRef });
    }
    const date = validAtDate(fact.validAt);
    if (date) deterministicAnchors.push({ type: "date", value: date });

    for (const anchorInput of [...fact.cueAnchors, ...deterministicAnchors]) {
      const normalizedCue = normalizeRecallTokens(anchorInput.value).join(" ");
      if (normalizedCue.length === 0) continue;
      const anchorId = hashId("cue-", `${anchorInput.type}:${normalizedCue}`);
      const topicNodeId = fact.entityRef ? topicNodeIdForEntityRef(fact.entityRef) : undefined;
      const nodeRefs = sortedUnique(topicNodeId ? [episodeNodeId, topicNodeId] : [episodeNodeId]);
      const existing = anchorsById.get(anchorId);
      const mergedNodeRefs = sortedUnique([...(existing?.nodeRefs ?? []), ...nodeRefs]);
      const sourceMemoryIdsByNodeRef = Object.fromEntries(
        mergedNodeRefs.map((nodeRef) => [
          nodeRef,
          sortedUnique([
            ...(existing?.sourceMemoryIdsByNodeRef?.[nodeRef] ?? []),
            ...(nodeRefs.includes(nodeRef) ? [fact.memoryId] : []),
          ]),
        ])
      );
      anchorsById.set(anchorId, {
        schemaVersion: 1,
        anchorId,
        anchorType: anchorInput.type,
        anchorValue:
          existing && compareDeterministicStrings(existing.anchorValue, anchorInput.value) < 0
            ? existing.anchorValue
            : anchorInput.value,
        normalizedCue,
        recordedAt: input.recordedAt,
        sessionKey: input.sessionKey,
        nodeRefs: mergedNodeRefs,
        sourceMemoryIdsByNodeRef,
        tags: sortedUnique([...(existing?.tags ?? []), ...fact.tags]),
      });
    }
  }

  return {
    nodes: [episodeNode, ...topicNodes]
      .map((node) => ({
        ...node,
        sourceMemoryIds: sortedUnique(node.sourceMemoryIds ?? []),
        entityRefs: sortedUnique(node.entityRefs ?? []),
        tags: sortedUnique(node.tags ?? []),
      }))
      .sort((left, right) => compareDeterministicStrings(left.nodeId, right.nodeId)),
    anchors: [...anchorsById.values()]
      .map((anchor) => ({
        ...anchor,
        nodeRefs: sortedUnique(anchor.nodeRefs),
        tags: sortedUnique(anchor.tags ?? []),
      }))
      .sort((left, right) => compareDeterministicStrings(left.anchorId, right.anchorId)),
  };
}

export async function persistHarmonicRecords(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  nodes: AbstractionNode[];
  anchors: CueAnchor[];
}): Promise<void> {
  if (options.nodes.length > 0) {
    await upsertAbstractionNodes({
      memoryDir: options.memoryDir,
      abstractionNodeStoreDir: options.abstractionNodeStoreDir,
      nodes: options.nodes,
    });
  }
  if (options.anchors.length > 0) {
    await upsertCueAnchors({
      memoryDir: options.memoryDir,
      abstractionNodeStoreDir: options.abstractionNodeStoreDir,
      anchors: options.anchors,
    });
  }
}
