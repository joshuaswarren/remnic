import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";

import type { OfflineSyncExcludeFile } from "../offline-sync-file-io.js";
import { stripAttributesSuffix } from "../structured-attributes.js";
import type { MemoryFile } from "../types.js";
import {
  type SupportPassportCard,
  SupportPassportCardCategorySchema,
  SupportPassportCardSchema,
  SupportPassportCardStatusSchema,
  SupportPassportMemoryIdSchema,
  SupportPassportNamespaceSchema,
  computeSupportPassportCardRevision,
} from "./contracts.js";

export const SUPPORT_PASSPORT_CARD_TAG = "support-passport-card";
export const SUPPORT_PASSPORT_AUDIT_TAG = "support-passport-audit";

export function isSupportPassportPrivateMemory(memory: {
  frontmatter: {
    tags?: readonly string[];
    structuredAttributes?: Readonly<Record<string, string>>;
  };
}): boolean {
  const tags = memory.frontmatter.tags;
  if (tags?.includes(SUPPORT_PASSPORT_CARD_TAG) === true || tags?.includes(SUPPORT_PASSPORT_AUDIT_TAG) === true) {
    return true;
  }
  return Object.keys(memory.frontmatter.structuredAttributes ?? {})
    .some((key) => key.startsWith("support-passport-"));
}

export function excludeSupportPassportPrivateMemories<T extends Pick<MemoryFile, "frontmatter">>(
  memories: readonly T[]
): T[] {
  return memories.filter((memory) => !isSupportPassportPrivateMemory(memory));
}

export function createSupportPassportPrivateFileExclusion(storage: {
  readMemoryByPath(filePath: string): Promise<MemoryFile | null>;
}): OfflineSyncExcludeFile {
  const classifications = new Map<string, { identity: string; excluded: Promise<boolean> }>();
  return async ({ filePath }) => {
    let file: Awaited<ReturnType<typeof lstat>>;
    try {
      file = await lstat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        classifications.delete(filePath);
        return false;
      }
      throw error;
    }
    const identity = `${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}:${file.ctimeMs}`;
    const cached = classifications.get(filePath);
    if (cached?.identity === identity) return await cached.excluded;
    const excluded = storage
      .readMemoryByPath(filePath)
      .then((memory) => (memory ? isSupportPassportPrivateMemory(memory) : false));
    classifications.set(filePath, { identity, excluded });
    try {
      return await excluded;
    } catch (error) {
      if (classifications.get(filePath)?.excluded === excluded) classifications.delete(filePath);
      throw error;
    }
  };
}

export const SUPPORT_PASSPORT_ATTRIBUTE_KEYS = Object.freeze({
  namespace: "support-passport-namespace",
  namespaceEncoding: "support-passport-namespace-encoding",
  owner: "support-passport-owner",
  title: "support-passport-title",
  category: "support-passport-category",
  order: "support-passport-order",
  reviewBy: "support-passport-review-by",
  sourceMemoryIds: "support-passport-source-ids",
  replacesDraftId: "support-passport-replaces-draft-id",
  replacedRevision: "support-passport-replaced-revision",
  draftReplacementPrepared: "support-passport-draft-replacement-prepared",
  replacementComplete: "support-passport-replacement-complete",
  generatedBatchId: "support-passport-generated-batch-id",
  generatedBatchSize: "support-passport-generated-batch-size",
});

const SUPPORT_PASSPORT_NAMESPACE_ENCODING = "base64url-v1";
const SUPPORT_PASSPORT_NAMESPACE_CHUNK_PREFIX = "support-passport-namespace-";
const SUPPORT_PASSPORT_NAMESPACE_CHUNK_SIZE = 1_024;
const LegacySupportPassportNamespaceSchema = SupportPassportNamespaceSchema.refine(
  (namespace) =>
    !namespace.includes("/") &&
    !namespace.includes("\\") &&
    !namespace.includes("..") &&
    !namespace.includes("]") &&
    !namespace.includes("\0") &&
    !namespace.includes("\n") &&
    !namespace.includes("\r")
);

export function encodeSupportPassportNamespaceAttributes(namespace: string): Record<string, string> {
  const canonical = SupportPassportNamespaceSchema.parse(namespace);
  const encoded = Buffer.from(canonical, "utf8").toString("base64url");
  const chunks = encoded.match(new RegExp(`.{1,${SUPPORT_PASSPORT_NAMESPACE_CHUNK_SIZE}}`, "g")) ?? [];
  const digest = createHash("sha256").update(encoded).digest("hex");
  return Object.fromEntries([
    [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.namespace, chunks[0] ?? ""],
    [
      SUPPORT_PASSPORT_ATTRIBUTE_KEYS.namespaceEncoding,
      `${SUPPORT_PASSPORT_NAMESPACE_ENCODING}:${chunks.length}:${digest}`,
    ],
    ...chunks.slice(1).map((chunk, index) => [`${SUPPORT_PASSPORT_NAMESPACE_CHUNK_PREFIX}${index + 1}`, chunk]),
  ]);
}

export function decodeSupportPassportNamespaceAttributes(attributes: Readonly<Record<string, string>>): string | null {
  const firstChunk = attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.namespace];
  const encoding = attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.namespaceEncoding];
  if (encoding === undefined) {
    const legacy = LegacySupportPassportNamespaceSchema.safeParse(firstChunk);
    return legacy.success ? legacy.data : null;
  }
  const match = /^base64url-v1:([1-9]\d*):([a-f0-9]{64})$/.exec(encoding);
  if (!match || typeof firstChunk !== "string") return null;
  const chunkCount = Number(match[1]);
  if (!Number.isSafeInteger(chunkCount)) return null;
  const chunkIndexes = Object.keys(attributes).flatMap((key) => {
    const chunkMatch = /^support-passport-namespace-(\d+)$/.exec(key);
    return chunkMatch ? [Number(chunkMatch[1])] : [];
  });
  if (
    chunkIndexes.length !== chunkCount - 1 ||
    chunkIndexes.some((index) => !Number.isSafeInteger(index) || index < 1 || index >= chunkCount)
  )
    return null;
  const chunks = [firstChunk];
  for (let index = 1; index < chunkCount; index += 1) {
    const chunk = attributes[`${SUPPORT_PASSPORT_NAMESPACE_CHUNK_PREFIX}${index}`];
    if (typeof chunk !== "string" || chunk.length === 0) return null;
    chunks.push(chunk);
  }
  const encoded = chunks.join("");
  if (createHash("sha256").update(encoded).digest("hex") !== match[2]) return null;
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64url") !== encoded) return null;
  const namespace = SupportPassportNamespaceSchema.safeParse(decoded);
  return namespace.success ? namespace.data : null;
}

export interface StoredSupportPassportCard {
  card: SupportPassportCard;
  memory: MemoryFile;
  order: number;
  sourceMemoryIds: string[];
  namespace: string;
  owner: string;
  replacesDraftId?: string;
  replacedRevision?: string;
  draftReplacementPrepared: boolean;
  generatedBatchId?: string;
  generatedBatchSize?: number;
}

export function computeSupportPassportOwnerKey(principal: string): string {
  return createHash("sha256").update(principal).digest("hex");
}

export function activeSupportPassportReplacementPredecessorIds(
  cards: readonly StoredSupportPassportCard[],
): Set<string> {
  return new Set(
    cards
      .filter((item) => item.card.status === "active")
      .map((item) => item.memory.frontmatter.supersedes)
      .filter((cardId): cardId is string => typeof cardId === "string"),
  );
}

function parseSourceMemoryIds(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  if (value === "") return [];
  const rawIds = value.split(",");
  if (rawIds.length > 5) return null;
  const normalized: string[] = [];
  for (const rawId of rawIds) {
    const parsed = SupportPassportMemoryIdSchema.safeParse(rawId);
    if (!parsed.success) return null;
    normalized.push(parsed.data);
  }
  if (new Set(normalized).size !== normalized.length) return null;
  return normalized;
}

interface SupportPassportCardMetadata {
  fields: Omit<SupportPassportCard, "revision" | "statement">;
  order: number;
  sourceMemoryIds: string[];
  namespace: string;
  owner: string;
  replacesDraftId?: string;
  replacedRevision?: string;
  draftReplacementPrepared: boolean;
  generatedBatchId?: string;
  generatedBatchSize?: number;
}

function parseSupportPassportCardMetadata(
  memory: Pick<MemoryFile, "frontmatter">,
): SupportPassportCardMetadata | null {
  const frontmatter = memory.frontmatter;
  const attributes = frontmatter.structuredAttributes;
  if (frontmatter.category !== "preference") return null;
  if (!frontmatter.tags?.includes(SUPPORT_PASSPORT_CARD_TAG)) return null;
  if (
    !attributes ||
    frontmatter.blockedBy ||
    frontmatter.archivedAt ||
    frontmatter.supersededBy
  )
    return null;

  const category = SupportPassportCardCategorySchema.safeParse(
    attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.category],
  );
  const status = SupportPassportCardStatusSchema.safeParse(frontmatter.status);
  const rawOrder = attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.order];
  const order = Number(rawOrder);
  const sourceMemoryIds = parseSourceMemoryIds(
    attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.sourceMemoryIds],
  );
  const namespace = decodeSupportPassportNamespaceAttributes(attributes);
  const owner = attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.owner];
  let replacesDraftId: string | undefined;
  const rawReplacesDraftId =
    attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.replacesDraftId];
  if (rawReplacesDraftId !== undefined) {
    const parsedReplacesDraftId =
      SupportPassportMemoryIdSchema.safeParse(rawReplacesDraftId);
    if (!parsedReplacesDraftId.success) return null;
    replacesDraftId = parsedReplacesDraftId.data;
  }
  let replacedRevision: string | undefined;
  const rawReplacedRevision =
    attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.replacedRevision];
  if (rawReplacedRevision !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(rawReplacedRevision)) return null;
    replacedRevision = rawReplacedRevision;
  }
  const generatedBatchId = attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.generatedBatchId];
  const rawGeneratedBatchSize = attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.generatedBatchSize];
  let generatedBatchSize: number | undefined;
  if (generatedBatchId !== undefined) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(generatedBatchId)) {
      return null;
    }
    if (
      typeof rawGeneratedBatchSize !== "string" ||
      !/^[1-8]$/.test(rawGeneratedBatchSize)
    ) {
      return null;
    }
    generatedBatchSize = Number(rawGeneratedBatchSize);
  } else if (rawGeneratedBatchSize !== undefined) {
    return null;
  }
  if (
    !category.success ||
    !status.success ||
    status.data === "superseded" ||
    typeof rawOrder !== "string" ||
    !/^(?:0|[1-9]\d*)$/.test(rawOrder) ||
    !Number.isSafeInteger(order) ||
    namespace === null ||
    typeof owner !== "string" ||
    !/^[a-f0-9]{64}$/.test(owner) ||
    !sourceMemoryIds
  )
    return null;
  const fields = SupportPassportCardSchema.omit({
    revision: true,
    statement: true,
  }).safeParse({
    cardId: frontmatter.id,
    title: attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.title],
    category: category.data,
    status: status.data,
    updatedAt: frontmatter.updated,
    reviewBy: attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.reviewBy],
  });
  if (!fields.success) return null;
  return {
    fields: fields.data,
    order,
    sourceMemoryIds,
    namespace,
    owner,
    replacesDraftId,
    replacedRevision,
    draftReplacementPrepared:
      attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.draftReplacementPrepared] ===
      "true",
    generatedBatchId,
    generatedBatchSize,
  };
}

export function hasLiveSupportPassportCard(memory: Pick<MemoryFile, "frontmatter" | "content">): boolean {
  const metadata = parseSupportPassportCardMetadata(memory);
  if (metadata?.fields.status !== "active" && metadata?.fields.status !== "pending_review") return false;
  return SupportPassportCardSchema.omit({ revision: true }).safeParse({
    ...metadata.fields,
    statement: stripAttributesSuffix(memory.content),
  }).success;
}

export function projectSupportPassportCard(
  memory: MemoryFile,
): StoredSupportPassportCard | null {
  const metadata = parseSupportPassportCardMetadata(memory);
  if (!metadata) return null;

  const fields = {
    ...metadata.fields,
    statement: stripAttributesSuffix(memory.content),
  };
  const normalized = SupportPassportCardSchema.omit({
    revision: true,
  }).safeParse(fields);
  if (!normalized.success) return null;
  const parsed = SupportPassportCardSchema.safeParse({
    ...normalized.data,
    revision: computeSupportPassportCardRevision(normalized.data),
  });
  if (!parsed.success) return null;
  return {
    card: parsed.data,
    memory,
    order: metadata.order,
    sourceMemoryIds: metadata.sourceMemoryIds,
    namespace: metadata.namespace,
    owner: metadata.owner,
    replacesDraftId: metadata.replacesDraftId,
    replacedRevision: metadata.replacedRevision,
    draftReplacementPrepared: metadata.draftReplacementPrepared,
    generatedBatchId: metadata.generatedBatchId,
    generatedBatchSize: metadata.generatedBatchSize,
  };
}
