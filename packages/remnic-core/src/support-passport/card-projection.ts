import { stripAttributesSuffix } from "../structured-attributes.js";
import type { MemoryFile } from "../types.js";
import {
  type SupportPassportCard,
  SupportPassportCardCategorySchema,
  SupportPassportCardSchema,
  SupportPassportCardStatusSchema,
  SupportPassportMemoryIdSchema,
  computeSupportPassportCardRevision,
} from "./contracts.js";

export const SUPPORT_PASSPORT_CARD_TAG = "support-passport-card";
export const SUPPORT_PASSPORT_ATTRIBUTE_KEYS = Object.freeze({
  title: "support-passport-title",
  category: "support-passport-category",
  order: "support-passport-order",
  reviewBy: "support-passport-review-by",
  sourceMemoryIds: "support-passport-source-ids",
});

export interface StoredSupportPassportCard {
  card: SupportPassportCard;
  memory: MemoryFile;
  order: number;
  sourceMemoryIds: string[];
}

function parseSourceMemoryIds(value: string): string[] | null {
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

export function projectSupportPassportCard(memory: MemoryFile): StoredSupportPassportCard | null {
  const frontmatter = memory.frontmatter;
  const attributes = frontmatter.structuredAttributes;
  if (frontmatter.category !== "preference") return null;
  if (!frontmatter.tags?.includes(SUPPORT_PASSPORT_CARD_TAG)) return null;
  if (!attributes || frontmatter.blockedBy || frontmatter.archivedAt || frontmatter.supersededBy) return null;

  const category = SupportPassportCardCategorySchema.safeParse(attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.category]);
  const status = SupportPassportCardStatusSchema.safeParse(frontmatter.status);
  const rawOrder = attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.order] ?? "";
  const order = Number(rawOrder);
  const sourceMemoryIds = parseSourceMemoryIds(attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.sourceMemoryIds] ?? "");
  if (
    !category.success ||
    !status.success ||
    status.data === "superseded" ||
    !/^(?:0|[1-9]\d*)$/.test(rawOrder) ||
    !Number.isSafeInteger(order) ||
    !sourceMemoryIds
  )
    return null;

  const fields = {
    cardId: frontmatter.id,
    title: attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.title] ?? "",
    statement: stripAttributesSuffix(memory.content),
    category: category.data,
    status: status.data,
    updatedAt: frontmatter.updated,
    reviewBy: attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.reviewBy] ?? "",
  };
  const normalized = SupportPassportCardSchema.omit({ revision: true }).safeParse(fields);
  if (!normalized.success) return null;
  const parsed = SupportPassportCardSchema.safeParse({
    ...normalized.data,
    revision: computeSupportPassportCardRevision(normalized.data),
  });
  if (!parsed.success) return null;
  return { card: parsed.data, memory, order, sourceMemoryIds };
}
