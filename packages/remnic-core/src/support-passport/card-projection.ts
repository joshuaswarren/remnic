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
  const parsed = value.split(",");
  if (parsed.length > 5 || parsed.some((id) => !SupportPassportMemoryIdSchema.safeParse(id).success)) return null;
  if (new Set(parsed).size !== parsed.length) return null;
  return parsed;
}

export function projectSupportPassportCard(memory: MemoryFile): StoredSupportPassportCard | null {
  const frontmatter = memory.frontmatter;
  const attributes = frontmatter.structuredAttributes;
  if (frontmatter.category !== "preference") return null;
  if (!frontmatter.tags?.includes(SUPPORT_PASSPORT_CARD_TAG)) return null;
  if (!attributes || frontmatter.blockedBy || frontmatter.archivedAt) return null;

  const category = SupportPassportCardCategorySchema.safeParse(attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.category]);
  const status = SupportPassportCardStatusSchema.safeParse(frontmatter.status);
  const order = Number(attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.order]);
  const sourceMemoryIds = parseSourceMemoryIds(attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.sourceMemoryIds] ?? "");
  if (!category.success || !status.success || !Number.isSafeInteger(order) || order < 0 || !sourceMemoryIds)
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
  const parsed = SupportPassportCardSchema.safeParse({
    ...fields,
    revision: computeSupportPassportCardRevision(fields),
  });
  if (!parsed.success) return null;
  return { card: parsed.data, memory, order, sourceMemoryIds };
}
